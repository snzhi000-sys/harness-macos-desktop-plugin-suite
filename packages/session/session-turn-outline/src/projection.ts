import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TurnOutlineEntry, TurnOutlineProjection } from './types.ts'

/** Each preview is deliberately smaller than one ordinary message card. */
export const TURN_OUTLINE_PREVIEW_LIMIT = 160

function textPreview(content: readonly unknown[]): string {
  let text = ''
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as { type?: unknown; text?: unknown }
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    text += text === '' ? block.text : ` ${block.text}`
    if (text.length >= TURN_OUTLINE_PREVIEW_LIMIT) break
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, TURN_OUTLINE_PREVIEW_LIMIT)
}

function replaceLast(state: TurnOutlineProjection, entry: TurnOutlineEntry): TurnOutlineProjection {
  return { turns: [...state.turns.slice(0, -1), entry] }
}

const schema = z.object({
  turns: z.array(z.object({
    turn: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
    prompt: z.string().max(TURN_OUTLINE_PREVIEW_LIMIT),
    response: z.string().max(TURN_OUTLINE_PREVIEW_LIMIT),
    status: z.enum(['open', 'closed']),
  }).strict()),
}).strict().superRefine((value, context) => {
  let prior = -1
  for (const entry of value.turns) {
    if (entry.turn <= prior) {
      context.addIssue({ code: 'custom', message: 'turn outline entries must increase by turn' })
      return
    }
    prior = entry.turn
  }
})

const EMPTY: TurnOutlineProjection = { turns: [] }

/** Pure whole-log turn navigation projection. */
export const turnOutlineProjectionDefinition: ProjectionDefinition<'turnOutline', TurnOutlineProjection> = {
  key: 'turnOutline',
  schema,
  stateVersion: 1,
  init: () => EMPTY,
  apply: (state, event: SessionEvent) => {
    const last = state.turns.at(-1)
    switch (event.type) {
      case 'turn/start':
        if (last !== undefined && event.data.turn <= last.turn) return state
        return {
          turns: [...state.turns, {
            turn: event.data.turn,
            seq: event.seq,
            prompt: '',
            response: '',
            status: 'open',
          }],
        }
      case 'user/message': {
        if (last === undefined || last.prompt !== '' || event.data.source.kind !== 'user') return state
        const prompt = textPreview(event.data.content)
        return prompt === '' ? state : replaceLast(state, { ...last, prompt })
      }
      case 'assistant/message': {
        if (last === undefined || last.turn !== event.data.turn || last.response !== '') return state
        const response = textPreview(event.data.message.content)
        return response === '' ? state : replaceLast(state, { ...last, response })
      }
      case 'turn/end':
        return last === undefined || last.turn !== event.data.turn || last.status === 'closed'
          ? state
          : replaceLast(state, { ...last, status: 'closed' })
      default:
        return state
    }
  },
  view: state => state,
}
