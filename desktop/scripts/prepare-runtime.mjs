import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, chmodSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const root = resolve(desktopDir, '..')
const runtimeDir = join(root, '.desktop-runtime')
const artifactsDir = join(desktopDir, '.artifacts', 'npm')
const runtimeArtifactsDir = join(desktopDir, '.artifacts', 'runtime')
const reusePackedArtifacts = process.env.DSH_DESKTOP_REUSE_PACKS === '1'
const packageSections = ['dependencies', 'optionalDependencies', 'peerDependencies']

function run(command, args, cwd = root, quiet = false) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: quiet ? 'utf8' : undefined,
    env: process.env,
  })
  if (result.status !== 0) {
    const detail = quiet ? `\n${result.stderr || result.stdout}` : ''
    throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}${detail}`)
  }
}

function packageDirectories() {
  const directories = []
  for (const group of readdirSync(join(root, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    for (const pkg of readdirSync(join(root, 'packages', group.name), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      directories.push(join(root, 'packages', group.name, pkg.name))
    }
  }
  for (const pkg of readdirSync(join(root, 'vendor'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    directories.push(join(root, 'vendor', pkg.name))
  }
  for (const pkg of readdirSync(join(root, 'apps'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    directories.push(join(root, 'apps', pkg.name))
  }
  directories.push(join(root, 'native', 'landlock-run'))
  const nativePackages = join(root, 'native', 'landlock-run', 'packages')
  if (existsSync(nativePackages)) {
    for (const pkg of readdirSync(nativePackages, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      directories.push(join(nativePackages, pkg.name))
    }
  }
  return directories.filter(directory => existsSync(join(directory, 'package.json')))
}

function readManifest(directory) {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
}

function runtimeClosure(byName) {
  const selected = new Map()
  const visit = name => {
    if (selected.has(name)) return
    const entry = byName.get(name)
    if (entry === undefined) return
    selected.set(name, entry)
    for (const section of packageSections) {
      for (const dependency of Object.keys(entry.manifest[section] ?? {})) visit(dependency)
    }
  }
  visit('@deepseek-ai/dsh')
  return [...selected.values()].sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
}

function supportsCurrentPlatform(manifest) {
  const matches = (values, current) => {
    if (!Array.isArray(values) || values.length === 0) return true
    if (values.includes(`!${current}`)) return false
    const positive = values.filter(value => typeof value === 'string' && !value.startsWith('!'))
    return positive.length === 0 || positive.includes(current)
  }
  return matches(manifest.os, process.platform) && matches(manifest.cpu, process.arch)
}

if (!existsSync(join(root, 'apps', 'cli', 'lib', 'bin.js')) || !existsSync(join(root, 'apps', 'web', 'dist', 'index.html'))) {
  run('pnpm', ['run', 'build'])
}

rmSync(runtimeDir, { recursive: true, force: true })
mkdirSync(runtimeDir, { recursive: true })
if (!reusePackedArtifacts) {
  rmSync(artifactsDir, { recursive: true, force: true })
  mkdirSync(artifactsDir, { recursive: true })
}

const byName = new Map(packageDirectories().map(directory => {
  const manifest = readManifest(directory)
  return [manifest.name, { directory, manifest }]
}))
const selected = runtimeClosure(byName).filter(entry => supportsCurrentPlatform(entry.manifest))
if (!selected.some(entry => entry.manifest.name === '@deepseek-ai/dsh')) throw new Error('workspace @deepseek-ai/dsh package not found')

if (!reusePackedArtifacts) {
  console.log(`packing ${selected.length} workspace runtime packages`)
  for (const entry of selected) run('pnpm', ['--dir', entry.directory, 'pack', '--pack-destination', artifactsDir], root, true)
}

const tarballs = readdirSync(artifactsDir).filter(file => file.endsWith('.tgz'))
const installationDependencies = {}
const releaseDependencies = {}
for (const file of tarballs) {
  const result = spawnSync('tar', ['-xOzf', join(artifactsDir, file), 'package/package.json'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`cannot read ${file}`)
  const manifest = JSON.parse(result.stdout)
  installationDependencies[manifest.name] = `file:${join(artifactsDir, file)}`
  releaseDependencies[manifest.name] = manifest.version
}
const runtimeManifest = dependencies => `${JSON.stringify({
  name: 'deepseek-harness-desktop-runtime',
  version: '0.0.0',
  private: true,
  dependencies,
}, null, 2)}\n`
writeFileSync(join(runtimeDir, 'package.json'), runtimeManifest(installationDependencies))

run('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false', '--omit=dev'], runtimeDir)
// The installation manifest points npm at local tarballs, but those absolute
// build paths are not runtime metadata and must not enter the release archive.
writeFileSync(join(runtimeDir, 'package.json'), runtimeManifest(releaseDependencies))

const nodeSource = realpathSync(process.execPath)
const binDir = join(runtimeDir, 'bin')
mkdirSync(binDir, { recursive: true })
copyFileSync(nodeSource, join(binDir, 'node'))
chmodSync(join(binDir, 'node'), 0o755)
const nodeLicense = join(dirname(dirname(nodeSource)), 'LICENSE')
if (existsSync(nodeLicense)) copyFileSync(nodeLicense, join(runtimeDir, 'NODE-LICENSE'))

run(join(binDir, 'node'), [join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--version'], runtimeDir)
rmSync(runtimeArtifactsDir, { recursive: true, force: true })
mkdirSync(runtimeArtifactsDir, { recursive: true })
const runtimeArchive = join(runtimeArtifactsDir, 'runtime.tar.gz')
run('/usr/bin/tar', ['-czf', runtimeArchive, '-C', runtimeDir, '.'])
const runtimeId = createHash('sha256').update(readFileSync(runtimeArchive)).digest('hex').slice(0, 16)
writeFileSync(join(runtimeArtifactsDir, 'runtime-id'), `${runtimeId}\n`)
console.log(`desktop runtime prepared: ${selected.length} workspace packages, Node ${process.version} (${basename(nodeSource)})`)
