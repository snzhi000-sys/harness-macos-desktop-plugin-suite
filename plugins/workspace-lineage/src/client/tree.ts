/**
 * Derives the workspace browser tree from Host Workspace order and membership.
 * Unassigned Sessions trail under Ungrouped; only the selected blank Session
 * remains visible.
 */
import {
  indexSubagentDescendants, type PendingInteractionStatus, type SessionId, type SessionListState,
  type SessionSearchResultItem, type SessionSummary, type SubagentDescendantSummary,
  type WorkspaceId, type WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Group key for Sessions outside every Workspace. */
export const UNGROUPED_KEY = ''

/** Display label for the ungrouped bucket row. */
export const UNGROUPED_LABEL = 'Ungrouped'

/** One top-level session row in a group or the flat list. */
export interface SessionNode {
  id: SessionId
  /** Stored display title; the renderer substitutes the localized New Session label for blank rows. */
  title: string
  /** The provisional blank session (renderer shows the localized New Session title). */
  blank: boolean
  /** The runtime Session list reports an interaction awaiting this user. */
  pendingInteraction?: PendingInteractionStatus
  running: boolean
  /** Running descendants connected through uninterrupted subagent-origin lineage. */
  runningSubagentCount: number
  /** Finished running while not selected and not yet opened (the green "done" reminder dot). */
  completed: boolean
  updatedAt: number
  /** Edited versions and ordinary conversation forks are projected into one visual two-level lineage. */
  lineage?: {
    role: 'root' | 'branch'
    /** Root + every visible edited version; populated only on the root row. */
    sessionIds: readonly SessionId[]
    /** Stable synthetic branch name such as A, A-1, or B. */
    branchName?: string
    /** The sole most-recent visible child in this lineage. */
    recent?: boolean
    operation?: 'edit' | 'reroll' | 'retry'
    targetTurn?: number
  }
  /** Conversation descendants displayed directly below this root, regardless of storage depth. */
  branches: readonly SessionNode[]
}

/** One top-level conversation and the real Sessions that participate in its activity/order slot. */
export interface ConversationOrderUnit {
  /** The visible root Session id (or the member itself for invalid/missing ancestry). */
  id: SessionId
  /** Root first, followed by its real descendant Session ids in their existing account order. */
  sessionIds: readonly SessionId[]
  /** Most recent activity across the root and every member branch. */
  updatedAt: number
}

/** Session order selected by the Workspace browser. */
export type SessionOrderBy = 'manual' | 'updated'

/** One workspace group section: header row facts + visible top-level session rows. */
export interface GroupNode {
  /** Group key: the workspace id or {@link UNGROUPED_KEY}. */
  key: string
  /** Backing Workspace id; absent only for the ungrouped bucket. */
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  /** Workspace creation time (epoch ms); absent only for the ungrouped bucket. */
  createdAt: number | undefined
  label: string
  /** Total visible sessions in the group. */
  sessionCount: number
  expanded: boolean
  /** The group contains the selected session (active folder tint; supplied here so the renderer never scans). */
  containsCurrent: boolean
  /** Visible session rows (empty while the group is folded). */
  sessions: readonly SessionNode[]
}

/** One flat search row combining list metadata with an optional content match. */
export interface SearchResultNode {
  id: SessionId
  title: string
  workspace: string
  /** The runtime Session list reports an interaction awaiting this user. */
  pendingInteraction?: PendingInteractionStatus
  running: boolean
  /** Running descendants connected through uninterrupted subagent-origin lineage. */
  runningSubagentCount: number
  /** Finished running while not selected and not yet opened (the green "done" reminder dot). */
  completed: boolean
  snippet?: string
}

/** Bounded merged search projection plus the refine-query hint bit. */
export interface SearchResultSet {
  items: readonly SearchResultNode[]
  hasMore: boolean
}

/** Viewing state consumed by the derivation. */
export interface TreeView {
  expandedGroups: readonly string[]
  /** Browser-local order for Sessions without a backing Workspace account. */
  ungroupedOrder?: readonly string[]
  /** User-confirmed branch labels; absent branches retain their synthetic A/A-1 names. */
  branchTitles?: Readonly<Record<string, string>>
}

interface Group {
  key: string
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  createdAt: number | undefined
  label: string
  sessions: SessionSummary[]
}

/**
 * Directory display label: basename of the path (both separators accepted).
 * Ungrouped-bucket fallback for surfaces without a workspace title.
 * @param cwd - directory path, or undefined for the ungrouped bucket.
 * @returns basename, the raw cwd when it has no basename, or the ungrouped label.
 */
export function workspaceLabel(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return UNGROUPED_LABEL
  const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
  return base !== undefined && base !== '' ? base : cwd
}

/** Recency comparator: newest first, id as the deterministic tiebreak (ids are unique per group). */
function byRecency(a: SessionSummary, b: SessionSummary): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
  return a.id < b.id ? -1 : 1
}

