/**
 * Pure derivation of one turn's produced files from finalized conversation
 * nodes — a structural replica of ui-deliverables' `producedForClosing`
 * (the mutation tools' follow-along `locations`, by render intent: a diff
 * card or a generic edit card; reads/deletes/failures produce nothing).
 * Kept dependency-free so the takeover logic is unit-testable and the
 * replica is easy to diff against upstream when it drifts.
 */

/** Paths a tool-result view reports as produced, by render intent. */
export function producedPaths(view: unknown): readonly string[] {
  if (view === null || typeof view !== 'object') return []
  const record = view as { card?: unknown; kind?: unknown; locations?: unknown }
  const isEdit = record.card === 'diff' || (record.card === 'generic' && record.kind === 'edit')
  if (!isEdit) return []
  if (!Array.isArray(record.locations)) return []
  const paths: string[] = []
  for (const location of record.locations) {
    if (location !== null && typeof location === 'object' && typeof (location as { path?: unknown }).path === 'string') {
      paths.push((location as { path: string }).path)
    }
  }
  return paths
}

/**
 * Files produced by the turn the assistant at `seq` closes. Accumulation
 * resets on turn boundaries (a user message, or a node reporting a different
 * turn number); paths keep first-seen order and appear once.
 * @param nodes - snapshot nodes in surface order (structural, unknown-safe).
 * @param seq - the closing assistant's seq (the render site's anchor).
 * @returns produced paths; empty when the turn wrote nothing.
 */
export function producedForClosing(nodes: readonly unknown[], seq: number): readonly string[] {
  let pending: string[] = []
  let seen = new Set<string>()
  let turn: number | undefined
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    const record = node as { kind?: unknown; isError?: unknown; callView?: unknown; turn?: unknown; seq?: unknown }
    if (record.kind === 'tool-result') {
      if (record.isError === true) continue
      for (const path of producedPaths(record.callView)) {
        if (seen.has(path)) continue
        seen.add(path)
        pending.push(path)
      }
      continue
    }
    if (record.kind === 'user') {
      turn = undefined
      pending = []
      seen = new Set()
    } else if (typeof record.turn === 'number') {
      if (turn !== undefined && record.turn !== turn) {
        pending = []
        seen = new Set()
      }
      turn = record.turn
    }
    if (record.kind === 'assistant' && record.seq === seq) return pending
  }
  return []
}

/** Read the current Harness deliverables vocabulary published on Turn.data. */
export function producedFromTurnData(data: unknown, seq: number): readonly string[] {
  if (data === null || typeof data !== 'object') return []
  const produced = (data as { produced?: unknown }).produced
  if (!Array.isArray(produced)) return []
  const paths: string[] = []
  const seen = new Set<string>()
  for (const item of produced) {
    if (item === null || typeof item !== 'object') continue
    const record = item as { path?: unknown; seq?: unknown }
    if (typeof record.path !== 'string') continue
    if (typeof record.seq === 'number' && record.seq > seq) continue
    if (seen.has(record.path)) continue
    seen.add(record.path)
    paths.push(record.path)
  }
  return paths
}

/**
 * Claim the turn-tail chain only when the closing turn produced files.
 * @param owner - the turn-tail owner currency ({nodes, seq}).
 * @returns produced paths as the matched value, or null to decline.
 */
export function selectProducedFiles(owner: unknown): readonly string[] | null {
  const record = owner as { nodes?: unknown; seq?: unknown } | null
  if (record === null || typeof record !== 'object') return null
  if (typeof record.seq !== 'number') return null
  // Current Harness publishes immutable deliverables on the closing Turn.
  // Keep the legacy node walk for rolling desktop/plugin updates.
  const modern = record as unknown as { turn?: { data?: { get?: (key: string) => unknown } } }
  let paths: readonly string[] = []
  try {
    const get = modern.turn?.data?.get
    if (typeof get === 'function') paths = producedFromTurnData(get.call(modern.turn?.data, 'deliverables'), record.seq)
  } catch {}
  if (paths.length === 0 && Array.isArray(record.nodes)) paths = producedForClosing(record.nodes, record.seq)
  return paths.length === 0 ? null : paths
}

/** Resolve a (possibly relative) path against the session cwd for the sidebar. */
export function resolveSidebarPath(cwd: string | undefined, path: string): string {
  const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
  if (absolute) return path
  const base = cwd ?? ''
  if (base === '') return path
  const separator = base.includes('\\') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${separator}${path}`
}
