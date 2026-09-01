import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const suiteRoot = resolve(desktopDir, '..')
const manifestPath = join(suiteRoot, 'distribution', 'profile-manifest.json')
const runtimeArchive = join(desktopDir, '.artifacts', 'runtime', 'runtime.tar.gz')
const profileArchive = join(desktopDir, '.artifacts', 'profile', 'profile.tar.gz')

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}\n${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function packagePath(profileDir, packageName) {
  return join(profileDir, 'node_modules', ...packageName.split('/'))
}

function waitForBackend(child) {
  return new Promise((resolveUrl, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for Dev backend\n${output}`)), 30_000)
    const onData = chunk => {
      output += chunk.toString()
      const url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
      if (url === undefined) return
      clearTimeout(timeout)
      resolveUrl(url)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.once('exit', code => {
      clearTimeout(timeout)
      reject(new Error(`Dev backend exited before readiness with ${String(code)}\n${output}`))
    })
  })
}

function bootManifest(html) {
  const encoded = html.match(/window\.__DSH_BOOT__ = (\{[^<]+\})<\/script>/)?.[1]
  if (encoded === undefined) throw new Error('Web shell did not publish window.__DSH_BOOT__')
  return JSON.parse(encoded)
}

for (const artifact of [runtimeArchive, profileArchive]) {
  if (!existsSync(artifact)) throw new Error(`Missing desktop artifact: ${artifact}`)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (!Array.isArray(manifest.requiredRuntimePlugins) || manifest.requiredRuntimePlugins.length === 0) {
  throw new Error('Product manifest has no requiredRuntimePlugins gate')
}

const root = mkdtempSync(join(tmpdir(), 'dsh-profile-runtime-'))
const runtimeDir = join(root, 'runtime')
const home = join(root, 'home')
const profileDir = join(home, 'profiles', 'web')
mkdirSync(runtimeDir, { recursive: true })
mkdirSync(profileDir, { recursive: true })

let child
try {
  run('/usr/bin/tar', ['-xzf', runtimeArchive, '-C', runtimeDir], root)
  run('/usr/bin/tar', ['-xzf', profileArchive, '-C', profileDir], root)

  const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  if (JSON.stringify(profile.dsh?.profile?.bundles) !== JSON.stringify(manifest.bundles)) {
    throw new Error('Bundled Profile bundle order differs from distribution/profile-manifest.json')
  }

  for (const required of manifest.requiredRuntimePlugins) {
    const directory = packagePath(profileDir, required.package)
    if (!existsSync(join(directory, 'package.json'))) throw new Error(`Required plugin package is missing: ${required.package}`)
    const installed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (installed.name !== required.package) throw new Error(`Required plugin identity mismatch: ${required.package}`)
    if (required.client === true && installed.exports?.['./client'] === undefined) {
      throw new Error(`Required plugin client export is missing: ${required.package}`)
    }
  }

  const node = join(runtimeDir, 'bin', 'node')
  const dsh = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const env = { ...process.env, DSH_HOME: home }
  const composition = run(node, [dsh, '--profile', 'web', '--dump-config'], root, env)
  for (const required of manifest.requiredRuntimePlugins) {
    const escapedPackage = required.package.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const packageRow = new RegExp(`  name: ['"]?${escapedPackage}['"]?\\n`)
    if (!composition.includes(`- id: ${required.entryId}\n`) || !packageRow.test(composition)) {
      throw new Error(`Required plugin is absent from the effective Cordis composition: ${required.package}`)
    }
  }

  child = spawn(node, [dsh, 'web', '--host', '127.0.0.1', '--port', '0'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const url = await waitForBackend(child)
  const response = await fetch(`${url}/`)
  if (!response.ok) throw new Error(`Web shell returned HTTP ${String(response.status)}`)
  const boot = bootManifest(await response.text())
  const clientIds = new Set(boot.entries.map(entry => entry.id))
  for (const required of manifest.requiredRuntimePlugins.filter(plugin => plugin.client === true)) {
    if (!clientIds.has(required.package)) throw new Error(`Required plugin client bundle is absent from Web boot: ${required.package}`)
  }

  // A profile can list every required package and still be unusable when its
  // local peer closure shadows the runtime's scoped service packages. Creating
  // one blank session exercises the real Host composition without sending a
  // model request or reading any user data.
  const sessionResponse = await fetch(`${url}/api/session.create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'desktop-profile-runtime-smoke',
      method: 'session.create',
      payload: { cwd: join(root, 'workspace') },
    }),
  })
  if (!sessionResponse.ok) throw new Error(`Session creation smoke returned HTTP ${String(sessionResponse.status)}`)
  const sessionResult = await sessionResponse.json()
  if (sessionResult?.result?.ok !== true || typeof sessionResult.result.value?.sessionId !== 'string') {
    throw new Error(`Session creation smoke failed: ${JSON.stringify(sessionResult)}`)
  }

  console.log(`profile runtime verification passed: ${String(manifest.requiredRuntimePlugins.length)} required plugins`)
} finally {
  if (child !== undefined && child.exitCode === null) {
    await new Promise(resolveExit => {
      const timeout = setTimeout(resolveExit, 8_000)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolveExit()
      })
      child.kill('SIGTERM')
    })
  }
  rmSync(root, { recursive: true, force: true })
}
