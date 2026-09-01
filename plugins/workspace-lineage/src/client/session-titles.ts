import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'

export function decodePersistedTitles(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const response = value as Record<string, unknown>
  const payload = response.value !== null && typeof response.value === 'object' && !Array.isArray(response.value)
    ? response.value as Record<string, unknown>
    : response
  const titles = payload.titles
  if (titles === null || typeof titles !== 'object' || Array.isArray(titles)) return {}
  const result: Record<string, string> = {}
  for (const [sessionId, title] of Object.entries(titles as Record<string, unknown>)) {
    if (sessionId.trim() !== '' && typeof title === 'string' && title.trim() !== '') {
      result[sessionId] = title.trim()
    }
  }
  return result
}

/** Fill cold list rows from Harness' durable title projection without replacing a live title. */
export function overlayPersistedTitles(
  raw: SessionListState,
  titles: Readonly<Record<string, string>>,
): SessionListState {
  let byId: SessionListState['byId'] | undefined
  for (const [id, title] of Object.entries(titles)) {
    const session = raw.byId[id as SessionId]
    if (session === undefined || session.title !== undefined) continue
    byId ??= { ...raw.byId }
    byId[id as SessionId] = { ...session, title, displayTitle: title }
  }
  return byId === undefined ? raw : { ...raw, byId }
}