/**
 * Ordinary sessions are visible; among blank sessions, only the current one
 * is visible. Subagent children use their parent header catalog; archived
 * sessions are visible nowhere, while their accounting slots remain so
 * unarchiving restores position.
 */
function sessionVisible(session: SessionSummary, current: SessionId | undefined, archived: ReadonlySet<SessionId>): boolean {
  return session.origin !== 'subagent'
    && !archived.has(session.id)
    && (!session.blank || session.id === current)
}

/**
 * A blank session is the selected Workspace's provisional New Session row;
 * its canonical title never enters search (blank rows are query-excluded)
 * and the renderer localizes its display label.
 */
function sessionTitle(session: SessionSummary): string {
  if (session.blank) return 'New Session'
  return session.displayTitle.replace(/（编辑前版本）$/u, '').trimEnd()
}

interface MessageEditVersionProjection {
  kind: 'message-edit'
  parentSessionId: SessionId
  operation: 'edit' | 'reroll' | 'retry'
  targetTurn: number
  createdAt: number
}

interface ConversationLineageEdge {
  kind: 'message-edit' | 'conversation-fork'
  parentSessionId: SessionId
  createdAt: number
  operation?: 'edit' | 'reroll' | 'retry'
  targetTurn?: number
}

/** Decode the durable projection owned by dsh-message-edit. */
function messageEditVersion(session: SessionSummary | undefined): MessageEditVersionProjection | undefined {
  if (session === undefined) return undefined
  const values = session.projectionValues as Readonly<Record<string, unknown>> | undefined
  const value = values?.['messageEditVersion']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (row['kind'] !== 'message-edit'
    || typeof row['parentSessionId'] !== 'string'
    || (row['operation'] !== 'edit' && row['operation'] !== 'reroll' && row['operation'] !== 'retry')
    || typeof row['targetTurn'] !== 'number'
    || typeof row['createdAt'] !== 'number') return undefined
  const parentSessionId = row['parentSessionId'] as SessionId
  // The log projection and header must agree before presentation may collapse the row.
  if (session.parentId !== parentSessionId) return undefined
  return {
    kind: 'message-edit',
    parentSessionId,
    operation: row['operation'],
    targetTurn: row['targetTurn'],
    createdAt: row['createdAt'],
  }
}

/**
 * Resolve one user-visible conversation edge. Message edits carry richer
 * projection metadata; a plain parentId is the Host's ordinary "fork in a new
 * conversation" relation. Subagent lineage is deliberately not presentation
 * lineage in the Workspace browser.
 */
function conversationLineageEdge(session: SessionSummary | undefined): ConversationLineageEdge | undefined {
  if (session === undefined || session.origin === 'subagent') return undefined
  const edited = messageEditVersion(session)
  if (edited !== undefined) return edited
  if (session.parentId === undefined || session.parentId === session.id) return undefined
  return {
    kind: 'conversation-fork',
    parentSessionId: session.parentId,
    // SessionSummary has no immutable creation timestamp. updatedAt is only a
    // deterministic fallback; the established Session order remains the
    // secondary tiebreak below.
    createdAt: session.updatedAt,
  }
}

