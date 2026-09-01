import assert from 'node:assert/strict'
import { test } from 'node:test'

import { referenceChipWidthEm } from '../client/src/reference-width.js'

const measureText = (text) => Array.from(text).reduce((width, char) => (
  width + (/^[\x00-\x7F]$/.test(char) ? 6 : 12)
), 0)

test('reference width follows measured label pixels instead of a fixed name bucket', () => {
  const width = (name) => referenceChipWidthEm({ name, measureText, composerFontSizePx: 16 })
  const short = width('a')
  const medium = width('test.md')
  const long = width('Harness插件迭代交接.md')

  assert.ok(short < medium)
  assert.ok(medium < long)
  assert.equal(short, 3)
})

test('line references measure the actual numeric prefix', () => {
  const oneDigit = referenceChipWidthEm({ name: 'a.md', line: '1', measureText, composerFontSizePx: 16 })
  const range = referenceChipWidthEm({ name: 'a.md', line: '120-240', measureText, composerFontSizePx: 16 })
  assert.ok(range > oneDigit)
})

test('name width keeps one CJK minimum and caps at twenty CJK glyphs', () => {
  const empty = referenceChipWidthEm({ name: '', measureText, composerFontSizePx: 16 })
  const one = referenceChipWidthEm({ name: '汉', measureText, composerFontSizePx: 16 })
  const twenty = referenceChipWidthEm({ name: '汉'.repeat(20), measureText, composerFontSizePx: 16 })
  const forty = referenceChipWidthEm({ name: '汉'.repeat(40), measureText, composerFontSizePx: 16 })

  assert.equal(empty, one)
  assert.equal(twenty, forty)
  assert.ok(twenty <= 23)
})
