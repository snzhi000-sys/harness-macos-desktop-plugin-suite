import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as TurnOutlinePlugin from '@deepseek-ai/dsh-session-turn-outline'
import {
  TURN_OUTLINE_PREVIEW_LIMIT,
  turnOutlineProjectionDefinition as definition,
} from '../src/projection.ts'

function at<T extends SessionEvent['type']>(
  seq: number,
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
): Extract<SessionEvent, { type: T }> {
  return { seq, time: 1_700_000_000_000 + seq, type, data } as Extract<SessionEvent, { type: T }>
}

describe('turn outline projection', () => {
  it('removes its projection key when the plugin fiber unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create(SessionId('hmr'))
    expect('turnOutline' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    const fiber = await ctx.plugin(TurnOutlinePlugin)
    session.append('turn/start', { turn: 1 })
    expect(ctx.sessionProjections.snapshot(session).values.turnOutline).toMatchObject({
      turns: [{ turn: 1, seq: 0 }],
    })
    await fiber.dispose()
    expect('turnOutline' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    await ctx.fiber.dispose()
  })

  it('indexes every turn with bounded human and settled assistant previews', () => {
    const events: SessionEvent[] = [
      at(0, 'turn/start', { turn: 1 }),
      at(1, 'user/message', createUserMessage({
        content: [{ type: 'text', text: `  first\n${'x'.repeat(300)}` }],
        source: { kind: 'user' },
      })),
      at(2, 'assistant/message', {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: ' settled answer ' }],
          source: { provider: 'test', model: 'test' },
        }),
      }),
      at(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      at(4, 'turn/start', { turn: 2 }),
    ]
    const state = events.reduce((value, event) => definition.apply(value, event), definition.init())
    expect(state.turns).toEqual([
      {
        turn: 1,
        seq: 0,
        prompt: `first ${'x'.repeat(TURN_OUTLINE_PREVIEW_LIMIT - 6)}`,
        response: 'settled answer',
        status: 'closed',
      },
      { turn: 2, seq: 4, prompt: '', response: '', status: 'open' },
    ])
    expect(definition.schema.parse(definition.view(state))).toEqual(state)
  })

  it('ignores steering, non-human messages and repeated boundaries without copying state', () => {
    const started = definition.apply(definition.init(), at(0, 'turn/start', { turn: 1 }))
    const assistant = definition.apply(started, at(1, 'user/message', createUserMessage({
      content: [{ type: 'text', text: 'internal' }],
      source: { kind: 'plugin', plugin: 'test' },
    })))
    const repeated = definition.apply(assistant, at(2, 'turn/start', { turn: 1 }))
    expect(assistant).toBe(started)
    expect(repeated).toBe(started)
  })

  it('rejects unordered persisted projection values', () => {
    expect(() => definition.schema.parse({ turns: [
      { turn: 2, seq: 0, prompt: '', response: '', status: 'closed' },
      { turn: 1, seq: 5, prompt: '', response: '', status: 'open' },
    ] })).toThrow(/increase by turn/)
  })

  it('does not retain tool output, attachment bodies, or file content', () => {
    const marker = 'PRIVATE_TOOL_BODY'.repeat(10_000)
    const started = definition.apply(definition.init(), at(0, 'turn/start', { turn: 1 }))
    const afterTool = definition.apply(started, {
      seq: 1,
      time: 1_700_000_000_001,
      type: 'tool/result',
      data: { message: { content: [{ type: 'text', text: marker }] } },
    } as SessionEvent)
    expect(afterTool).toBe(started)
    expect(JSON.stringify(afterTool)).not.toContain('PRIVATE_TOOL_BODY')
  })
})