/** Resolve the original Session through both edit and ordinary-fork edges. */
function conversationRoot(session: SessionSummary, byId: SessionListState['byId']): SessionSummary {
  let cursor = session
  const seen = new Set<SessionId>()
  while (!seen.has(cursor.id)) {
    seen.add(cursor.id)
    const edge = conversationLineageEdge(cursor)
    if (edge === undefined) return cursor
    const parent = byId[edge.parentSessionId]
    if (parent === undefined) return session
    cursor = parent
  }
  return session
}

/**
 * Collapse one ordering account into visible conversation units. A descendant
 * joins its root only when both belong to this account, matching the tree's
 * workspace-local projection boundary.
 */
export function conversationOrderUnits(
  sessionIds: readonly SessionId[],
  list: SessionListState,
): ConversationOrderUnit[] {
  const accountIds = new Set(sessionIds)
  const position = new Map(sessionIds.map((id, index) => [id, index]))
  const membersByUnit = new Map<SessionId, SessionId[]>()
  const activityByUnit = new Map<SessionId, number>()
  for (const id of sessionIds) {
    const session = list.byId[id]
    if (session === undefined) continue
    const root = conversationRoot(session, list.byId)
    const unitId = accountIds.has(root.id) ? root.id : session.id
    const members = membersByUnit.get(unitId) ?? []
    members.push(id)
    membersByUnit.set(unitId, members)
    activityByUnit.set(unitId, Math.max(activityByUnit.get(unitId) ?? Number.NEGATIVE_INFINITY, session.updatedAt))
  }
  return [...membersByUnit].map(([id, members]) => ({
    id,
    sessionIds: [id, ...members.filter(member => member !== id)],
    updatedAt: activityByUnit.get(id) ?? 0,
  })).sort((left, right) => {
    const leftPosition = position.get(left.id) ?? Number.MAX_SAFE_INTEGER
    const rightPosition = position.get(right.id) ?? Number.MAX_SAFE_INTEGER
    return leftPosition - rightPosition || (left.id < right.id ? -1 : 1)
  })
}

function alphaBranch(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26)
  }
  return label
}

/** Direct-child identity anchors A/B while deeper storage descendants become A-1/A-2 peers. */
function firstBranchBelowRoot(
  session: SessionSummary,
  rootId: SessionId,
  byId: SessionListState['byId'],
): SessionId {
  let cursor = session
  const seen = new Set<SessionId>()
  while (!seen.has(cursor.id)) {
    seen.add(cursor.id)
    const edge = conversationLineageEdge(cursor)
    if (edge === undefined || edge.parentSessionId === rootId) return cursor.id
    const parent = byId[edge.parentSessionId]
    if (parent === undefined) return cursor.id
    cursor = parent
  }
  return session.id
}

/** Build one group without projecting session lineage into presentation. */
function buildGroup(
  key: string,
  workspaceId: WorkspaceId | undefined,
  cwd: string | undefined,
  createdAt: number | undefined,
  label: string,
  members: readonly SessionSummary[],
  order: 'account' | 'recency',
): Group {
  const sessions = [...members]
  // Real Workspace order comes from sessionIds. Ungrouped falls back to
  // recency until the browser supplies its persisted local order.
  if (order === 'recency') sessions.sort(byRecency)
  return { key, workspaceId, cwd, createdAt, label, sessions }
}

/** Apply a stored Ungrouped order and append newly loose Sessions by recency. */
function orderedUngrouped(members: readonly SessionSummary[], stored: readonly string[]): SessionSummary[] {
  const byId = new Map(members.map(session => [session.id as string, session]))
  const included = new Set<string>()
  const ordered: SessionSummary[] = []
  for (const key of stored) {
    const session = byId.get(key)
    if (session === undefined || included.has(key)) continue
    ordered.push(session)
    included.add(key)
  }
  for (const session of [...members].sort(byRecency)) {
    if (included.has(session.id)) continue
    ordered.push(session)
  }
  return ordered
}

/**
 * Group Sessions by Host Workspace: one group per entity in stable Host
 * order, with members resolved from sessionIds in their stored order. Sessions
 * outside every Workspace trail in the browser-local Ungrouped order, which
 * falls back to recency before that order is initialized.
 */
