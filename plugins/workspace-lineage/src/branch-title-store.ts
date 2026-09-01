import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Durable custom display titles for lineage branches, keyed by Session id. */
export class BranchTitleStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  /** Read every valid custom branch title; missing or damaged state degrades to no overrides. */
  async get(): Promise<Record<string, string>> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
      const titles = (value as Record<string, unknown>)['titles']
      if (titles === null || typeof titles !== 'object' || Array.isArray(titles)) return {}
      const result: Record<string, string> = {}
      for (const [sessionId, title] of Object.entries(titles as Record<string, unknown>)) {
        if (sessionId.trim() !== '' && typeof title === 'string' && title.trim() !== '') {
          result[sessionId] = title.trim()
        }
      }
      return result
    } catch {
      return {}
    }
  }

  /** Persist one user-confirmed branch title without replacing unrelated entries. */
  async set(sessionId: string, title: string): Promise<Record<string, string>> {
    const normalizedId = sessionId.trim()
    const normalizedTitle = title.trim()
    if (normalizedId === '') throw new TypeError('sessionId must not be empty')
    if (normalizedTitle === '') throw new TypeError('title must not be empty')
    let result: Record<string, string> = {}
    const operation = this.writeQueue.then(async () => {
      result = { ...await this.get(), [normalizedId]: normalizedTitle }
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${String(process.pid)}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, titles: result }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await rename(temporary, this.path)
    })
    this.writeQueue = operation.catch(() => {})
    await operation
    return result
  }
}
