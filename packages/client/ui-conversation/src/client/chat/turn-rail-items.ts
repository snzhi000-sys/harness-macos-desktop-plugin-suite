import type {} from '@deepseek-ai/dsh-session-turn-outline/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

/** One whole-log navigation mark with either a rendered key or a paging target. */
export interface TurnRailItem {
  readonly turn: number
  readonly prompt: string
  readonly response: string
  readonly status: 'open' | 'closed'
  readonly anchor:
    | { readonly kind: 'loaded'; readonly key: string }
    | { readonly kind: 'unloaded'; readonly seq: number }
}

const EMPTY: readonly TurnRailItem[] = []

/**
 * Merge the host outline with stable keys from the currently loaded Chat window.
 * @param outline - untrusted projection value received from the Host.
 * @param locations - stable loaded-window Chat location index.
 * @returns bounded marks in Host projection order.
 */
export function turnRailItems(
  outline: unknown,
  locations: ChatSnapshot['locations'],
): readonly TurnRailItem[] {
  if (typeof outline !== 'object' || outline === null) return EMPTY
  const rawTurns = (outline as { turns?: unknown }).turns
  if (!Array.isArray(rawTurns)) return EMPTY
  const result: TurnRailItem[] = []
  for (const raw of rawTurns) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    if (!Number.isSafeInteger(entry.turn) || (entry.turn as number) < 0) continue
    if (!Number.isSafeInteger(entry.seq) || (entry.seq as number) < 0) continue
    const turn = entry.turn as number
    const key = locations.getTurn(turn)[0]
    result.push({
      turn,
      prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
      response: typeof entry.response === 'string' ? entry.response : '',
      status: entry.status === 'closed' ? 'closed' : 'open',
      anchor: key === undefined
        ? { kind: 'unloaded', seq: entry.seq as number }
        : { kind: 'loaded', key },
    })
  }
  return result.length === 0 ? EMPTY : result
}
