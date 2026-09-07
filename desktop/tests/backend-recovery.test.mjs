import assert from 'node:assert/strict'
import test from 'node:test'
import { backendPort, backendRecoveryDelay } from '../src/backend-recovery.mjs'

test('reuses the loopback backend port so the Renderer origin does not change', () => {
  assert.equal(backendPort('http://127.0.0.1:43127'), 43127)
})

test('rejects non-loopback and invalid recovery URLs', () => {
  assert.throws(() => backendPort('http://localhost:43127'))
  assert.throws(() => backendPort('http://127.0.0.1'))
  assert.throws(() => backendPort('not-a-url'))
})

test('uses bounded exponential delays between recovery attempts', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(backendRecoveryDelay),
    [500, 1_000, 2_000, 4_000, 4_000, 4_000],
  )
})
