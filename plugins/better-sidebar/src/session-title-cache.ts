import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Read Harness' durable session-title projection for cold list rows.
 * A missing or partially-written cache is non-fatal: the client can still use
 * its normal cwd/session-id fallback until the session is opened.
 */
export async function readPersistedSessionTitles(dshHome: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(join(dshHome, 'storages', 'session_projcache.json'), 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const tables = (parsed as Record<string, unknown>).tables
    if (tables === null || typeof tables !== 'object' || Array.isArray(tables)) return {}
    const sessions = (tables as Record<string, unknown>).sessions
    if (sessions === null || typeof sessions !== 'object' || Array.isArray(sessions)) return {}

    const titles: Record<string, string> = {}
    for (const [sessionId, candidate] of Object.entries(sessions as Record<string, unknown>)) {
      if (sessionId.trim() === '' || candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const rows = (candidate as Record<string, unknown>).rows
      if (rows === null || typeof rows !== 'object' || Array.isArray(rows)) continue
      const title = (rows as Record<string, unknown>).title
      if (title === null || typeof title !== 'object' || Array.isArray(title)) continue
      const value = (title as Record<string, unknown>).val
      if (typeof value !== 'string' || value.trim() === '') continue
      titles[sessionId] = value.trim()
    }
    return titles
  } catch {
    return {}
  }
}
