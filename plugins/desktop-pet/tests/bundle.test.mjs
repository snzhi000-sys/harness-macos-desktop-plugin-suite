import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

test('classic client bundle registers a lazy Harness factory without touching the DOM', () => {
  let handoff
  runInNewContext(readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8'), { __ModuleLoader__: { load(value) { handoff = value } } })
  assert.equal(handoff.id, 'dsh-desktop-pet')
  const exports = handoff.factory(() => { throw new Error('Unexpected dependency') })
  assert.equal(typeof exports.apply, 'function')
})