function groupByWorkspace(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  archived: ReadonlySet<SessionId>,
  ungroupedOrder: readonly string[] | undefined,
): Group[] {
  const groups: Group[] = []
  const accounted = new Set<SessionId>()
  for (const workspace of workspaces) {
    const members: SessionSummary[] = []
    for (const id of workspace.sessionIds) {
      const summary = list.byId[id]
      if (summary === undefined) continue // account may lead the list pull; the row appears when the summary lands
      accounted.add(id)
      if (!sessionVisible(summary, list.current, archived)) continue
      members.push(summary)
    }
    groups.push(buildGroup(
      workspace.workspaceId, workspace.workspaceId, workspace.path,
      Date.parse(workspace.createdAt), workspace.title, members, 'account',
    ))
  }
  const stray = list.ids
    .map(id => list.byId[id])
    .filter((s): s is SessionSummary =>
      s !== undefined && !accounted.has(s.id) && sessionVisible(s, list.current, archived))
  if (stray.length > 0) {
    groups.push(buildGroup(
      UNGROUPED_KEY,
      undefined,
      undefined,
      undefined,
      UNGROUPED_LABEL,
      ungroupedOrder === undefined ? stray : orderedUngrouped(stray, ungroupedOrder),
      ungroupedOrder === undefined ? 'recency' : 'account',
    ))
  }
  return groups
}

function sessionNode(
  s: SessionSummary,
  descendants: ReadonlyMap<SessionId, SubagentDescendantSummary>,
): SessionNode {
  return {
    id: s.id,
    title: sessionTitle(s),
    blank: s.blank,
    running: s.running,
    runningSubagentCount: descendants.get(s.id)?.runningCount ?? 0,
    completed: s.completed === true,
    updatedAt: s.updatedAt,
    branches: [],
    ...(s.pendingInteraction === undefined ? {} : { pendingInteraction: s.pendingInteraction }),
  }
}

/** Collapse the true immutable conversation tree into the requested root + flat branch list. */
function projectConversationLineages(
  sessions: readonly SessionSummary[],
  list: SessionListState,
  descendants: ReadonlyMap<SessionId, SubagentDescendantSummary>,
  branchTitles: Readonly<Record<string, string>> = {},
): SessionNode[] {
  const memberIds = new Set(sessions.map(session => session.id))
  const childrenByRoot = new Map<SessionId, SessionSummary[]>()
  for (const session of sessions) {
    if (conversationLineageEdge(session) === undefined) continue
    const root = conversationRoot(session, list.byId)
    if (root.id === session.id || !memberIds.has(root.id)) continue
    const children = childrenByRoot.get(root.id) ?? []
    children.push(session)
    childrenByRoot.set(root.id, children)
  }

  const hidden = new Set([...childrenByRoot.values()].flat().map(session => session.id))
  return sessions.filter(session => !hidden.has(session.id)).map((session) => {
    const edited = childrenByRoot.get(session.id)
    if (edited === undefined || edited.length === 0) return sessionNode(session, descendants)
    // Identity order is creation/ancestry based so A/A-1/B names never
    // change when a branch becomes active. Display order is applied only
    // after every stable identity has been assigned.
    const identityOrdered = [...edited].sort((left, right) => {
      const leftEdge = conversationLineageEdge(left)
      const rightEdge = conversationLineageEdge(right)
      return (leftEdge?.createdAt ?? left.updatedAt) - (rightEdge?.createdAt ?? right.updatedAt)
        || (left.id < right.id ? -1 : 1)
    })
    const directIds = [...new Set(identityOrdered.map(child => firstBranchBelowRoot(child, session.id, list.byId)))]
    const directNames = new Map(directIds.map((id, index) => [id, alphaBranch(index)]))
    const descendantCounts = new Map<SessionId, number>()
    const recentBranchId = identityOrdered.reduce((recent, child) => (
      child.updatedAt > recent.updatedAt
      || (child.updatedAt === recent.updatedAt && child.id > recent.id)
        ? child
        : recent
    )).id
    const branches = identityOrdered.map((child) => {
      const edge = conversationLineageEdge(child)
      const directId = firstBranchBelowRoot(child, session.id, list.byId)
      const base = directNames.get(directId) ?? 'A'
      const isDirect = child.id === directId
      const sequence = isDirect ? 0 : (descendantCounts.get(directId) ?? 0) + 1
      if (!isDirect) descendantCounts.set(directId, sequence)
      const node = sessionNode(child, descendants)
      return {
        ...node,
        title: branchTitles[child.id]
          ?? `${edge?.kind === 'message-edit' ? '编辑分支' : '对话分支'} ${base}${sequence === 0 ? '' : `-${String(sequence)}`}`,
        lineage: {
          role: 'branch' as const,
          sessionIds: [child.id],
          branchName: `${base}${sequence === 0 ? '' : `-${String(sequence)}`}`,
          ...(child.id === recentBranchId ? { recent: true } : {}),
          ...(edge?.kind !== 'message-edit' ? {} : {
            operation: edge.operation,
            targetTurn: edge.targetTurn,
          }),
        },
      }
    }).sort((left, right) => right.updatedAt - left.updatedAt)
    const root = sessionNode(session, descendants)
    return {
      ...root,
      lineage: {
        role: 'root',
        sessionIds: [session.id, ...identityOrdered.map(child => child.id)],
      },
      branches,
      // The logical conversation participates in recency ordering as one unit.
      updatedAt: Math.max(root.updatedAt, ...branches.map(branch => branch.updatedAt)),
    }
  })
}

