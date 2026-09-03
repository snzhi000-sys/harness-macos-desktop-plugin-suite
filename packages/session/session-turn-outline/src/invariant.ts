/** Package-owned invariant companion for the pure turn outline projection. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-turn-outline'

/** Cordis companion plugin name. */
export const name = 'session-turn-outline-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/**
 * No runtime invariant: the projection registry schema-validates every
 * published value, while the Session surface owns monotonic turn numbers and
 * matching lifecycle boundaries.
 */
const install: InvariantInstaller = () => {}

/** Register package ownership with the invariant service. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
