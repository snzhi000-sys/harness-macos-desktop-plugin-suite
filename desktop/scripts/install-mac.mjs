import { cpSync, existsSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const built = join(desktopDir, 'dist', 'stable', 'mac-arm64', 'DeepSeek Harness.app')
const installed = '/Applications/DeepSeek Harness.app'
const backup = availableBackupPath()

if (!existsSync(built)) throw new Error(`built application not found: ${built}`)
if (existsSync(installed)) {
  renameSync(installed, backup)
}
try {
  cpSync(built, installed, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
} catch (error) {
  if (existsSync(backup) && !existsSync(installed)) renameSync(backup, installed)
  throw error
}
console.log(`installed ${installed}`)
if (existsSync(backup)) console.log(`previous version preserved at ${backup}`)

function availableBackupPath() {
  const previous = '/Applications/DeepSeek Harness.previous.app'
  if (!existsSync(previous)) return previous
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const base = `/Applications/DeepSeek Harness.backup-${timestamp}`
  let candidate = `${base}.app`
  for (let suffix = 2; existsSync(candidate); suffix += 1) candidate = `${base}-${suffix}.app`
  return candidate
}
