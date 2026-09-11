/**
 * The sidebar shell: fixed-position panels portalled onto document.body
 * (the core AppFrame owns the left sidebar / center / details columns and
 * has no right-side hole for plugins). The right panel hosts the original
 * workbench; the bottom panel hosts a second, independent workbench. The
 * bottom panel squeezes ONLY the center column (the agent output area): it
 * spans from the app shell's own left sidebar to the right panel's left
 * edge, so neither sidebar gives up any position (the right panel keeps its
 * full height). A persistent two-button cluster at the top-right corner
 * toggles each panel; the right panel's width drags from its left edge, the
 * bottom panel's height from its top edge, and the shared corner drags both
 * at once. The whole layout lives in the per-session store, so switching
 * conversations swaps the sidebar.
 *
 * The shell binds the workbench actions to the store and dispatches tab
 * content to the views. New tabs come from the + menu (explorer / git /
 * terminal; editors open from the explorer). Tabs live in one tree only —
 * they never cross panels; only the panel sizes drag against each other.
 *
 * Narrow (mobile, <768px) viewports show ONLY the right sidebar: entering
 * narrow migrates the bottom panel's tabs INTO the right tree
 * (migrateBottomTabs) — one workbench, the bottom tabs thrown into its
 * strips. The right panel becomes a full-width drawer, the bottom panel
 * and its toggle button disappear, and the layout push is disabled (the
 * drawer floats). Widening does not migrate back: the tabs keep living in
 * the right tree.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconCloseFill14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context, SidebarSessionList } from '../context-types.ts'
import { insertInlineFileReference } from './conversation-draft.ts'
import {
  BOTTOM_MIN, LEFT_MAX, LEFT_MIN, PANEL_MIN, agentUuidOf, allLeaves, collapseAllFoldersInState, firstLeaf, isAgentTabId, leafWithTab, mapLeaf, migrateBottomTabs, moveTab, moveTabToEdge, openDiffTab,
  reconcileAgentTerminals, revealPathInState,
  resizeSplitIn, setBottomHeight, setLeftWidth, setWidth, toggleBottomPanel, toggleExpanded, toggleLeftPanel, togglePanel,
  type DropZone, type SidebarState, type SidebarStore, type SidebarTab, type SplitNode,
} from './state.ts'
import { IconPanelBottomOutline16, IconPanelLeftOutline16, IconPanelRightOutline16 } from './icons.tsx'
import { ExplorerView } from './ExplorerView.tsx'
import { startupTaskLane } from './startup-tasks.ts'
import { openHtmlInBrowser, openSidebarFile, synchronizeDeletedPath, synchronizeRenamedPath } from './intercept.tsx'
import { Workbench, type WorkbenchActions } from './split-pane.tsx'
import { useNarrowViewport } from './breakpoints.ts'
import type { NewTabOption } from './TabBar.tsx'
import type { TabDragPayload } from './TabBar.tsx'
import { relativeTo } from './paths.ts'
import { OrphanedTab } from './OrphanedTab.tsx'
import { detectNewDirectSubagent } from './subagent-detect.ts'
import { detectNewJob } from './subagent-jobs.ts'
import { t } from './locales.ts'
import { api, type SessionScope } from './api.ts'
import { closeTabAndMaybeCollapseRightSurface, rightSurfaceTree } from './browser-panel.ts'
import { previewTabIcon } from './preview.tsx'
import css from './sidebar.module.css'

/** How many consecutive reconnect failures stop the agent-terminals push loop
 * (mirror of the terminal view's own cap; the loop restarts on session switch). */
const FAILURE_LIMIT = 3

/** Product configuration: the right rail hosts Browser and read-only Preview. */
const RIGHT_PANEL_ENABLED = true

/** Render the content of one tab (dispatched by type). */
function TabContent(props: {
  tab: SidebarTab
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  onToggleDir: (path: string) => void
  onReferenceFile: (path: string, isDir?: boolean) => void
  ctx: Context
  store: SidebarStore
  /** Whether this tab is the active one AND the panel is open (live views pause otherwise). */
  visible: boolean
  /** Fired before a topology node jumps to its child session (see Sidebar). */
  onSubagentJump: (childSessionId: string) => void
  /** Open a diff tab from the git panel (placement handled by the store). */
  onOpenDiff: (tab: SidebarTab) => void
}) {
  const { tab, sessionId, cwd, expanded, onToggleDir, onReferenceFile, ctx, store, visible, onSubagentJump, onOpenDiff } = props
  const scope = { sessionId, cwd }
  const descriptor = ctx.betterSidebar?.getTab(tab.type)
  if (descriptor === undefined) {
    return <OrphanedTab ctx={ctx} store={store} scope={scope} tab={tab} visible={visible} />
  }
  return descriptor.component({
    ctx, store, scope, tab, visible, expanded,
    onToggleDir, onReferenceFile, onOpenDiff, onSubagentJump,
  })
}

/** The + menu options for the current state, driven by the tab registry.
 * Hidden tabs (editor/diff) never show; `available` returning false shows
 * a disabled row (e.g. terminal at capacity) instead of hiding the option.
 * Tabs the user disabled in the side card settings are filtered out
 * entirely — re-enabling them is the settings page's job. */
function buildNewTabOptions(state: SidebarState, ctx: Context, scope: SessionScope): NewTabOption[] {
  const service = ctx.betterSidebar
  if (service === undefined) return []
  return service.getTabs()
    .filter(d => !d.hidden && service.isTabEnabled(d.id))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    .map(d => ({
      id: d.id,
      label: typeof d.title === 'function' ? d.title() : d.title,
      disabled: !(d.available?.(ctx, scope, state) ?? true),
      icon: typeof d.icon === 'function' ? d.icon(16) : d.icon,
    }))
}