/**
 * Derive the workspace browser groups with every session as a top-level row.
 *
 * Every group shows; sessions populate under expanded groups in the selected
 * local order. Blank sessions are excluded except for the selected
 * provisional New Session row; archived sessions are excluded everywhere.
 * Content search lives outside this derivation
 * (see {@link deriveSearchResults}).
 * @param list - sessions list snapshot (`current` feeds containsCurrent).
 * @param workspaces - real workspaces in stable Host order.
 * @param archivedSessionIds - registry-global archive set.
 * @param view - local expansion arrays.
 * @returns group sections in render order.
 */
export function deriveGroups(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[],
  view: TreeView,
): GroupNode[] {
  const archived = new Set(archivedSessionIds)
  const expandedGroups = new Set(view.expandedGroups)
  const descendants = indexSubagentDescendants(list.byId)
  const currentGroup = list.current === undefined
    ? undefined
    : (workspaces.find(w => w.sessionIds.includes(list.current as SessionId))?.workspaceId as string | undefined)
        ?? UNGROUPED_KEY
  const groups: GroupNode[] = []
  for (const g of groupByWorkspace(list, workspaces, archived, view.ungroupedOrder)) {
    const expanded = expandedGroups.has(g.key)
    groups.push({
      key: g.key,
      workspaceId: g.workspaceId,
      cwd: g.cwd,
      createdAt: g.createdAt,
      label: g.label,
      sessionCount: g.sessions.length,
      expanded,
      containsCurrent: g.key === currentGroup,
      sessions: expanded ? projectConversationLineages(g.sessions, list, descendants, view.branchTitles) : [],
    })
  }
  return groups
}

/**
 * Derive the flat session list ("In one list" mode): every session — fork
 * children included — as a top-level row, strictly newest-first. No grouping,
 * no parent/child adjacency. Content search lives outside this derivation
 * (see {@link deriveSearchResults}).
 * @param list - sessions list snapshot.
 * @param archivedSessionIds - registry-global archive set.
 * @returns flat rows in render order.
 */
export function deriveFlat(
  list: SessionListState,
  archivedSessionIds: readonly SessionId[],
  branchTitles: Readonly<Record<string, string>> = {},
): SessionNode[] {
  const archived = new Set(archivedSessionIds)
  const descendants = indexSubagentDescendants(list.byId)
  const rows: SessionSummary[] = []
  for (const id of list.ids) {
    const s = list.byId[id]
    if (s === undefined || !sessionVisible(s, list.current, archived)) continue
    rows.push(s)
  }
  const projected = projectConversationLineages(rows, list, descendants, branchTitles)
  projected.sort((left, right) => (
    right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : 1)
  ))
  return projected
}

