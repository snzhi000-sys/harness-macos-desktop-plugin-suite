import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'

const execFileAsync = promisify(execFile)

/** Installs product plugins, replacing Dev profiles and merging into Stable user profiles. */
export async function installBundledProfile({ channel, isPackaged, resourcesPath, userData, runtimeDir, extractArchive = defaultExtractArchive, onInstallStart }) {
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
  if (existsSync(profile) && installedId === profileId) {
    return channel === 'stable' ? migrateShellTransactionConfig(profile, runtimeDir) : false
  }

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
      mergeDesktopPetBundle(staging, merged)
      migrateShellTransactionConfig(merged, runtimeDir)
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

// Add the newly shipped bundle without replacing the user's existing composition.
function mergeDesktopPetBundle(source, destination) {
  const pet = 'dsh-desktop-pet'
  const bundled = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  if (!bundled.dsh?.profile?.bundles?.includes(pet)) return
  const path = join(destination, 'package.json')
  const original = readFileSync(path, 'utf8')
  const manifest = JSON.parse(original)
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles ??= []
  if (!Array.isArray(manifest.dsh.profile.bundles)) throw new Error('Cannot migrate invalid Profile bundle list')
  if (manifest.dsh.profile.bundles.includes(pet)) return
  manifest.dsh.profile.bundles.push(pet)
  manifest.dependencies ??= {}
  manifest.dependencies[pet] ??= bundled.dependencies[pet]
  const backup = `${path}.before-desktop-pet`
  if (!existsSync(backup)) writeFileSync(backup, original, { flag: 'wx', mode: 0o600 })
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
}

// Upgrade only the missing product setting; explicit user settings remain authoritative.
// YAML nodes preserve comments and unevaluated !!js values in unrelated configuration.
function migrateShellTransactionConfig(profile, runtimeDir) {
  const path = join(profile, 'cordis.patch.yml')
  if (!existsSync(path)) return false
  const original = readFileSync(path, 'utf8')
  const require = createRequire(runtimeDir ? join(runtimeDir, 'package.json') : import.meta.url)
  const { parseDocument, isSeq, isMap } = require('yaml')
  const doc = parseDocument(original)
  if (doc.errors.length) throw new Error('Cannot migrate invalid Profile YAML')
  let changed = false
  const visit = entries => {
    if (!isSeq(entries)) return
    for (const entry of entries.items) {
      if (!isMap(entry)) continue
      if (entry.get('id') === 'dsh-file-edit' && (!entry.has('disabled') || entry.get('disabled') === false)) {
        const config = entry.get('config', true)
        if (config === undefined) {
          entry.set('config', doc.createNode({ shellTransactionLifecycle: true }))
          changed = true
        } else if (isMap(config) && !config.has('shellTransactionLifecycle')) {
          config.set('shellTransactionLifecycle', true)
          changed = true
        }
      }
      visit(entry.get('insert', true))
    }
  }
  visit(doc.contents)
  if (!changed) return false
  const backup = `${path}.before-shell-transactions`
  if (!existsSync(backup)) writeFileSync(backup, original, { flag: 'wx', mode: 0o600 })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, String(doc), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
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
