/** Package-owned invariant companion for `@deepseek-ai/dsh-plugin-package-inventory-deepseek`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-package-inventory-deepseek'
export const name = 'plugin-package-inventory-deepseek-invariant'
export const inject = ['invariants']
/** No runtime invariant: each request recomputes the active package inventory before transport. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
