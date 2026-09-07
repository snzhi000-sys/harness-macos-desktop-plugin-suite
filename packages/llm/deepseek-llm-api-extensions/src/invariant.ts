/** Package-owned invariant companion for `@deepseek-ai/dsh-deepseek-llm-api-extensions`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-deepseek-llm-api-extensions'
export const name = 'deepseek-llm-api-extensions-invariant'
export const inject = ['invariants']
/** No runtime invariant: registration ownership and acceptance idempotence are enforced inside the service. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
