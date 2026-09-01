import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isWithin, requireAbsolute } from './fs-tree.ts'

export const EXPLORER_MARK_EMOJIS = ['🍿', '🍔', '🍟', '🍄', '🚗', '🍎'] as const
export type ExplorerMarkEmoji = typeof EXPLORER_MARK_EMOJIS[number]

export interface ExplorerMarkRecord {
  path: string
  emoji: ExplorerMarkEmoji
  isDir: boolean
}

interface MarksFile {
  version: 1
  workspaces: Record<string, ExplorerMarkRecord[]>
}

function emojiOf(value: unknown): ExplorerMarkEmoji | undefined {
  if (value === '🌟') return '🍿'
  if (value === '📌') return '🍎'
  return EXPLORER_MARK_EMOJIS.includes(value as ExplorerMarkEmoji) ? value as ExplorerMarkEmoji : undefined
}

/** Strictly validate one workspace's untrusted JSON/API marker list. */
export function sanitizeExplorerMarks(rootValue: string, value: unknown): ExplorerMarkRecord[] {
  const root = requireAbsolute(rootValue)
  if (!Array.isArray(value)) return []
  const emojis = new Set<ExplorerMarkEmoji>()
  const paths = new Set<string>()
  const marks: ExplorerMarkRecord[] = []
  for (const candidate of value) {
    if (marks.length >= EXPLORER_MARK_EMOJIS.length) break
    if (candidate === null || typeof candidate !== 'object') continue
    const record = candidate as Record<string, unknown>
    if (typeof record.path !== 'string') continue
    let path
    try { path = requireAbsolute(record.path) } catch { continue }
    const emoji = emojiOf(record.emoji)
    if (emoji === undefined || path === root || !isWithin(root, path)) continue
    if (emojis.has(emoji) || paths.has(path)) continue
    emojis.add(emoji)
    paths.add(path)
    marks.push({ path, emoji, isDir: record.isDir !== false })
  }
  return EXPLORER_MARK_EMOJIS.flatMap(emoji => marks.find(mark => mark.emoji === emoji) ?? [])
}

/** Host-owned persistence unaffected by the web server's random port/origin. */
export class ExplorerMarksStore {
  private state: MarksFile | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  private async load(): Promise<MarksFile> {
    if (this.state !== undefined) return this.state
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      const record = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
      const rawWorkspaces = record.workspaces !== null && typeof record.workspaces === 'object'
        ? record.workspaces as Record<string, unknown>
        : {}
      const workspaces: Record<string, ExplorerMarkRecord[]> = {}
      for (const [root, marks] of Object.entries(rawWorkspaces)) {
        try { workspaces[requireAbsolute(root)] = sanitizeExplorerMarks(root, marks) } catch { /* invalid root */ }
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

  async get(rootValue: string): Promise<{ marks: ExplorerMarkRecord[]; initialized: boolean }> {
    const root = requireAbsolute(rootValue)
    const state = await this.load()
    const initialized = Object.prototype.hasOwnProperty.call(state.workspaces, root)
    const stored = sanitizeExplorerMarks(root, state.workspaces[root] ?? [])
    const existing: ExplorerMarkRecord[] = []
    for (const mark of stored) {
      const info = await lstat(mark.path).catch(() => undefined)
      if (info === undefined) continue
      existing.push({ ...mark, isDir: info.isDirectory() })
    }
    if (JSON.stringify(existing) !== JSON.stringify(state.workspaces[root] ?? [])) {
      state.workspaces[root] = existing
      await this.persist()
    }
    return { marks: existing, initialized }
  }

  async set(rootValue: string, value: unknown): Promise<ExplorerMarkRecord[]> {
    const root = requireAbsolute(rootValue)
    const state = await this.load()
    const clean = sanitizeExplorerMarks(root, value)
    state.workspaces[root] = clean
    await this.persist()
    return clean
  }
}
