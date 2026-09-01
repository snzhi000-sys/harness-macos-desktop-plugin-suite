import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceProfile = process.env.DSH_PROFILE_SOURCE ?? join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness', 'harness', 'profiles', 'web')
const sourceModules = join(sourceProfile, 'node_modules')
const artifactDir = join(desktopDir, '.artifacts', 'profile')
const staging = mkdtempSync(join(tmpdir(), 'dsh-clean-profile-'))
const stagingModules = join(staging, 'node_modules')
const locallyPacked = new Set(['dsh-better-sidebar', 'dsh-file-edit', 'dsh-message-edit', 'dsh-workspace-lineage', '@dsh-cowork/plugin'])
const localPathPrefixes = [resolve(desktopDir, '..', '..'), homedir()].sort((left, right) => right.length - left.length)

function run(command, args, cwd = desktopDir, quiet = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}${quiet ? `\n${result.stderr || result.stdout}` : ''}`)
  return result.stdout
}

function packageEntries(modulesDir) {
  const entries = []
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const first = join(modulesDir, entry.name)
    if (entry.name.startsWith('@')) {
      for (const child of readdirSync(first, { withFileTypes: true })) {
        if (child.isDirectory() || child.isSymbolicLink()) entries.push({ name: `${entry.name}/${child.name}`, source: join(first, child.name) })
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      entries.push({ name: entry.name, source: first })
    }
  }
  return entries
}

function unpackPackage(source, destination) {
  const packDir = mkdtempSync(join(tmpdir(), 'dsh-plugin-pack-'))
  try {
    const output = run('npm', ['pack', '--json', '--pack-destination', packDir], realpathSync(source), true)
    const json = output.match(/\[\s*\{[\s\S]*\}\s*\]\s*$/)?.[0]
    if (json === undefined) throw new Error(`Cannot read npm pack output for ${source}`)
    const result = JSON.parse(json)
    if (!Array.isArray(result) || result.length !== 1 || typeof result[0]?.filename !== 'string') throw new Error(`Cannot pack ${source}`)
    mkdirSync(destination, { recursive: true })
    run('/usr/bin/tar', ['-xzf', join(packDir, result[0].filename), '--strip-components=1', '-C', destination])
  } finally {
    rmSync(packDir, { recursive: true, force: true })
  }
}

function destinationFor(packageName) {
  return join(stagingModules, ...packageName.split('/'))
}

if (!existsSync(join(sourceProfile, 'package.json')) || !existsSync(sourceModules)) throw new Error(`Installed Web profile not found: ${sourceProfile}`)
const sourceManifest = JSON.parse(readFileSync(join(sourceProfile, 'package.json'), 'utf8'))
const bundles = sourceManifest.dsh?.profile?.bundles
if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name))) {
  throw new Error('Installed Web profile has an invalid bundle list')
}

mkdirSync(stagingModules, { recursive: true })
for (const entry of packageEntries(sourceModules)) {
  const destination = destinationFor(entry.name)
  mkdirSync(dirname(destination), { recursive: true })
  if (locallyPacked.has(entry.name)) unpackPackage(entry.source, destination)
  else cpSync(entry.source, destination, { recursive: true, dereference: false, preserveTimestamps: true, verbatimSymlinks: true })
}

const coworkCore = resolve(desktopDir, '..', '..', 'dsh-cowork', 'packages', 'core')
if (bundles.includes('@dsh-cowork/plugin')) {
  const coworkRoot = resolve(coworkCore, '..', '..')
  const bundledCore = destinationFor('@dsh-cowork/core')
  unpackPackage(coworkCore, bundledCore)
  cpSync(join(coworkCore, 'node_modules'), join(bundledCore, 'node_modules'), { recursive: true, dereference: false, preserveTimestamps: true, verbatimSymlinks: true })
  cpSync(join(coworkRoot, 'node_modules', '.pnpm'), join(stagingModules, '.pnpm'), { recursive: true, dereference: false, preserveTimestamps: true, verbatimSymlinks: true })
  for (const entry of readdirSync(join(bundledCore, 'node_modules'), { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue
    const item = join(bundledCore, 'node_modules', entry.name)
    const target = readlinkSync(item)
    if (!target.startsWith('../../../node_modules/.pnpm/')) continue
    unlinkSync(item)
    symlinkSync(target.replace('../../../node_modules/.pnpm/', '../../../.pnpm/'), item)
  }
}

const dependencies = Object.fromEntries([...new Set([...bundles, 'dsh-file-edit', ...(bundles.includes('@dsh-cowork/plugin') ? ['@dsh-cowork/core'] : [])])].sort().map(name => [name, '*']))
writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies, dsh: { profile: { bundles } } }, null, 2)}\n`)
writeFileSync(join(staging, 'cordis.yml'), '[]\n')
writeFileSync(join(staging, 'cordis.patch.yml'), '- insert:\n    - id: dsh-file-edit\n      name: dsh-file-edit\n')

const scrubLocalPaths = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const item = join(directory, entry.name)
    if (entry.isDirectory()) {
      scrubLocalPaths(item)
    } else if (entry.isFile()) {
      const buffer = readFileSync(item)
      if (!localPathPrefixes.some(prefix => buffer.includes(Buffer.from(prefix)))) continue
      let content = buffer.toString('utf8')
      for (const prefix of localPathPrefixes) content = content.replaceAll(prefix, '<local-path>')
      writeFileSync(item, content)
    }
  }
}
scrubLocalPaths(staging)

const forbiddenLinks = []
const scanLinks = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const item = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(item)
      if (target.startsWith('/')) forbiddenLinks.push(item)
    } else if (entry.isDirectory()) scanLinks(item)
  }
}
// cpSync preserves dependency-relative links; no link may point back to this machine.
scanLinks(staging)
if (forbiddenLinks.length > 0) throw new Error(`Profile contains absolute symlinks: ${forbiddenLinks.join(', ')}`)

const personalPathFiles = []
const scanPersonalPaths = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const item = join(directory, entry.name)
    if (entry.isDirectory()) scanPersonalPaths(item)
    else if (entry.isFile()) {
      const buffer = readFileSync(item)
      if (localPathPrefixes.some(prefix => buffer.includes(Buffer.from(prefix)))) personalPathFiles.push(item)
    }
  }
}
scanPersonalPaths(staging)
if (personalPathFiles.length > 0) throw new Error(`Profile contains personal paths: ${personalPathFiles.join(', ')}`)

rmSync(artifactDir, { recursive: true, force: true })
mkdirSync(artifactDir, { recursive: true })
const archive = join(artifactDir, 'profile.tar.gz')
run('/usr/bin/tar', ['-czf', archive, '-C', staging, '.'])
const profileId = createHash('sha256').update(readFileSync(archive)).digest('hex').slice(0, 16)
writeFileSync(join(artifactDir, 'profile-id'), `${profileId}\n`)
rmSync(staging, { recursive: true, force: true })
console.log(`clean plugin profile prepared: ${String(bundles.length)} active bundles, ${basename(archive)}`)