export function Sidebar(props: { ctx: Context; store: SidebarStore }) {
  const { ctx, store } = props

  // Copy freshness: re-render the whole tree when the DSH locale switches.
  // The module-level t() reads the active locale at call time, so a root
  // re-render alone re-localizes every panel (no memo barriers below).
  const localeRevision = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.locale.subscribe(callback), [ctx]),
    useCallback(() => ctx.locale.getSnapshot().active, [ctx]),
  )
  void localeRevision

  // Narrow (mobile) viewports collapse the two panels into one: the right
  // panel becomes a full-width drawer holding BOTH workbenches, the bottom
  // panel (and its toggle button) disappears, and the layout push is
  // disabled (the drawer floats over the app shell). Entering narrow
  // MIGRATES the bottom tree's tabs into the right tree (migrateBottomTabs)
  // — the merged display is the right sidebar alone, the bottom tabs thrown
  // into its strips. Widening never rewrites the migrated state: the tabs
  // keep living in the right tree.
  const narrow = useNarrowViewport()

  // Current conversation (the sessions list feed).
  const sessionList = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.sessions.list.subscribe(callback), [ctx]),
    useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
  )
  const current = sessionList.current

  // Per-session sidebar state.
  const snapshot = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
  useEffect(() => { store.setSession(current) }, [current, store])

  const state = snapshot.state
  const sessionId = snapshot.sessionId
  const summaryCwd = sessionId === undefined ? undefined : sessionList.byId[sessionId]?.cwd
  const browserEnabled = ctx.betterSidebar?.isTabEnabled('browser') !== false
  const previewEnabled = ctx.betterSidebar?.isTabEnabled('preview') !== false
  const rightPanelEnabled = RIGHT_PANEL_ENABLED && (browserEnabled || previewEnabled)

  /**
   * Bottom-panel merge on narrow viewports: whenever a session is current
   * while narrow (mount, session switch, or a desktop→narrow transition),
   * throw the bottom tree's tabs into the right tree. Idempotent — after
   * the first migration the bottom tree is empty and the reducer returns
   * the same reference, so this effect settles immediately.
   */
  useEffect(() => {
    if (!narrow || sessionId === undefined) return
    store.reduce(migrateBottomTabs)
  }, [narrow, sessionId, store])

  // While the session's header is still hydrating (or the session is blank),
  // the list summary may carry no cwd; ask the host once (it falls back to
  // the process cwd) so the explorer root and terminal cwd are real from
  // first paint instead of showing "no session".
  const [fetchedCwd, setFetchedCwd] = useState<string | undefined>(undefined)
  useEffect(() => {
    setFetchedCwd(undefined)
    if (sessionId === undefined || summaryCwd !== undefined) return
    let cancelled = false
    api.sessionCwd({ sessionId })
      .then(result => { if (!cancelled) setFetchedCwd(result.cwd) })
      .catch(() => { /* the explorer/git rows surface their own errors */ })
    return () => { cancelled = true }
  }, [sessionId, summaryCwd])
  const cwd = summaryCwd ?? fetchedCwd

  /**
   * Agent terminals push: subscribe to the host's live list of agent-owned
   * terminals for this session (created by the model through the
   * `terminal_create` tool). The host pushes a JSON array on every
   * create / close / exit; the sidebar reconciles the list into tabs
   * (id `agent:<uuid>`, title from the agent). A disconnected socket
   * retries with a short backoff so a refresh or transient drop reattaches
   * the same shell without losing the agent's work — capped like the
   * terminal view's own reconnect loop, so a refused endpoint never spins
   * forever (the next session switch restarts the loop).
   * While the terminal tab type is disabled in settings, pushes are
   * ignored (no auto-added tabs); re-enabling makes the next push converge.
   */
  useEffect(() => {
    if (sessionId === undefined) return
    let socket: WebSocket | null = null
    let retry: number | undefined
    let closed = false
    let failures = 0
    const connect = (): void => {
      if (closed) return
      const url = new URL('/sidebar/ws/agent-terminals', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.search = new URLSearchParams({ sessionId }).toString()
      socket = new WebSocket(url.toString())
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        try {
          const list = JSON.parse(event.data) as Array<{ uuid: string; title: string; command: string; exited: boolean }>
          if (!Array.isArray(list)) return
          store.reduce(s => ctx.betterSidebar?.isTabEnabled('terminal') === false
            ? s
            : reconcileAgentTerminals(s, list))
        } catch {
          // Malformed push: ignore (the next push will reconcile).
        }
      }
      socket.onclose = () => {
        if (closed) return
        failures += 1
        if (failures >= FAILURE_LIMIT) {
          console.error('[dsh-better-sidebar] agent-terminals connection failed; stopping reconnect loop', sessionId)
          return
        }
        retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => { socket?.close() }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      socket?.close()
    }
  }, [sessionId, store])

  /**
   * Subagent auto-activation: the moment the current conversation spawns its
   * FIRST direct subagent (a 0 → N transition on the list feed), the "auto
   * open" pref is on, and the Subagent tab type is enabled in settings,
   * open the panel (if collapsed) and focus the Subagent page
   * (single-instance: an existing tab is focused, never duplicated).
   * Switching to a session that already has subagents never triggers — its
   * baseline starts at the current count — so a deliberate layout is never
   * fought.
   */
  const listBaselineRef = useRef<SidebarSessionList | undefined>(undefined)
  useEffect(() => {
    if (!rightPanelEnabled) return
    const prev = listBaselineRef.current
    listBaselineRef.current = sessionList
    if (sessionId === undefined || prev === undefined) return
    if (!detectNewDirectSubagent(prev, sessionList, sessionId)) return
    if (!store.getPrefs().autoOpenSubagent) return
    if (ctx.betterSidebar?.isTabEnabled('subagent') === false) return
    store.reduce(s => s.panelOpen ? s : togglePanel(s))
    // Pin the landing to the right panel: the auto-opened Subagent page must
    // appear where the panel just expanded, not in a bottom-panel pane the
    // user last touched.
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
    ctx.betterSidebar?.openTab({ type: 'subagent', title: t('subagent') })
  }, [sessionList, sessionId, store, ctx])

  /**
   * Job auto-activation: the moment a NEW background job appears for the
   * current conversation (a job id the previous snapshot lacked), the
   * auto-open pref is on, and the Jobs tab type is enabled, open the panel
   * (if collapsed) and focus the Jobs page. Unlike the subagent trigger
   * (0 → N only), ANY new job id triggers: the agent may start several
   * jobs in one session, and each should surface. A fresh page load never
   * triggers — its baseline starts at the current snapshot.
   */
  const jobBaselineRef = useRef<SidebarSessionList | undefined>(undefined)
  useEffect(() => {
    if (!rightPanelEnabled) return
    const prev = jobBaselineRef.current
    jobBaselineRef.current = sessionList
    if (sessionId === undefined || prev === undefined) return
    if (!detectNewJob(prev, sessionList, sessionId)) return
    if (!store.getPrefs().autoOpenJobs) return
    if (ctx.betterSidebar?.isTabEnabled('subagent') === false) return
    store.reduce(s => s.panelOpen ? s : togglePanel(s))
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
    ctx.betterSidebar?.openTab({ type: 'subagent', title: t('subagent') })
  }, [sessionList, sessionId, store, ctx])

  /**
   * Topology jump-back: clicking a subagent node on the Subagent page calls
   * the official `openSubagent`, which switches the sidebar to that child
   * session's OWN layout (a fresh child session defaults to the explorer).
   * The README contract says the Subagent page must stay open with the jumped
   * node highlighted — so once the current session becomes the recorded jump
   * target, re-open the Subagent page on top of the child's layout (expanding
   * the panel first if it is collapsed). Only this explicit node click arms
   * the flag, so switching to a subagent session by any other means keeps
   * that session's own layout untouched.
   */
  const subagentJumpRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!rightPanelEnabled) return
    const pending = subagentJumpRef.current
    if (pending === undefined || sessionId !== pending) return
    subagentJumpRef.current = undefined
    store.reduce(s => s.panelOpen ? s : togglePanel(s))
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
    ctx.betterSidebar?.openTab({ type: 'subagent', title: t('subagent') })
  }, [sessionId, store, ctx])

  // The app shell's center column: the bottom panel spans ONLY that column
  // ("squeezes the agent output area") — it starts at the app sidebar's
  // right edge and ends at the details column's left edge (the details
  // column sits between the center and the right panel). Measured directly
  // from the AppFrame's center column DOM (the parent of the
  // [data-slot="conversation"] wrapper — layout.css's center column) so the
  // bottom panel tracks the column's real
  // horizontal edges — including the animated margin-right push while the
  // right panel opens/closes; a frame that never appears keeps the initial
  // zero-size fallback (the panel renders at 0 width until measured).
  const [centerRect, setCenterRect] = useState({ left: 0, right: 0 })
  // Stable anchor for the LEFT panel: the app's session-list column's right
  // edge. Unlike centerRect.left (which shifts right by the left panel's own
  // margin-left push while it opens/closes), the session list never moves —
  // so the left panel sits at this value and slides purely via transform,
  // decoupled from the center column's push animation. Observed DIRECTLY (not
  // derived from the center column) so the left panel hugs the native sidebar
  // with no gap even as the sidebar itself resizes. `null` = not measured yet
  // (the panel stays unrendered until the first measure, avoiding a flash).
  const [sessionListRight, setSessionListRight] = useState<number | null>(null)
  // Refs keep the measure step stable across renders and let it skip work
  // mid-drag: during a width/corner drag the layout push resizes the center
  // column every frame, and reacting (setCenterRect → re-render) would
  // re-introduce the drag lag this shell deliberately avoids. applyDrag
  // writes the bottom panel's edges directly, so measurement pauses then.
  const centerColRef = useRef<HTMLElement | null>(null)
  const sessionListRef = useRef<HTMLElement | null>(null)
  const draggingRef = useRef(false)
  const measureCenter = useCallback((): void => {
    if (draggingRef.current) return
    const col = centerColRef.current
    if (col === null) return
    const rect = col.getBoundingClientRect()
    // The bottom panel only cares about the horizontal edges: a pure height
    // change (the bottom panel itself opening/closing) must not re-render,
    // so keep the previous object when left/right are unchanged.
    setCenterRect(prev =>
      prev.left === rect.left && prev.right === rect.right
        ? prev
        : { left: rect.left, right: rect.right })
  }, [])
  const measureSessionList = useCallback((): void => {
    if (draggingRef.current) return
    const list = sessionListRef.current
    if (list === null) return
    const right = list.getBoundingClientRect().right
    setSessionListRight(prev => prev === right ? prev : right)
  }, [])
  useEffect(() => {
    let disposed = false
    let observer: ResizeObserver | undefined
    let sessionObserver: ResizeObserver | undefined
    // Locate the AppFrame's center column. DSH 0.1.x wraps slot hosts in
    // [data-slot] containers: the conversation slot wrapper
    // ([data-slot="conversation"]) sits directly inside the center column,
    // so its parent IS that column — no hashed-class or positional
    // dependency (layout.css uses the same anchor). The shell swaps the
    // boot page for the AppFrame only AFTER boot settles, so the first
    // query may miss it. Never give up: watch #root's children (the swap
    // mutates them) and re-run this locator — querying once and bailing
    // would strand the panel at the zero-size fallback forever (observed:
    // a 1px sliver at the viewport's left edge).
    const locate = (): void => {
      if (disposed) return
      const col = document.querySelector('#root [data-slot="conversation"]')
        ?.parentElement as HTMLElement | undefined
      if (col === undefined) {
        if (centerColRef.current !== null) {
          centerColRef.current = null
          observer?.disconnect()
          observer = undefined
        }
        if (sessionListRef.current !== null) {
          sessionListRef.current = null
          sessionObserver?.disconnect()
          sessionObserver = undefined
        }
        return
      }
      if (centerColRef.current !== col) {
        centerColRef.current = col
        observer?.disconnect()
        observer = new ResizeObserver(measureCenter)
        observer.observe(col)
      }
      // The left panel hugs the app's session-list column (the center
      // column's previous sibling): observe it independently so the panel
      // tracks the native sidebar's own resize with no gap.
      const list = col.previousElementSibling as HTMLElement | null
      if (list !== null && sessionListRef.current !== list) {
        sessionListRef.current = list
        sessionObserver?.disconnect()
        sessionObserver = new ResizeObserver(measureSessionList)
        sessionObserver.observe(list)
      } else if (list === null && sessionListRef.current !== null) {
        sessionListRef.current = null
        sessionObserver?.disconnect()
        sessionObserver = undefined
      }
      measureCenter()
      measureSessionList()
    }
    locate()
    const watcher = new MutationObserver(locate)
    const root = document.getElementById('root')
    if (root !== null) watcher.observe(root, { childList: true })
    return () => {
      disposed = true
      observer?.disconnect()
      sessionObserver?.disconnect()
      watcher.disconnect()
      centerColRef.current = null
      sessionListRef.current = null
    }
  }, [measureCenter, measureSessionList])

  /**
   * Bottom-panel first-expansion auto terminal: the FIRST time the user
   * expands the bottom panel in a session, try to open a fresh terminal tab
   * there. "Try" is literal — the terminal's own quota and enable switch
   * gate the attempt (a full quota or a disabled terminal type makes it a
   * no-op). Gated on the bottomPanelAutoTerminal pref (the terminal tab's
   * nested settings toggle, default on). Only a false→true TRANSITION fires
   * (a panel persisted open never counts as an expansion), and the session's
   * bottomOpenedOnce flag is set atomically with the first fire so later
   * expansions never repeat it.
   */
  const bottomWasOpenRef = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    // The bottom panel does not exist on narrow viewports (the two
    // workbenches merge into one panel), so the first-expansion auto
    // terminal is a desktop-only behavior.
    if (narrow) return
    if (state === undefined) return
    const wasOpen = bottomWasOpenRef.current
    bottomWasOpenRef.current = state.bottomOpen
    if (wasOpen === undefined || wasOpen || !state.bottomOpen) return
    if (state.bottomOpenedOnce) return
    if (store.getPrefs().bottomPanelAutoTerminal === false) return
    if (ctx.betterSidebar?.isTabEnabled('terminal') === false) return
    // Land the tab in the bottom panel's first pane; the once-flag is set
    // atomically so later expansions never repeat the auto-open.
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.bottomSplits).id, bottomOpenedOnce: true }))
    ctx.betterSidebar?.openTab({ type: 'terminal' })
  }, [state, store, ctx, narrow])

  // Panel drags: the right panel's width (left edge strip), the bottom
  // panel's height (top edge strip), and the shared corner (both at once).
  // Drags write the sizes DIRECTLY to the DOM (panel styles + the layout CSS
  // variables) instead of round-tripping the store on every pointer move —
  // a store reduce re-renders both workbenches (terminals, editors…) per
  // move, which is the visible drag lag. The store is committed once on
  // pointer up (clamping + persistence).
  const panelRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const cornerRef = useRef<HTMLDivElement | null>(null)
  const widthDrag = useRef({ startX: 0, startWidth: 0 })
  const [draggingWidth, setDraggingWidth] = useState(false)
  const bottomDrag = useRef({ startY: 0, startHeight: 0 })
  const [draggingBottom, setDraggingBottom] = useState(false)
  const cornerDrag = useRef({ startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const [draggingCorner, setDraggingCorner] = useState(false)
  // The LEFT panel (explorer dock) width drag: its resize strip sits on the
  // panel's right edge, so dragging right widens it.
  const leftRef = useRef<HTMLDivElement | null>(null)
  const leftDrag = useRef({ startX: 0, startWidth: 0 })
  const [draggingLeft, setDraggingLeft] = useState(false)
  const anyDragging = draggingWidth || draggingBottom || draggingCorner || draggingLeft

  // Pause center-column measurement while dragging, and re-measure once the
  // drag settles at its committed size. The store commit lands on release and
  // the final width equals the last drag width, so no ResizeObserver event
  // fires to refresh centerRect — this explicit re-measure covers that gap.
  useEffect(() => {
    draggingRef.current = anyDragging
    if (!anyDragging) {
      measureCenter()
      measureSessionList()
    }
  }, [anyDragging, measureCenter, measureSessionList])

  // Clamp mirrors of setWidth/setBottomHeight for mid-drag values (the store
  // re-clamps on commit; these keep the panels from overshooting mid-drag).
  const clampWidth = (width: number): number =>
    Math.min(Math.max(PANEL_MIN, Math.round(width)), Math.max(PANEL_MIN, window.innerWidth))
  const clampHeight = (height: number): number =>
    Math.min(Math.max(BOTTOM_MIN, Math.round(height)), Math.max(BOTTOM_MIN, window.innerHeight - PANEL_MIN))
  const clampLeftWidth = (width: number): number =>
    Math.min(Math.max(LEFT_MIN, Math.round(width)), Math.max(LEFT_MIN, window.innerWidth))

  /** Apply a drag size to the DOM without touching React state or the store.
   *  The bottom panel's right edge tracks the right panel's left edge HERE
   *  too — React state only updates on release, so the inline right must be
   *  written directly or the bottom panel would lag the sidebar mid-drag. */
  const applyDrag = (width: number, height: number): void => {
    panelRef.current?.style.setProperty('width', `${width}px`)
    bottomRef.current?.style.setProperty('height', `${height}px`)
    // centerRect.right is the center column's right edge at the committed
    // width (innerWidth - state.width - detailsWidth), so this equals
    // `width + detailsWidth` — derived from the measured column, keeping the
    // drag write-only (no React re-render mid-drag).
    bottomRef.current?.style.setProperty('right', `${(window.innerWidth - centerRect.right) + (width - (state?.width ?? 0))}px`)
    document.documentElement.style.setProperty('--dsh-sidebar-width', `${width}px`)
    document.documentElement.style.setProperty('--dsh-sidebar-height', `${height}px`)
    if (cornerRef.current !== null) {
      cornerRef.current.style.left = `${window.innerWidth - width - 6}px`
      cornerRef.current.style.top = `${window.innerHeight - height - 6}px`
    }
  }

  // Drags write at most once per frame: pointer events fire several times
  // faster than the display refresh, and each write reflows the app shell
  // (the layout push) plus the panels — batching to one write per frame is
  // what keeps the drag smooth. The store is still committed once on release.
  const dragFrame = useRef<number | null>(null)
  const pendingDrag = useRef<{ width: number; height: number } | null>(null)
  const scheduleDrag = (width: number, height: number): void => {
    pendingDrag.current = { width, height }
    if (dragFrame.current !== null) return
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = null
      const pending = pendingDrag.current
      if (pending !== null) {
        pendingDrag.current = null
        applyDrag(pending.width, pending.height)
      }
    })
  }

  /** Flush any pending drag write and stop scheduling (the store commit on
   *  pointer up applies the final clamped values). */
  const stopDragScheduling = (): void => {
    if (dragFrame.current !== null) {
      cancelAnimationFrame(dragFrame.current)
      dragFrame.current = null
    }
    pendingDrag.current = null
  }

  // The left panel drag is a write-only twin of the right panel's width drag:
  // it writes the panel width and --dsh-sidebar-left directly (batched to one
  // frame), committing the clamped size to the store once on release.
  const applyLeftDrag = (leftWidth: number): void => {
    leftRef.current?.style.setProperty('width', `${leftWidth}px`)
    document.documentElement.style.setProperty('--dsh-sidebar-left', `${leftWidth}px`)
  }
  const leftDragFrame = useRef<number | null>(null)
  const pendingLeftDrag = useRef<number | null>(null)
  const scheduleLeftDrag = (leftWidth: number): void => {
    pendingLeftDrag.current = leftWidth
    if (leftDragFrame.current !== null) return
    leftDragFrame.current = requestAnimationFrame(() => {
      leftDragFrame.current = null
      const pending = pendingLeftDrag.current
      if (pending !== null) {
        pendingLeftDrag.current = null
        applyLeftDrag(pending)
      }
    })
  }
  const stopLeftDragScheduling = (): void => {
    if (leftDragFrame.current !== null) {
      cancelAnimationFrame(leftDragFrame.current)
      leftDragFrame.current = null
    }
    pendingLeftDrag.current = null
  }

  // Layout push: the app shell gives up the panel's width/height while the
  // panels are open (0 while collapsed), so the conversation and input bar
  // are squeezed instead of covered. The margins are capped at the viewport
  // so a stale persisted size (e.g. fullscreen on a bigger window) can never
  // crush the app shell to zero. Dragging disables the layout transition.
  // On NARROW viewports the drawer FLOATS over the app shell — no push, the
  // conversation keeps the full width behind the drawer.
  useEffect(() => {
    const width = rightPanelEnabled && !narrow && snapshot.state?.panelOpen === true
      ? Math.min(snapshot.state.width, window.innerWidth)
      : 0
    const height = !narrow && snapshot.state?.bottomOpen === true
      ? Math.min(snapshot.state.bottomHeight, window.innerHeight)
      : 0
    const leftWidth = !narrow && snapshot.state?.leftOpen === true
      ? Math.min(snapshot.state.leftWidth, window.innerWidth)
      : 0
    document.documentElement.style.setProperty('--dsh-sidebar-width', `${width}px`)
    document.documentElement.style.setProperty('--dsh-sidebar-height', `${height}px`)
    document.documentElement.style.setProperty('--dsh-sidebar-left', `${leftWidth}px`)
  }, [narrow, rightPanelEnabled, snapshot.state?.panelOpen, snapshot.state?.width, snapshot.state?.leftOpen, snapshot.state?.leftWidth, snapshot.state?.bottomOpen, snapshot.state?.bottomHeight])
  useEffect(() => {
    if (anyDragging) document.body.setAttribute('data-dsh-sidebar-dragging', '')
    else document.body.removeAttribute('data-dsh-sidebar-dragging')
  }, [anyDragging])

  const actions: WorkbenchActions = useMemo(() => ({
    closeTab: (paneId, tabId) => {
      // A closed terminal releases its pty immediately — including when its
      // socket is mid-reconnect, where the unmount close frame never reaches
      // the host and the process would hold the quota until the grace ends.
      // Agent terminals (tabId `agent:<uuid>`) close through a different
      // host route: the WS close frame is the primary path (sent by
      // TerminalView on unmount), and the agent-pty.close HTTP route is the
      // fallback when the WS is down.
      const current = store.getSnapshot().state
      const leaf = current === undefined ? undefined : leafWithTab(current.splits, tabId)
      const tab = leaf?.tabs.find(candidate => candidate.id === tabId)
      store.reduce(s => closeTabAndMaybeCollapseRightSurface(s, paneId, tabId))
      if (tab?.type === 'terminal') {
        if (isAgentTabId(tabId)) {
          const uuid = agentUuidOf(tabId)
          void api.agentPtyClose(uuid).catch(() => { /* the host may already have released it */ })
        } else if (sessionId !== undefined) {
          void api.ptyClose({ sessionId, cwd }, tabId).catch(() => { /* the host may already have released it */ })
        }
      }
    },
    activateTab: (paneId, tabId) => {
      store.reduce(s => ({
        ...s,
        activePane: paneId,
        splits: mapLeaf(s.splits, paneId, (leaf) => {
          if (leaf.tabs.some(tab => tab.id === tabId)) leaf.active = tabId
        }),
      }))
    },
    focusPane: (paneId) => { store.reduce(s => ({ ...s, activePane: paneId })) },
    moveTabToEdge: (payload: TabDragPayload, toPane: string, zone: DropZone) => {
      store.reduce(s => moveTabToEdge(s, payload.paneId, payload.tabId, toPane, zone))
    },
    moveTabBefore: (payload: TabDragPayload, toPane: string, beforeTabId: string) => {
      store.reduce((s) => {
        let index = -1
        const source = leafWithTab(s.splits, beforeTabId)
        if (source !== undefined && source.id === toPane) {
          index = source.tabs.findIndex(tab => tab.id === beforeTabId)
        }
        return moveTab(s, payload.paneId, payload.tabId, toPane, index)
      })
    },
    resizeSplit: (splitId, index, deltaFrac) => {
      store.reduce(s => resizeSplitIn(s, splitId, index, deltaFrac))
    },
  }), [store, sessionId, cwd])

  /**
   * The explorer's @-reference button inserts an occurrence-backed inline
   * file/folder chip through dsh-file-edit. No literal `@path` is written, so
   * dsh-at-file does not create its separate attachment dock.
   */
  const referenceInChat = useCallback((path: string, isDir = false): void => {
    if (sessionId === undefined) return
    const normalized = path.replace(/[\\/]+$/, '')
    const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
    const displayName = slash === -1 ? normalized : normalized.slice(slash + 1)
    insertInlineFileReference(relativeTo(cwd ?? '', path), displayName, isDir ? 'folder' : 'file')
  }, [sessionId, cwd])

  if (state === undefined || sessionId === undefined) {
    return (
      <div className={css.toggleCluster}>
        {!narrow && (
          <Tooltip label={t('noSession')} side="bottom" delayMs={500}>
            <button type="button" className={css.toggleButton} disabled aria-label={t('noSession')}>
              <IconPanelBottomOutline16 />
            </button>
          </Tooltip>
        )}
      </div>
    )
  }

  const onNewTab = (optionId: string): void => {
    const service = ctx.betterSidebar
    const descriptor = service?.getTab(optionId)
    if (descriptor === undefined) return
    const title = typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title
    service.openTab({ type: optionId, title })
  }

  /** The tab icon from the tab-type registry (shared by every workbench). */
  const tabIconOf = (tab: SidebarTab): ReactNode => {
    const previewIcon = previewTabIcon(ctx.betterSidebar, tab, 14)
    if (previewIcon !== undefined) return previewIcon
    const descriptor = ctx.betterSidebar?.getTab(tab.type)
    if (descriptor === undefined) return null
    return typeof descriptor.icon === 'function' ? descriptor.icon(14) : descriptor.icon
  }

  /**
   * Render one tab's content. `active` (from the workbench) tells whether
   * this tab is the active one in its pane; combined with the panel's
   * open/closed state it gates live views (the Subagent topology pauses its
   * polling while the page is not actually visible). The pane id travels
   * with the tab so diff tabs can split below their source pane.
   */
  const renderTab = (tab: SidebarTab, active: boolean, paneId: string, bottom = false) => (
    <TabContent
      tab={tab}
      sessionId={sessionId}
      cwd={cwd}
      expanded={state.expanded}
      onToggleDir={(path) => { store.reduce(s => toggleExpanded(s, path)) }}
      onReferenceFile={referenceInChat}
      ctx={ctx}
      store={store}
      visible={bottom ? state.bottomOpen && active : rightPanelEnabled && state.panelOpen && active}
      onSubagentJump={(childSessionId) => { subagentJumpRef.current = childSessionId }}
      onOpenDiff={(diffTab) => { store.reduce(s => openDiffTab(s, paneId, diffTab)) }}
    />
  )

  const rightTree = rightSurfaceTree(state.splits)
  const browserTabOptions = buildNewTabOptions(state, ctx, { sessionId, cwd })
    .filter(option => option.id === 'browser')
  const nonBrowserTabOptions = buildNewTabOptions(state, ctx, { sessionId, cwd })
    .filter(option => option.id !== 'browser')

  return (
    <>
      {/*
        The persistent toggle cluster at the top-right corner: the bottom
        panel's button (bottom glyph) LEFT of the right panel's (side glyph).
        Always pinned to the viewport corner — inside the right panel's
        top-right while it is open, sitting flush in the tab strip whose
        right end it really squeezes (the strip reserves its width via CSS),
        so the tabs genuinely yield space to it.
      */}
      <div className={css.toggleCluster}>
        {!narrow && (
          <Tooltip label={state.leftOpen ? t('collapse') : t('expand')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.toggleButton}
              aria-label={state.leftOpen ? 'Collapse explorer' : 'Expand explorer'}
              onClick={() => { store.reduce(toggleLeftPanel) }}
            >
              <IconPanelLeftOutline16 />
            </button>
          </Tooltip>
        )}
        {/*
          Narrow viewports merge the two workbenches into the one drawer —
          there is no bottom panel, so its toggle button is not offered.
        */}
        {!narrow && (
          <Tooltip label={state.bottomOpen ? t('collapseBottomPanel') : t('expandBottomPanel')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.toggleButton}
              aria-label={state.bottomOpen ? t('collapseBottomPanel') : t('expandBottomPanel')}
              onClick={() => { store.reduce(toggleBottomPanel) }}
            >
              <IconPanelBottomOutline16 />
            </button>
          </Tooltip>
        )}
      </div>
      {/* Explorer and right-surface visibility share the packaged app's
          titlebar control area. */}
      <div className={css.titlebarToggles}>
        {!narrow && ctx.betterSidebar?.isTabEnabled('explorer') !== false && (
          <div className={css.desktopExplorerToggle}>
            <Tooltip label={state.leftOpen ? t('collapse') : t('expand')} side="bottom" delayMs={500}>
              <button
                type="button"
                className={css.toggleButton}
                aria-label={state.leftOpen ? 'Collapse explorer' : 'Expand explorer'}
                aria-pressed={state.leftOpen}
                onClick={() => { store.reduce(toggleLeftPanel) }}
              >
                <IconPanelLeftOutline16 />
              </button>
            </Tooltip>
          </div>
        )}
        {rightPanelEnabled && (
          <Tooltip label={state.panelOpen ? t('closeContentPanel') : t('openContentPanel')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.toggleButton}
              aria-label={state.panelOpen ? t('closeContentPanel') : t('openContentPanel')}
              aria-pressed={state.panelOpen}
              onClick={() => { store.reduce(togglePanel) }}
            >
              <IconPanelRightOutline16 />
            </button>
          </Tooltip>
        )}
      </div>
      {/*
        The left panel (dedicated explorer dock): fixed between the app's own
        session-list sidebar and the center column. Its inline `left` is the
        measured session-list column's right edge — a STABLE value (the
        session list never moves when the center column gets its margin-left
        push), so the panel slides purely via transform and stays in sync with
        the center column's push. Not rendered on narrow viewports, nor before
        the first measurement (avoiding a flash at left:0).
      */}
      {!narrow && sessionListRight !== null && ctx.betterSidebar?.isTabEnabled('explorer') !== false && (
        <div
          ref={leftRef}
          className={clsx(css.leftPanel, !state.leftOpen && css.leftPanelHidden)}
          style={{ left: sessionListRight, width: state.leftWidth }}
          data-dragging={draggingLeft || undefined}
        >
          <div
            className={clsx(css.leftResize, draggingLeft && css.leftResizeActive)}
            onPointerDown={(event) => {
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              leftDrag.current = { startX: event.clientX, startWidth: state.leftWidth }
              setDraggingLeft(true)
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
              const { startX, startWidth } = leftDrag.current
              scheduleLeftDrag(clampLeftWidth(startWidth + (event.clientX - startX)))
            }}
            onPointerUp={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
              event.currentTarget.releasePointerCapture(event.pointerId)
              const { startX, startWidth } = leftDrag.current
              stopLeftDragScheduling()
              store.reduce(s => setLeftWidth(s, startWidth + (event.clientX - startX)))
              setDraggingLeft(false)
            }}
          />
          <div className={css.panelBody}>
            <ExplorerView
              startupTasks={startupTaskLane(ctx)}
              sessionId={sessionId}
              cwd={cwd}
              expanded={state.expanded}
              onToggle={(path) => { store.reduce(s => toggleExpanded(s, path)) }}
              onRevealPath={(path, isDir) => { store.reduce(s => revealPathInState(s, cwd, path, isDir)) }}
              onCollapseAll={() => { store.reduce(collapseAllFoldersInState) }}
              onOpenFile={(path) => { openSidebarFile(ctx, store, sessionId, path, cwd) }}
              onReferenceFile={referenceInChat}
              onOpenInBrowser={browserEnabled ? (path) => { openHtmlInBrowser(ctx, sessionId, path, cwd) } : undefined}
              onRenamed={(from, to) => { synchronizeRenamedPath(store, cwd, from, to) }}
              onDeleted={(path) => { synchronizeDeletedPath(store, cwd, path) }}
            />
          </div>
        </div>
      )}
      {/*
        The right panel stays mounted while collapsed (hidden off-screen) so
        the slide in/out can animate; visibility hides it after the slide
        settles. Its bottom edge follows the bottom panel's height (0 while
        the bottom panel is closed) — the VSCode-style "sidebar above panel".
        On NARROW viewports it is a full-width drawer holding both
        workbenches (see MobileWorkbench); the width drag strip is not
        offered there — a full-screen sheet has nothing to drag.
      */}
      {rightPanelEnabled && <div
        ref={panelRef}
        className={clsx(css.panel, !state.panelOpen && css.panelHidden)}
        style={{ width: narrow ? '100vw' : Math.min(state.width, window.innerWidth) }}
        data-dragging={anyDragging || undefined}
      >
          {!narrow && (
            <div
              className={css.panelResize}
              onPointerDown={(event) => {
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
                widthDrag.current = { startX: event.clientX, startWidth: state.width }
                setDraggingWidth(true)
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                const { startX, startWidth } = widthDrag.current
                const width = clampWidth(startWidth + (startX - event.clientX))
                const height = state.bottomOpen ? Math.min(state.bottomHeight, window.innerHeight) : 0
                scheduleDrag(width, height)
              }}
              onPointerUp={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                event.currentTarget.releasePointerCapture(event.pointerId)
                const { startX, startWidth } = widthDrag.current
                stopDragScheduling()
                store.reduce(s => setWidth(s, startWidth + (startX - event.clientX)))
                setDraggingWidth(false)
              }}
              onPointerCancel={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId)
                }
                stopDragScheduling()
                const width = Math.min(state.width, window.innerWidth)
                const height = state.bottomOpen ? Math.min(state.bottomHeight, window.innerHeight) : 0
                applyDrag(width, height)
                setDraggingWidth(false)
              }}
              onLostPointerCapture={() => { setDraggingWidth(false) }}
            />
          )}
        <div className={css.panelBody}>
          <Workbench
            state={state}
            tree={rightTree}
            newTabOptions={browserTabOptions}
            actions={actions}
            onNewTab={onNewTab}
            renderTab={renderTab}
            getTabIcon={tabIconOf}
          />
        </div>
      </div>}
      {/*
        The bottom panel: a second, independent workbench. It squeezes ONLY
        the center column (the agent output area): it starts at the app
        shell's own left sidebar and ends at the right panel's left edge —
        neither sidebar gives up any position (the right panel keeps its
        full height). Its resize strip is the top edge; hidden by sliding
        down like the right panel. On NARROW viewports it does not exist —
        the bottom workbench lives inside the drawer (MobileWorkbench).
      */}
      {!narrow && (
      <div
        ref={bottomRef}
        className={clsx(css.bottomPanel, !state.bottomOpen && css.bottomPanelHidden)}
        style={{
          height: Math.min(state.bottomHeight, window.innerHeight),
          left: centerRect.left,
          // Direct from the center column's measured right edge: the bottom
          // panel spans ONLY the center column, ending exactly at the
          // details column's left edge (the details column sits between the
          // center and the right panel, and the right panel's margin-right
          // push is already baked into centerRect.right).
          right: window.innerWidth - centerRect.right,
          // The seam against the open right panel needs its own hairline
          // (the right panel's border-left alone is covered by this panel's
          // fill — without it the corner looks cut off).
          borderRight: rightPanelEnabled && state.panelOpen ? '1px solid var(--dsw-alias-border-l2)' : undefined,
        }}
        data-dragging={(draggingBottom || draggingCorner) || undefined}
      >
        <div
          className={clsx(css.bottomResize, draggingBottom && css.bottomResizeActive)}
          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            bottomDrag.current = { startY: event.clientY, startHeight: state.bottomHeight }
            setDraggingBottom(true)
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            const { startY, startHeight } = bottomDrag.current
            const height = clampHeight(startHeight + (startY - event.clientY))
            scheduleDrag(Math.min(state.width, window.innerWidth), height)
          }}
          onPointerUp={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            event.currentTarget.releasePointerCapture(event.pointerId)
            const { startY, startHeight } = bottomDrag.current
            stopDragScheduling()
            store.reduce(s => setBottomHeight(s, startHeight + (startY - event.clientY)))
            setDraggingBottom(false)
          }}
        />
        {/*
          The bottom panel's own close control at its tab strip's right end
          (the strip reserves the width via CSS so the + menu never hides
          under it): one tap collapses the panel.
        */}
        <Tooltip label={t('collapseBottomPanel')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.bottomClose}
            aria-label={t('collapseBottomPanel')}
            onClick={() => { store.reduce(toggleBottomPanel) }}
          >
            <IconCloseFill14 />
          </button>
        </Tooltip>
        <div className={css.panelBody}>
          <Workbench
            state={state}
            tree={state.bottomSplits}
            newTabOptions={nonBrowserTabOptions}
            actions={actions}
            onNewTab={onNewTab}
            renderTab={(tab, active, paneId) => renderTab(tab, active, paneId, true)}
            getTabIcon={tabIconOf}
          />
        </div>
      </div>
      )}
      {/*
        The shared corner (only while BOTH panels are open): the intersection
        of the right panel's left edge and the bottom panel's top edge.
        Horizontal drags resize the right panel's width, vertical drags the
        bottom panel's height — the two panels drag against each other.
        (Never on narrow viewports: the bottom panel does not exist there.)
      */}
      {rightPanelEnabled && !narrow && state.panelOpen && state.bottomOpen && (
        <div
          ref={cornerRef}
          className={css.cornerHandle}
          style={{
            left: window.innerWidth - state.width - 6,
            top: window.innerHeight - state.bottomHeight - 6,
          }}
          data-dragging={draggingCorner || undefined}
          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            cornerDrag.current = {
              startX: event.clientX,
              startY: event.clientY,
              startWidth: state.width,
              startHeight: state.bottomHeight,
            }
            setDraggingCorner(true)
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            const { startX, startY, startWidth, startHeight } = cornerDrag.current
            const width = clampWidth(startWidth + (startX - event.clientX))
            const height = clampHeight(startHeight + (startY - event.clientY))
            scheduleDrag(width, height)
          }}
          onPointerUp={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            event.currentTarget.releasePointerCapture(event.pointerId)
            const { startX, startY, startWidth, startHeight } = cornerDrag.current
            stopDragScheduling()
            store.reduce(s => setBottomHeight(setWidth(s, startWidth + (startX - event.clientX)), startHeight + (startY - event.clientY)))
            setDraggingCorner(false)
          }}
        />
      )}
    </>
  )
}