/** Relative-time bucket of a session row's trailing label. */
export type RelativeTimeUnit = 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'

/** Structured relative time: the bucket plus its magnitude (0 for 'now'). */
export interface RelativeTime {
  unit: RelativeTimeUnit
  n: number
}

/**
 * Merge immediate title/Workspace substring matches with ranked Host content
 * matches. Local rows lead newest-first, content-only rows retain backend
 * order, and duplicate sessions receive the backend snippet in place.
 * @param list - session metadata authority.
 * @param workspaces - Workspace membership and display labels.
 * @param query - caller text; surrounding whitespace is ignored.
 * @param archivedSessionIds - registry-global archive set (members never match).
 * @param content - ranked Host content-search page.
 * @param limit - protocol-owned maximum merged row count.
 * @returns bounded deduplicated flat rows and a refine-query hint bit.
 */
export function deriveSearchResults(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  query: string,
  archivedSessionIds: readonly SessionId[],
  content: { items: readonly SessionSearchResultItem[]; hasMore: boolean },
  limit: number,
): SearchResultSet {
  const q = query.trim().toLowerCase()
  if (q === '') return { items: [], hasMore: false }
  const archived = new Set(archivedSessionIds)
  const descendants = indexSubagentDescendants(list.byId)

  const workspaceBySession = new Map<SessionId, string>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) {
      if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, workspace.title)
    }
  }
  const labelOf = (summary: SessionSummary): string =>
    workspaceBySession.get(summary.id) ?? workspaceLabel(summary.cwd)
  const contentBySession = new Map<SessionId, SessionSearchResultItem>()
  for (const item of content.items) {
    if (!contentBySession.has(item.sessionId)) contentBySession.set(item.sessionId, item)
  }

  const local: SessionSummary[] = []
  for (const id of list.ids) {
    const summary = list.byId[id]
    // Blank placeholders never match a query (their canonical title displays
    // localized, so matching it would tie search to one language).
    if (summary === undefined || summary.blank || !sessionVisible(summary, list.current, archived)) continue
    if (
      sessionTitle(summary).toLowerCase().includes(q)
      || labelOf(summary).toLowerCase().includes(q)
    ) {
      local.push(summary)
    }
  }
  local.sort(byRecency)

  const ordered: SessionSummary[] = []
  const included = new Set<SessionId>()
  const include = (summary: SessionSummary): void => {
    if (included.has(summary.id)) return
    included.add(summary.id)
    ordered.push(summary)
  }
  for (const summary of local) include(summary)
  for (const item of content.items) {
    const summary = list.byId[item.sessionId]
    if (summary !== undefined && !summary.blank && sessionVisible(summary, list.current, archived)) include(summary)
  }

  return {
    items: ordered.slice(0, limit).map((summary) => {
      const match = contentBySession.get(summary.id)
      return {
        id: summary.id,
        title: sessionTitle(summary),
        workspace: labelOf(summary),
        running: summary.running,
        runningSubagentCount: descendants.get(summary.id)?.runningCount ?? 0,
        ...(summary.pendingInteraction === undefined
          ? {}
          : { pendingInteraction: summary.pendingInteraction }),
        completed: summary.completed === true,
        ...match === undefined ? {} : { snippet: match.snippet },
      }
    }),
    hasMore: content.hasMore || ordered.length > limit,
  }
}

/**
 * Compact relative time for session rows, as a structured bucket the
 * renderer localizes ("now"/"5min"/"3h"/"2d"/"4mo"/"1y" in en).
 * @param updatedAt - epoch ms of the session's last activity.
 * @param now - current epoch ms (injected for pure rendering).
 * @returns the row's trailing time bucket and magnitude.
 */
export function relativeTime(updatedAt: number, now: number): RelativeTime {
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const diff = Math.max(0, now - updatedAt)
  if (diff < MIN) return { unit: 'now', n: 0 }
  if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
  if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
  if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
  if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
}
