import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = readFileSync(fileURLToPath(new URL('../scripts/install-mac.mjs', import.meta.url)), 'utf8')

test('installs only the channel-specific Stable candidate', () => {
  assert.match(source, /'dist', 'stable', 'mac-arm64', 'DeepSeek Harness\.app'/)
  assert.doesNotMatch(source, /'dist', 'mac-arm64', 'DeepSeek Harness\.app'/)
})

test('preserves every prior application backup and restores the current app when copying fails', () => {
  assert.match(source, /DeepSeek Harness\.backup-/)
  assert.match(source, /!existsSync\(installed\)\) renameSync\(backup, installed\)/)
  assert.doesNotMatch(source, /remove or rename the existing backup first/)
})
