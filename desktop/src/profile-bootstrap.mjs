import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Installs product plugins, replacing Dev profiles and merging into Stable user profiles. */
export async function installBundledProfile({ channel, isPackaged, resourcesPath, userData, extractArchive = defaultExtractArchive, onInstallStart }) {
  if (!isPackaged) return false
  const bootstrap = join(resourcesPath, 'profile-bootstrap')
  const profileId = readFileSync(join(bootstrap, 'profile-id'), 'utf8').trim()
  if (!/^[a-f0-9]{16}$/.test(profileId)) throw new Error('Packaged profile identifier is invalid')

  const profiles = join(userData, 'harness', 'profiles')
  const profile = join(profiles, 'web')
  const installedIdPath = join(profiles, '.web-bundled-profile-id')
  const staging = join(profiles, `web.${profileId}.installing`)
  const merged = join(profiles, `web.${profileId}.merging`)
  const backup = join(profiles, 'web.previous-upgrade')
  mkdirSync(profiles, { recursive: true })

  const installedId = readInstalledId(installedIdPath)
  recoverInterruptedUpgrade({ backup, installedId, profile, profileId })
  if (existsSync(profile) && installedId === profileId) return false

  rmSync(staging, { recursive: true, force: true })
  rmSync(merged, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    await onInstallStart?.()
    await extractArchive(join(bootstrap, 'profile.tar.gz'), staging)
    if (!existsSync(join(staging, 'package.json')) || !existsSync(join(staging, 'node_modules'))) {
      throw new Error('Packaged profile is incomplete')
    }
    let replacement = staging
    if (channel === 'stable' && existsSync(profile)) {
      cpSync(profile, merged, { recursive: true, verbatimSymlinks: true })
      overlayDirectory(join(staging, 'node_modules'), join(merged, 'node_modules'))
      rmSync(staging, { recursive: true, force: true })
      replacement = merged
    }
    if (!existsSync(profile)) {
      renameSync(replacement, profile)
      try {
        writeInstalledId(installedIdPath, profileId)
      } catch (error) {
        rmSync(profile, { recursive: true, force: true })
        throw error
      }
    } else {
      renameSync(profile, backup)
      try {
        renameSync(replacement, profile)
        writeInstalledId(installedIdPath, profileId)
      } catch (error) {
        rmSync(profile, { recursive: true, force: true })
        if (existsSync(backup)) renameSync(backup, profile)
        throw error
      }
      try {
        rmSync(backup, { recursive: true, force: true })
      } catch {
        // A committed Profile remains valid; the next launch removes this recoverable backup.
      }
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    rmSync(merged, { recursive: true, force: true })
    throw error
  }
  return true
}

function overlayDirectory(source, destination) {
  mkdirSync(destination, { recursive: true })
  for (const name of readdirSync(source)) {
    const sourceEntry = join(source, name)
    const destinationEntry = join(destination, name)
    const sourceStat = lstatSync(sourceEntry)
    const destinationStat = existsSync(destinationEntry) ? lstatSync(destinationEntry) : undefined
    if (sourceStat.isDirectory() && !sourceStat.isSymbolicLink() && destinationStat?.isDirectory() && !destinationStat.isSymbolicLink()) {
      overlayDirectory(sourceEntry, destinationEntry)
      continue
    }
    rmSync(destinationEntry, { recursive: true, force: true })
    cpSync(sourceEntry, destinationEntry, { recursive: true, verbatimSymlinks: true })
  }
}

function readInstalledId(path) {
  if (!existsSync(path)) return undefined
  const value = readFileSync(path, 'utf8').trim()
  return /^[a-f0-9]{16}$/.test(value) ? value : undefined
}

function recoverInterruptedUpgrade({ backup, installedId, profile, profileId }) {
  if (!existsSync(backup)) return
  if (existsSync(profile) && installedId === profileId) {
    rmSync(backup, { recursive: true, force: true })
    return
  }
  rmSync(profile, { recursive: true, force: true })
  renameSync(backup, profile)
}

function writeInstalledId(path, profileId) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${profileId}\n`)
  try {
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

async function defaultExtractArchive(archive, destination) {
  await execFileAsync('/usr/bin/tar', ['-xzf', archive, '-C', destination])
}
