import { describe, expect, it } from 'vitest'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { turnRailItems } from '../src/client/chat/turn-rail-items.ts'

function locations(entries: Record<number, readonly string[]>): ChatSnapshot['locations'] {
  return {
    getTurn: turn => entries[turn] ?? [],
    getStep: () => [],
  }
}

describe('whole-log turn rail items', () => {
  it('keeps unloaded turns lightweight and upgrades loaded turns to stable keys', () => {
    const items = turnRailItems({ turns: [
      { turn: 1, seq: 0, prompt: 'first', response: 'done', status: 'closed' },
      { turn: 2, seq: 8, prompt: 'second', response: '', status: 'open' },
    ] }, locations({ 2: ['turn-2-user'] }))
    expect(items).toEqual([
      {
        turn: 1,
        prompt: 'first',
        response: 'done',
        status: 'closed',
        anchor: { kind: 'unloaded', seq: 0 },
      },
      {
        turn: 2,
        prompt: 'second',
        response: '',
        status: 'open',
        anchor: { kind: 'loaded', key: 'turn-2-user' },
      },
    ])
  })

  it('drops malformed load-bearing entries and degrades decorative fields', () => {
    expect(turnRailItems({ turns: [
      { turn: '1', seq: 0 },
      { turn: 2, seq: 8, prompt: 42, response: null, status: 'broken' },
    ] }, locations({}))).toEqual([{
      turn: 2,
      prompt: '',
      response: '',
      status: 'open',
      anchor: { kind: 'unloaded', seq: 8 },
    }])
  })
})
