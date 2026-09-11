import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyClientBundle } from '../src/client-bundle-contract.mjs'

test('packaging rejects ESM and missing/wrong Loader registrations', () => {
  assert.throws(() => verifyClientBundle('export function apply() {}', 'pet'))
  assert.throws(() => verifyClientBundle('void 0', 'pet'), /did not register/)
  assert.throws(() => verifyClientBundle('globalThis.__ModuleLoader__.load({id:"wrong",factory(){return {apply(){}}}})', 'pet'), /did not register/)
  verifyClientBundle('globalThis.__ModuleLoader__.load({id:"pet",factory(){return {apply(){}}}})', 'pet')
})
