import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

interface PersistedLayout {
  state: unknown
  updatedAt: number
}

interface LayoutFile {
  version: 1
  sessions: Record<string, PersistedLayout>
}

const MAX_SESSION_ID_LENGTH = 512
const MAX_LAYOUT_BYTES = 900 * 1024
const MAX_SESSIONS = 2048

function validSessionId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(value)
}

function cloneLayout(value: unknown): unknown {
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_LAYOUT_BYTES) {
    throw new Error('sidebar layout is too large')
  }
  return JSON.parse(encoded) as unknown
}

/** Host-owned per-session layout state, independent of the random Web origin. */
export class SidebarLayoutStore {
  private state: LayoutFile | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  private async load(): Promise<LayoutFile> {
    if (this.state !== undefined) return this.state
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      const record = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
      const rawSessions = record.sessions !== null && typeof record.sessions === 'object'
        ? record.sessions as Record<string, unknown>
        : {}
      const sessions: Record<string, PersistedLayout> = {}
      for (const [sessionId, candidate] of Object.entries(rawSessions)) {
        if (!validSessionId(sessionId) || candidate === null || typeof candidate !== 'object') continue
        const layout = candidate as Record<string, unknown>
        if (typeof layout.updatedAt !== 'number' || !Number.isFinite(layout.updatedAt) || layout.state === undefined) continue
        try {
          sessions[sessionId] = { state: cloneLayout(layout.state), updatedAt: layout.updatedAt }
        } catch {
          // Oversized or unserializable persisted entries are ignored.
        }
      }
      this.state = { version: 1, sessions }
    } catch {
      this.state = { version: 1, sessions: {} }
    }
    return this.state
  }

  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => { /* allow a later save to retry */ }).then(async () => {
      const state = await this.load()
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${String(process.pid)}.tmp`
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.path)
    })
    return this.writeQueue
  }

  async get(sessionId: string): Promise<unknown | undefined> {
    if (!validSessionId(sessionId)) return undefined
    return (await this.load()).sessions[sessionId]?.state
  }

  async set(sessionId: string, value: unknown): Promise<void> {
    if (!validSessionId(sessionId)) throw new Error('invalid session id')
    const state = await this.load()
    state.sessions[sessionId] = { state: cloneLayout(value), updatedAt: Date.now() }

    const entries = Object.entries(state.sessions)
    if (entries.length > MAX_SESSIONS) {
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      state.sessions = Object.fromEntries(entries.slice(0, MAX_SESSIONS))
    }
    await this.persist()
  }
}
