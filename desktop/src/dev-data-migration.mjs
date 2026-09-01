import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION_MARKER = '.dev-data-migration-v1'
const USER_FILES = [
  '.credentials.yaml',
  'settings.yaml',
  'storages/workspace.json',
  'state/dsh-better-sidebar/explorer-marks.json',
  'state/dsh-better-sidebar/explorer-visibility.json',
]

/**
 * Carry only user-owned Dev configuration from the pre-channel Dev location.
 * Runtime, Profile, sessions, logs, and review data intentionally remain out
 * of this migration so an old broken composition cannot return.
 */
export function migrateLegacyDevData({ channel, userData, legacyUserData }) {
  if (channel !== 'dev') return false
  const targetHome = join(userData, 'harness')
  const marker = join(targetHome, MIGRATION_MARKER)
  if (existsSync(marker) || !existsSync(join(legacyUserData, 'harness'))) return false

  const sourceHome = join(legacyUserData, 'harness')
  let copied = false
  for (const relative of USER_FILES) {
    const source = join(sourceHome, relative)
    const destination = join(targetHome, relative)
    if (!existsSync(source) || existsSync(destination)) continue
    mkdirSync(join(destination, '..'), { recursive: true })
    const staging = `${destination}.migrating`
    copyFileSync(source, staging)
    if (relative === '.credentials.yaml') chmodSync(staging, 0o600)
    renameSync(staging, destination)
    copied = true
  }
  mkdirSync(targetHome, { recursive: true })
  writeFileSync(marker, `${copied ? 'copied' : 'no-copy'}\n`, { mode: 0o600 })
  return copied
}
