import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { migrateLegacyDevData } from '../src/dev-data-migration.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dev-data-migration-'))
  return { legacy: join(root, 'legacy'), target: join(root, 'target') }
}

test('migrates only Dev user configuration and never the old profile or sessions', () => {
  const { legacy, target } = fixture()
  const home = join(legacy, 'harness')
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(join(home, '.credentials.yaml'), 'model-key: secret\n')
  writeFileSync(join(home, 'settings.yaml'), 'ui-theme:\n  theme: dark\n')
  writeFileSync(join(home, 'profiles', 'web', 'package.json'), '{"broken":true}\n')
  writeFileSync(join(home, 'sessions', 'private.jsonl'), 'private\n')

  assert.equal(migrateLegacyDevData({ channel: 'dev', userData: target, legacyUserData: legacy }), true)
  assert.equal(readFileSync(join(target, 'harness', '.credentials.yaml'), 'utf8'), 'model-key: secret\n')
  assert.equal(readFileSync(join(target, 'harness', 'settings.yaml'), 'utf8'), 'ui-theme:\n  theme: dark\n')
  assert.equal(existsSync(join(target, 'harness', 'profiles', 'web')), false)
  assert.equal(existsSync(join(target, 'harness', 'sessions')), false)
})

test('never overwrites the channel Dev credentials on later package launches', () => {
  const { legacy, target } = fixture()
  mkdirSync(join(legacy, 'harness'), { recursive: true })
  mkdirSync(join(target, 'harness'), { recursive: true })
  writeFileSync(join(legacy, 'harness', '.credentials.yaml'), 'old: key\n')
  writeFileSync(join(target, 'harness', '.credentials.yaml'), 'current: key\n')

  assert.equal(migrateLegacyDevData({ channel: 'dev', userData: target, legacyUserData: legacy }), false)
  assert.equal(readFileSync(join(target, 'harness', '.credentials.yaml'), 'utf8'), 'current: key\n')
})
