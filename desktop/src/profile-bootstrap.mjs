import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Installs the bundled clean Web profile only when no user profile exists. */
export async function installBundledProfile({ isPackaged, resourcesPath, userData, extractArchive = defaultExtractArchive }) {
  if (!isPackaged) return false
  const bootstrap = join(resourcesPath, 'profile-bootstrap')
  const profileId = readFileSync(join(bootstrap, 'profile-id'), 'utf8').trim()
  if (!/^[a-f0-9]{16}$/.test(profileId)) throw new Error('Packaged profile identifier is invalid')

  const profiles = join(userData, 'harness', 'profiles')
  const profile = join(profiles, 'web')
  if (existsSync(profile)) return false

  const staging = join(profiles, `web.${profileId}.installing`)
  mkdirSync(profiles, { recursive: true })
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    await extractArchive(join(bootstrap, 'profile.tar.gz'), staging)
    if (!existsSync(join(staging, 'package.json')) || !existsSync(join(staging, 'node_modules'))) {
      throw new Error('Packaged profile is incomplete')
    }
    renameSync(staging, profile)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  return true
}

async function defaultExtractArchive(archive, destination) {
  await execFileAsync('/usr/bin/tar', ['-xzf', archive, '-C', destination])
}
