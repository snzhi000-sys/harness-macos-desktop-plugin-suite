import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PetGestures } from '../src/gestures.mjs'
const profile = { dragThreshold: 28, strokeThreshold: 7, strokeMs: 220 }
test('a short back-and-forth head stroke triggers once without starting a window drag', () => {
  const gestures = new PetGestures(profile)
  gestures.start(100, 100, 'head', 0)
  assert.equal(gestures.move(111, 100, 120), null)
  assert.equal(gestures.move(99, 101, 260), 'touch')
  assert.equal(gestures.move(110, 100, 500), null)
  assert.equal(gestures.end(), null)
})
test('deliberate drag wins, releases once, and body tap remains distinct', () => {
  const gestures = new PetGestures(profile)
  gestures.start(100, 100, 'head', 0)
  assert.equal(gestures.move(140, 100, 80), 'drag')
  assert.equal(gestures.move(90, 100, 200), null)
  assert.equal(gestures.end(), 'release')
  assert.equal(gestures.end(), null)
  gestures.start(100, 300, 'body', 1000)
  assert.equal(gestures.end(), 'click')
})
