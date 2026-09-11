import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = readFileSync(fileURLToPath(new URL('../scripts/verify-product-launch.mjs', import.meta.url)), 'utf8')

test('waits for signal termination before removing isolated launch data', () => {
  assert.match(source, /child\.exitCode === null && child\.signalCode === null/)
  assert.match(source, /child\.kill\('SIGKILL'\)[\s\S]*childIsRunning\(\)/)
})

test('retries transient non-empty directory cleanup failures', () => {
  assert.match(source, /rmSync\(userData, \{ recursive: true, force: true, maxRetries: 20, retryDelay: 100 \}\)/)
})

test('allows a full first-launch extraction window and preserves a scrubbed diagnostic tail', () => {
  assert.match(source, /attempt < 150/)
  assert.match(source, /did not become ready within 300 seconds/)
  assert.match(source, /slice\(-8_000\)\.replaceAll\(userData, '\{\{userData\}\}'\)/)
})
