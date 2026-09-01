import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cssPath = resolve(root, 'packages/client/ui-conversation/src/client/skeleton/InputBar.module.css')

const LEGACY_START = 0xE000
const LEGACY_COUNT = 21
const FINE_START = 0xE100
const FINE_COUNT = 161
const FINE_STEP_UNITS = 125
const MIN_ADVANCE_UNITS = 3000

function align4(value) {
  return (value + 3) & ~3
}

function checksum(buffer) {
  const padded = Buffer.alloc(align4(buffer.length))
  buffer.copy(padded)
  let sum = 0
  for (let offset = 0; offset < padded.length; offset += 4) {
    sum = (sum + padded.readUInt32BE(offset)) >>> 0
  }
  return sum
}

function sourceTables(font) {
  const count = font.readUInt16BE(4)
  const tables = []
  for (let index = 0; index < count; index += 1) {
    const at = 12 + index * 16
    const tag = font.toString('ascii', at, at + 4)
    const offset = font.readUInt32BE(at + 8)
    const length = font.readUInt32BE(at + 12)
    tables.push({ tag, data: Buffer.from(font.subarray(offset, offset + length)) })
  }
  return tables
}

function makeCmap() {
  const segments = [
    { start: LEGACY_START, end: LEGACY_START + LEGACY_COUNT - 1, glyph: 2 },
    { start: FINE_START, end: FINE_START + FINE_COUNT - 1, glyph: 2 + LEGACY_COUNT },
    { start: 0xFFFC, end: 0xFFFC, glyph: 1 },
    { start: 0xFFFF, end: 0xFFFF, glyph: 0 },
  ]
  const segmentCount = segments.length
  const formatLength = 16 + segmentCount * 8
  const format = Buffer.alloc(formatLength)
  format.writeUInt16BE(4, 0)
  format.writeUInt16BE(formatLength, 2)
  format.writeUInt16BE(0, 4)
  format.writeUInt16BE(segmentCount * 2, 6)
  const maxPower = 2 ** Math.floor(Math.log2(segmentCount))
  format.writeUInt16BE(maxPower * 2, 8)
  format.writeUInt16BE(Math.log2(maxPower), 10)
  format.writeUInt16BE(segmentCount * 2 - maxPower * 2, 12)
  const endAt = 14
  const startAt = endAt + segmentCount * 2 + 2
  const deltaAt = startAt + segmentCount * 2
  const rangeAt = deltaAt + segmentCount * 2
  segments.forEach((segment, index) => {
    format.writeUInt16BE(segment.end, endAt + index * 2)
    format.writeUInt16BE(segment.start, startAt + index * 2)
    format.writeUInt16BE((segment.glyph - segment.start) & 0xFFFF, deltaAt + index * 2)
    format.writeUInt16BE(0, rangeAt + index * 2)
  })
  const cmap = Buffer.alloc(20 + format.length)
  cmap.writeUInt16BE(0, 0)
  cmap.writeUInt16BE(2, 2)
  cmap.writeUInt16BE(0, 4)
  cmap.writeUInt16BE(3, 6)
  cmap.writeUInt32BE(20, 8)
  cmap.writeUInt16BE(3, 12)
  cmap.writeUInt16BE(1, 14)
  cmap.writeUInt32BE(20, 16)
  format.copy(cmap, 20)
  return cmap
}

function makeHmtx() {
  const glyphCount = 2 + LEGACY_COUNT + FINE_COUNT
  const hmtx = Buffer.alloc(glyphCount * 4)
  const advances = [0, 4000]
  for (let index = 0; index < LEGACY_COUNT; index += 1) advances.push(MIN_ADVANCE_UNITS + index * 1000)
  for (let index = 0; index < FINE_COUNT; index += 1) advances.push(MIN_ADVANCE_UNITS + index * FINE_STEP_UNITS)
  advances.forEach((advance, index) => hmtx.writeUInt16BE(advance, index * 4))
  return { hmtx, glyphCount }
}

