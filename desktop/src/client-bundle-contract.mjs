/** Verify a classic-script plugin handoff before accepting a packaged client bundle. */
import { runInNewContext } from 'node:vm'

/** A package being present in the boot manifest does not prove that its bundle can register. */
export function verifyClientBundle(source, id) {
  let handoff
  runInNewContext(source, { __ModuleLoader__: { load(value) {
    if (handoff) throw new Error(`Duplicate client registration: ${id}`)
    handoff = value
  } } }, { timeout: 1000 })
  if (handoff?.id !== id || typeof handoff.factory !== 'function') throw new Error(`Client bundle did not register its Harness factory: ${id}`)
  const exports = handoff.factory(specifier => { throw new Error(`Unexpected external in standalone client ${id}: ${specifier}`) })
  if (typeof exports?.apply !== 'function') throw new Error(`Client bundle has no apply entry: ${id}`)
}
