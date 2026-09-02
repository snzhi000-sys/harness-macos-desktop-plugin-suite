import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const channel = process.argv[2]
if (channel !== 'dev' && channel !== 'stable') throw new Error('channel must be dev or stable')

const productName = channel === 'dev' ? 'DeepSeek Harness Dev' : 'DeepSeek Harness'
const staging = join(desktopDir, 'dist', `.candidate-${channel}`)
const published = join(desktopDir, 'dist', channel)
const appRelative = join('mac-arm64', `${productName}.app`)
const stagingApp = join(staging, appRelative)
const publishedApp = join(published, appRelative)
const publishedExecutable = join(publishedApp, 'Contents', 'MacOS', productName)

const run = (label, script, args) => {
  console.log(`\n[desktop:${channel}] ${label}`)
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: desktopDir,
    env: { ...process.env, DSH_DESKTOP_CHANNEL: channel },
    stdio: 'inherit',
  })
  if (result.status !== 0) throw new Error(`${label} failed with status ${String(result.status)}`)
}

if (!existsSync(stagingApp)) throw new Error(`product candidate is missing: ${stagingApp}`)

// A candidate retained by the main build's running-App guard is publishable
// without rebuilding every dependency, but never without repeating all
// package-level verification against the exact retained bundle.
run('verify release privacy', 'scripts/verify-release-privacy.mjs', [stagingApp])
run('verify product identity and packaged features', 'scripts/verify-product-app.mjs', [channel, stagingApp])
run('verify isolated packaged launch', 'scripts/verify-product-launch.mjs', [channel, stagingApp])

const running = execFileSync('/bin/ps', ['-ax', '-o', 'command='], { encoding: 'utf8' })
  .split('\n')
  .some(command => command.includes(publishedExecutable))
if (running) {
  throw new Error(`refusing to replace a running ${productName}; verified candidate remains at ${stagingApp}`)
}

rmSync(published, { recursive: true, force: true })
mkdirSync(resolve(published, '..'), { recursive: true })
renameSync(staging, published)
if (!existsSync(publishedApp)) throw new Error('published application is missing after atomic rename')
console.log(`\n[desktop:${channel}] published ${publishedApp}`)
