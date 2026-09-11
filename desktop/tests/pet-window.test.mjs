import { test } from 'node:test'
import assert from 'node:assert/strict'
import { petBounds } from '../src/pet-window.mjs'

test('pet starts near bottom right and recovers after its monitor is disconnected', () => {
  const areas = [{ x: 0, y: 25, width: 1440, height: 875 }]
  const initial = petBounds(undefined, areas)
  assert.equal(initial.height, 420)
  assert.ok(initial.x > 1000)
  const restored = petBounds({ x: -2500, y: 300, height: 420 }, areas)
  assert.equal(restored.x, 0)
  assert.ok(restored.y >= 25)
  assert.ok(restored.y + restored.height <= 900)
})

test('pet fits a small display without extending off-screen', () => {
  const bounds = petBounds({ x: 2000, y: 2000, height: 1000 }, [{ x: -200, y: 0, width: 200, height: 160 }])
  assert.equal(bounds.height, 160)
  assert.ok(bounds.x >= -200)
  assert.ok(bounds.x + bounds.width <= 0)
  assert.equal(bounds.y, 0)
})

test('compact input reserves space below the character and stays inside the screen', () => {
  const areas = [{ x: 0, y: 25, width: 1440, height: 875 }]
  const base = petBounds({ height: 420, y: 470 }, areas)
  const expanded = petBounds({ ...base, height: 420 }, areas, true)
  assert.equal(expanded.height, base.height + 72)
  assert.equal(expanded.width, base.width)
  assert.ok(expanded.y + expanded.height <= 900)
  assert.equal(petBounds({ height: 180 }, areas, true).width, 280)
})
