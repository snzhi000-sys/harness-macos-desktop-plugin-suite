import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isWithin, requireAbsolute } from './fs-tree.ts'

export interface ExplorerUncommonPathRecord {
  path: string
  isDir: boolean
}

export interface ExplorerVisibilityRecord {
  paths: ExplorerUncommonPathRecord[]
  hideUncommon: boolean
}

export type ExplorerVisibilityMutation =
  | { kind: 'set-hidden'; hidden: boolean }
  | { kind: 'toggle-path'; path: string; isDir: boolean }
  | { kind: 'rename-path'; from: string; to: string }
  | { kind: 'delete-path'; path: string }

interface VisibilityFile {
  version: 1
  workspaces: Record<string, ExplorerVisibilityRecord>
}

const MAX_UNCOMMON_PATHS = 2048

/** Strictly validate one workspace's untrusted uncommon-path list. */
export function sanitizeExplorerUncommonPaths(rootValue: string, value: unknown): ExplorerUncommonPathRecord[] {
  const root = requireAbsolute(rootValue)
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const paths: ExplorerUncommonPathRecord[] = []
  for (const candidate of value) {
    if (paths.length >= MAX_UNCOMMON_PATHS) break
    if (candidate === null || typeof candidate !== 'object') continue
    const record = candidate as Record<string, unknown>
    if (typeof record.path !== 'string') continue
    let path
    try { path = requireAbsolute(record.path) } catch { continue }
    if (path === root || !isWithin(root, path) || seen.has(path)) continue
    seen.add(path)
    paths.push({ path, isDir: record.isDir === true })
  }
  return paths
}

function sanitizeVisibility(root: string, value: unknown): ExplorerVisibilityRecord {
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    paths: sanitizeExplorerUncommonPaths(root, record.paths),
    hideUncommon: record.hideUncommon === true,
  }
}

/** Host-owned workspace visibility state, independent of the random Web origin. */
export class ExplorerVisibilityStore {
  private state: VisibilityFile | undefined
  private writeQueue: Promise<void> = Promise.resolve()
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  private async load(): Promise<VisibilityFile> {
    if (this.state !== undefined) return this.state
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      const record = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
      const rawWorkspaces = record.workspaces !== null && typeof record.workspaces === 'object'
        ? record.workspaces as Record<string, unknown>
        : {}
      const workspaces: Record<string, ExplorerVisibilityRecord> = {}
      for (const [root, visibility] of Object.entries(rawWorkspaces)) {
        try { workspaces[requireAbsolute(root)] = sanitizeVisibility(root, visibility) } catch { /* invalid root */ }
      }
      this.state = { version: 1, workspaces }
    } catch {
      this.state = { version: 1, workspaces: {} }
    }
    return this.state
  }

  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => { /* allow a later write to retry */ }).then(async () => {
      const state = await this.load()
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${String(process.pid)}.tmp`
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.path)
    })
    return this.writeQueue
  }

  async get(rootValue: string): Promise<ExplorerVisibilityRecord> {
    const root = requireAbsolute(rootValue)
    const state = await this.load()
    const stored = sanitizeVisibility(root, state.workspaces[root])
    const existing: ExplorerUncommonPathRecord[] = []
    for (const entry of stored.paths) {
      const info = await lstat(entry.path).catch(() => undefined)
      if (info === undefined) continue
      existing.push({ path: entry.path, isDir: info.isDirectory() })
    }
    const current = { paths: existing, hideUncommon: stored.hideUncommon }
    if (JSON.stringify(current) !== JSON.stringify(state.workspaces[root] ?? { paths: [], hideUncommon: false })) {
      state.workspaces[root] = current
      await this.persist()
    }
    return current
  }

  /** Return persisted intent without touching every marked filesystem path. */
  async snapshot(rootValue: string): Promise<ExplorerVisibilityRecord> {
    const root = requireAbsolute(rootValue)
    const state = await this.load()
    return sanitizeVisibility(root, state.workspaces[root])
  }

  async set(rootValue: string, value: unknown): Promise<ExplorerVisibilityRecord> {
    const root = requireAbsolute(rootValue)
    const state = await this.load()
    const clean = sanitizeVisibility(root, value)
    state.workspaces[root] = clean
    await this.persist()
    return clean
  }

  /**
   * Apply one user intent to the Host-authoritative workspace record. Unlike
   * replacing the complete record, this cannot erase restored paths when a
   * newly mounted Explorer is still holding its empty pre-hydration state.
   */
  update(rootValue: string, value: unknown): Promise<ExplorerVisibilityRecord> {
    const run = async (): Promise<ExplorerVisibilityRecord> => {
      const root = requireAbsolute(rootValue)
      const state = await this.load()
      const current = sanitizeVisibility(root, state.workspaces[root])
      const mutation = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
      let next = current

      if (mutation.kind === 'set-hidden') {
        next = { ...current, hideUncommon: mutation.hidden === true }
      } else if (mutation.kind === 'toggle-path') {
        const path = requireAbsolute(String(mutation.path ?? ''))
        if (path === root || !isWithin(root, path)) throw new Error('uncommon path must be inside workspace')
        next = {
          ...current,
          paths: current.paths.some(entry => entry.path === path)
            ? current.paths.filter(entry => entry.path !== path)
            : [...current.paths, { path, isDir: mutation.isDir === true }],
        }
      } else if (mutation.kind === 'rename-path') {
        const from = requireAbsolute(String(mutation.from ?? ''))
        const to = requireAbsolute(String(mutation.to ?? ''))
        if (from === root || !isWithin(root, from) || to === root || !isWithin(root, to)) {
          throw new Error('renamed uncommon path must be inside workspace')
        }
        next = {
          ...current,
          paths: sanitizeExplorerUncommonPaths(root, current.paths.map(entry => ({
            ...entry,
            path: entry.path === from || isWithin(from, entry.path)
              ? `${to}${entry.path.slice(from.length)}`
              : entry.path,
          }))),
        }
      } else if (mutation.kind === 'delete-path') {
        const path = requireAbsolute(String(mutation.path ?? ''))
        if (path === root || !isWithin(root, path)) throw new Error('deleted uncommon path must be inside workspace')
        next = {
          ...current,
          paths: current.paths.filter(entry => entry.path !== path && !isWithin(path, entry.path)),
        }
      } else {
        throw new Error('invalid Explorer visibility mutation')
      }

      const clean = sanitizeVisibility(root, next)
      state.workspaces[root] = clean
      await this.persist()
      return clean
    }

    const result = this.mutationQueue.then(run, run)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }
}
