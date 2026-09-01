import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const suiteRoot = resolve(desktopDir, '..')
const distributionDir = join(suiteRoot, 'distribution')
const profileManifestPath = join(distributionDir, 'profile-manifest.json')
const artifactDir = join(desktopDir, '.artifacts', 'profile')
const staging = mkdtempSync(join(tmpdir(), 'dsh-clean-profile-'))
const packDir = mkdtempSync(join(tmpdir(), 'dsh-product-pack-'))
const localPathPrefixes = [suiteRoot, homedir()].sort((left, right) => right.length - left.length)

function run(command, args, cwd = suiteRoot, quiet = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: quiet ? 'pipe' : 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    const detail = quiet ? `\n${result.stderr || result.stdout}` : ''
    throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}${detail}`)
  }
  return result.stdout
}

function readManifest(directory) {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
}

function validateProfileManifest(value) {
  const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i
  if (value?.schemaVersion !== 1) throw new Error('Unsupported product profile manifest schema')
  if (!Array.isArray(value.bundles) || !value.bundles.every(name => typeof name === 'string' && packageName.test(name))) {
    throw new Error('Product profile manifest has an invalid bundle list')
  }
  if (!Array.isArray(value.packages) || !value.packages.every(name => typeof name === 'string' && packageName.test(name))) {
    throw new Error('Product profile manifest has an invalid package list')
  }
  if (value.productPlugins === null || typeof value.productPlugins !== 'object' || Array.isArray(value.productPlugins)) {
    throw new Error('Product profile manifest has an invalid plugin map')
  }
  for (const [name, path] of Object.entries(value.productPlugins)) {
    if (!packageName.test(name) || typeof path !== 'string' || path.length === 0 || isAbsolute(path) || path.split('/').includes('..')) {
      throw new Error(`Product profile manifest has an invalid plugin entry: ${name}`)
    }
  }
}

function parsePackOutput(output, packageName) {
  const json = output.match(/(?:\[\s*)?\{[\s\S]*\}(?:\s*\])?\s*$/)?.[0]
  if (json === undefined) throw new Error(`Cannot read pack output for ${packageName}`)
  const parsed = JSON.parse(json)
  const result = Array.isArray(parsed) ? parsed[0] : parsed
  if (result === undefined || typeof result.filename !== 'string') {
    throw new Error(`Cannot pack ${packageName}`)
  }
  return isAbsolute(result.filename) ? result.filename : join(packDir, result.filename)
}

function packProduct(name, directory) {
  const command = name.startsWith('@dsh-cowork/') ? 'pnpm' : 'npm'
  return parsePackOutput(run(command, ['pack', '--json', '--pack-destination', packDir], directory, true), name)
}

function workspacePackages() {
  const directories = []
  for (const group of readdirSync(join(suiteRoot, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    for (const pkg of readdirSync(join(suiteRoot, 'packages', group.name), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      directories.push(join(suiteRoot, 'packages', group.name, pkg.name))
    }
  }
  for (const parent of ['vendor', 'apps']) {
    for (const pkg of readdirSync(join(suiteRoot, parent), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      directories.push(join(suiteRoot, parent, pkg.name))
    }
  }
  return new Map(directories.filter(directory => existsSync(join(directory, 'package.json'))).map(directory => {
    const manifest = readManifest(directory)
    return [manifest.name, { directory, manifest }]
  }))
}

function packagePath(root, name) {
  return join(root, 'node_modules', ...name.split('/'), 'package.json')
}

function exactPeerVersion(name, range, pluginRoots) {
  for (const root of [...pluginRoots, suiteRoot]) {
    const candidate = packagePath(root, name)
    if (!existsSync(candidate)) continue
    const version = JSON.parse(readFileSync(realpathSync(candidate), 'utf8')).version
    if (typeof version === 'string' && version.length > 0) return version
  }
  const lowerBound = range.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0]
  if (lowerBound === undefined) throw new Error(`Cannot pin peer dependency ${name} from range ${range}`)
  return lowerBound
}

function scrubLocalPaths(directory) {
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

function verifySnapshot(directory) {
  const violations = []
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const item = join(current, entry.name)
      const relative = item.slice(directory.length + 1)
      const stat = lstatSync(item)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(item)
        if (isAbsolute(target)) violations.push(`${relative}: absolute symlink`)
      } else if (stat.isDirectory()) {
        visit(item)
      } else if (stat.isFile()) {
        const buffer = readFileSync(item)
        if (localPathPrefixes.some(prefix => buffer.includes(Buffer.from(prefix)))) {
          violations.push(`${relative}: personal path`)
        }
      }
    }
  }
  visit(directory)
  if (violations.length > 0) throw new Error(`Profile privacy verification failed:\n${violations.join('\n')}`)
}

try {
  const productProfile = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
  validateProfileManifest(productProfile)

  const pluginEntries = Object.entries(productProfile.productPlugins).map(([name, relativePath]) => {
    const directory = resolve(suiteRoot, relativePath)
    if (!directory.startsWith(`${suiteRoot}/`) || !existsSync(join(directory, 'package.json'))) {
      throw new Error(`Product plugin source is missing: ${name}`)
    }
    const manifest = readManifest(directory)
    if (manifest.name !== name) throw new Error(`Product plugin name mismatch: expected ${name}, found ${String(manifest.name)}`)
    return { name, directory, manifest }
  })
  const pluginRoots = pluginEntries.map(entry => entry.directory)
  const packed = new Map(pluginEntries.map(entry => [entry.name, packProduct(entry.name, entry.directory)]))
  const workspaceByName = workspacePackages()

  const dependencies = Object.fromEntries([...packed].map(([name, archive]) => [name, `file:${archive}`]))
  const visitedWorkspacePackages = new Set()
  const addWorkspaceClosure = name => {
    const workspacePackage = workspaceByName.get(name)
    if (workspacePackage === undefined) return false
    if (visitedWorkspacePackages.has(name)) return true
    visitedWorkspacePackages.add(name)
    const archive = packed.get(name) ?? parsePackOutput(
      run('pnpm', ['pack', '--json', '--pack-destination', packDir], workspacePackage.directory, true),
      name,
    )
    packed.set(name, archive)
    dependencies[name] = `file:${archive}`
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(workspacePackage.manifest[section] ?? {})) addWorkspaceClosure(dependency)
    }
    return true
  }
  for (const entry of pluginEntries) {
    for (const [name, range] of Object.entries(entry.manifest.peerDependencies ?? {})) {
      if (dependencies[name] !== undefined) continue
      if (!addWorkspaceClosure(name)) {
        dependencies[name] = exactPeerVersion(name, String(range), pluginRoots)
      }
    }
  }

  writeFileSync(join(staging, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web-bootstrap',
    version: '0.0.0',
    private: true,
    dependencies,
  }, null, 2)}\n`)
  run('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false', '--omit=dev', '--legacy-peer-deps'], staging)

  const runtimeDependencies = Object.fromEntries(
    [...new Set([...productProfile.bundles, ...productProfile.packages, ...Object.keys(productProfile.productPlugins)])]
      .sort()
      .map(name => [name, '*']),
  )
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: runtimeDependencies,
    dsh: { profile: { bundles: productProfile.bundles } },
  }, null, 2)}\n`)
  writeFileSync(join(staging, 'cordis.yml'), '[]\n')
  cpSync(join(distributionDir, 'cordis.patch.yml'), join(staging, 'cordis.patch.yml'))

  scrubLocalPaths(staging)
  verifySnapshot(staging)

  rmSync(artifactDir, { recursive: true, force: true })
  mkdirSync(artifactDir, { recursive: true })
  const archive = join(artifactDir, 'profile.tar.gz')
  run('/usr/bin/tar', ['-czf', archive, '-C', staging, '.'])
  const profileId = createHash('sha256').update(readFileSync(archive)).digest('hex').slice(0, 16)
  writeFileSync(join(artifactDir, 'profile-id'), `${profileId}\n`)
  console.log(`clean plugin profile prepared from product manifest: ${String(productProfile.bundles.length)} bundles, ${basename(archive)}`)
} finally {
  rmSync(staging, { recursive: true, force: true })
  rmSync(packDir, { recursive: true, force: true })
}
