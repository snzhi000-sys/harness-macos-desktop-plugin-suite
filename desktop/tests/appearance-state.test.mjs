import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readAppearanceScheme, writeAppearanceScheme } from '../src/appearance-state.mjs'

test('persists only a valid light or dark appearance for the next launch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-appearance-state-'))
  try {
    const path = join(directory, 'appearance-state.json')
    assert.equal(writeAppearanceScheme(path, 'dark'), true)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { scheme: 'dark' })
    assert.equal(readAppearanceScheme(path), 'dark')
    assert.equal(writeAppearanceScheme(path, 'system'), false)
    writeFileSync(path, '{"scheme":"invalid"}\n')
    assert.equal(readAppearanceScheme(path), undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
