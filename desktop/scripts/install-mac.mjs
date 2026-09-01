import { cpSync, existsSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const built = join(desktopDir, 'dist', 'mac-arm64', 'DeepSeek Harness.app')
const installed = '/Applications/DeepSeek Harness.app'
const backup = '/Applications/DeepSeek Harness.previous.app'

if (!existsSync(built)) throw new Error(`built application not found: ${built}`)
if (existsSync(installed)) {
  if (existsSync(backup)) throw new Error(`remove or rename the existing backup first: ${backup}`)
  renameSync(installed, backup)
}
cpSync(built, installed, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
console.log(`installed ${installed}`)
if (existsSync(backup)) console.log(`previous version preserved at ${backup}`)
