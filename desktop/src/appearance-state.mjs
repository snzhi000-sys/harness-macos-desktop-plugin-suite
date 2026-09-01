import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readAppearanceScheme(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value?.scheme === 'light' || value?.scheme === 'dark' ? value.scheme : undefined
  } catch {
    return undefined
  }
}

export function writeAppearanceScheme(path, scheme) {
  if (scheme !== 'light' && scheme !== 'dark') return false
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ scheme })}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  return true
}
