import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_WINDOW_BOUNDS = Object.freeze({ width: 1380, height: 900 })
export const MIN_WINDOW_BOUNDS = Object.freeze({ width: 920, height: 640 })

function finiteInteger(value) {
  return Number.isFinite(value) ? Math.round(value) : undefined
}

function overlapArea(bounds, area) {
  const width = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x))
  const height = Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y))
  return width * height
}

export function normalizeWindowBounds(value, workAreas) {
  if (value === null || typeof value !== 'object') return { ...DEFAULT_WINDOW_BOUNDS }
  const width = finiteInteger(value.width)
  const height = finiteInteger(value.height)
  if (width === undefined || height === undefined || width < MIN_WINDOW_BOUNDS.width || height < MIN_WINDOW_BOUNDS.height) {
    return { ...DEFAULT_WINDOW_BOUNDS }
  }

  const x = finiteInteger(value.x)
  const y = finiteInteger(value.y)
  if (x === undefined || y === undefined) return { width, height }

  const areas = workAreas
    .map(area => ({
      x: finiteInteger(area?.x),
      y: finiteInteger(area?.y),
      width: finiteInteger(area?.width),
      height: finiteInteger(area?.height),
    }))
    .filter(area => area.x !== undefined && area.y !== undefined && area.width > 0 && area.height > 0)
  let target
  let largestOverlap = 0
  for (const area of areas) {
    const overlap = overlapArea({ x, y, width, height }, area)
    if (overlap > largestOverlap) {
      target = area
      largestOverlap = overlap
    }
  }
  if (target === undefined) return { width, height }

  const safeWidth = Math.min(width, target.width)
  const safeHeight = Math.min(height, target.height)
  return {
    x: Math.min(Math.max(x, target.x), target.x + target.width - safeWidth),
    y: Math.min(Math.max(y, target.y), target.y + target.height - safeHeight),
    width: safeWidth,
    height: safeHeight,
  }
}

export function readWindowBounds(path, workAreas) {
  try {
    return normalizeWindowBounds(JSON.parse(readFileSync(path, 'utf8')), workAreas)
  } catch {
    return { ...DEFAULT_WINDOW_BOUNDS }
  }
}

export function writeWindowBounds(path, bounds) {
  const value = {
    x: finiteInteger(bounds?.x),
    y: finiteInteger(bounds?.y),
    width: finiteInteger(bounds?.width),
    height: finiteInteger(bounds?.height),
  }
  if (Object.values(value).some(item => item === undefined)) return false
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  return true
}
