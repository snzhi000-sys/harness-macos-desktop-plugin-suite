import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_WINDOW_BOUNDS,
  normalizeWindowBounds,
  readWindowBounds,
  writeWindowBounds,
} from '../src/window-state.mjs'

const display = [{ x: 0, y: 25, width: 1728, height: 1080 }]

test('uses the default size when no valid window state exists', () => {
  assert.deepEqual(normalizeWindowBounds(undefined, display), DEFAULT_WINDOW_BOUNDS)
  assert.deepEqual(normalizeWindowBounds({ width: 100, height: 100 }, display), DEFAULT_WINDOW_BOUNDS)
})

test('restores valid bounds and keeps them inside the available display area', () => {
  assert.deepEqual(
    normalizeWindowBounds({ x: 1500, y: 1000, width: 1200, height: 800 }, display),
    { x: 528, y: 305, width: 1200, height: 800 },
  )
})

test('keeps the previous size but lets the OS place a window from a disconnected display', () => {
  assert.deepEqual(
    normalizeWindowBounds({ x: 3000, y: 100, width: 1200, height: 800 }, display),
    { width: 1200, height: 800 },
  )
})

test('writes and reads window state atomically', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-window-state-'))
  try {
    const path = join(directory, 'window-state.json')
    assert.equal(writeWindowBounds(path, { x: 120, y: 80, width: 1440, height: 920 }), true)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { x: 120, y: 80, width: 1440, height: 920 })
    assert.deepEqual(readWindowBounds(path, display), { x: 120, y: 80, width: 1440, height: 920 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
