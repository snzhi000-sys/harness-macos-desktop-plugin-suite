/** Host plugin registering the whole-log turn outline projection. */
import type { Context } from '@deepseek-ai/cordis'
import { turnOutlineProjectionDefinition } from './projection.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'session-turn-outline'
/** Required projection registry. */
export const inject = ['sessionProjections']

/** Register the turnOutline unit. */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(turnOutlineProjectionDefinition)
}
