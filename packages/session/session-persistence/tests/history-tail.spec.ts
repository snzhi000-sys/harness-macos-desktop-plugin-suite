import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { historyTailOf, type SessionInspection } from '../src/index.ts'

const meta = {
  id: 'history-tail' as never,
  version: 0,
  createdAt: 1,
  cwd: '/work',
} satisfies SessionHeader

function event(type: string, seq: number, surfaceOp?: 'append' | 'replace'): SessionEvent {
  return {
    type,
    seq,
    time: seq,
    data: {},
    ...surfaceOp === undefined ? {} : { surfaceOp },
  } as unknown as SessionEvent
}

describe('historyTailOf', () => {
  it('cuts at append-origin message boundaries and excludes replacement copies from the quota', () => {
    const inspection: SessionInspection = {
      meta,
      events: [
        event('turn/start', 0),
        event('user/message', 1, 'append'),
        event('assistant/message', 2, 'replace'),
        event('assistant/message', 3, 'append'),
        event('turn/end', 4),
        event('turn/start', 5),
        event('user/message', 6, 'append'),
        event('turn/end', 7),
      ],
    }

    const tail = historyTailOf(inspection, 2)

    expect(tail.events.map(candidate => candidate.seq)).toEqual([3, 4, 5, 6, 7])
    expect(tail.hasMore).toBe(true)
    expect(tail.asOfSeq).toBe(7)
  })

  it('retains the latest preset selection outside the visible contiguous tail', () => {
    const selected = {
      type: 'agent-preset/selected',
      seq: 0,
      time: 0,
      data: { agentPreset: 'minimal' },
    } as unknown as SessionEvent
    const inspection: SessionInspection = {
      meta,
      events: [selected, event('user/message', 1, 'append'), event('assistant/message', 2, 'append')],
    }

    const tail = historyTailOf(inspection, 1)

    expect(tail.events.map(candidate => candidate.seq)).toEqual([2])
    expect(tail.contextEvents).toEqual([selected])
  })

  it('rejects invalid limits at the persistence boundary', () => {
    expect(() => historyTailOf({ meta, events: [] }, 0)).toThrow(/positive safe integer/)
    expect(() => historyTailOf({ meta, events: [] }, 1.5)).toThrow(/positive safe integer/)
  })
})