function makeEmptyGlyphTables(glyphCount) {
  // A TrueType simple glyph with zero contours still carries the 10-byte
  // glyph header followed by a zero instructionLength. Keeping one valid
  // empty record per glyph satisfies Chromium's OpenType Sanitizer while
  // leaving all painting empty; horizontal advance remains owned by hmtx.
  const glyphSize = 12
  const glyf = Buffer.alloc(glyphCount * glyphSize)
  const loca = Buffer.alloc((glyphCount + 1) * 2)
  for (let index = 0; index <= glyphCount; index += 1) {
    // head.indexToLocFormat = 0 stores offsets divided by two.
    loca.writeUInt16BE((index * glyphSize) / 2, index * 2)
  }
  return { glyf, loca }
}

export function generateChipCellFont(source) {
  const tables = sourceTables(source)
  const byTag = new Map(tables.map(table => [table.tag, table]))
  const { hmtx, glyphCount } = makeHmtx()
  const { glyf, loca } = makeEmptyGlyphTables(glyphCount)
  byTag.get('head').data.writeUInt32BE(0, 8)
  byTag.get('head').data.writeInt16BE(0, 50)
  byTag.get('hhea').data.writeUInt16BE(23000, 10)
  byTag.get('hhea').data.writeUInt16BE(glyphCount, 34)
  byTag.get('maxp').data.writeUInt16BE(glyphCount, 4)
  byTag.set('cmap', { tag: 'cmap', data: makeCmap() })
  byTag.set('hmtx', { tag: 'hmtx', data: hmtx })
  byTag.set('loca', { tag: 'loca', data: loca })
  byTag.set('glyf', { tag: 'glyf', data: glyf })
  // The source font used post format 2 with one glyph-name record per old
  // cell. Expanding maxp without expanding those records makes Chromium's
  // OpenType sanitizer reject the whole face. Format 3 keeps the header
  // metrics but deliberately carries no glyph-name array.
  const post = Buffer.from(byTag.get('post').data.subarray(0, 32))
  post.writeUInt32BE(0x00030000, 0)
  byTag.set('post', { tag: 'post', data: post })

  const ordered = tables.map(table => byTag.get(table.tag))
  const count = ordered.length
  const maxPower = 2 ** Math.floor(Math.log2(count))
  const headerLength = 12 + count * 16
  let cursor = align4(headerLength)
  const placements = ordered.map((table) => {
    const placement = { ...table, offset: cursor }
    cursor += align4(table.data.length)
    return placement
  })
  const output = Buffer.alloc(cursor)
  output.writeUInt32BE(0x00010000, 0)
  output.writeUInt16BE(count, 4)
  output.writeUInt16BE(maxPower * 16, 6)
  output.writeUInt16BE(Math.log2(maxPower), 8)
  output.writeUInt16BE(count * 16 - maxPower * 16, 10)
  placements.forEach((table, index) => {
    const at = 12 + index * 16
    output.write(table.tag, at, 4, 'ascii')
    output.writeUInt32BE(checksum(table.data), at + 4)
    output.writeUInt32BE(table.offset, at + 8)
    output.writeUInt32BE(table.data.length, at + 12)
    table.data.copy(output, table.offset)
  })
  const head = placements.find(table => table.tag === 'head')
  output.writeUInt32BE((0xB1B0AFBA - checksum(output)) >>> 0, head.offset + 8)
  return output
}

function updateCss() {
  const css = readFileSync(cssPath, 'utf8')
  const match = css.match(/base64,([^']+)'/)
  if (match === null) throw new Error('DshChipCell base64 font not found')
  const generated = generateChipCellFont(Buffer.from(match[1], 'base64')).toString('base64')
  writeFileSync(cssPath, css.replace(match[1], generated))
  console.log(`updated ${cssPath}`)
}

if (process.argv.includes('--write')) updateCss()
