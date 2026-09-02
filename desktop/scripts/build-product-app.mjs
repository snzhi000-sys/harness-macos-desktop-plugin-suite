import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const root = resolve(desktopDir, '..')
const channel = process.argv[2]
if (channel !== 'dev' && channel !== 'stable') throw new Error('channel must be dev or stable')

const staging = join(desktopDir, 'dist', `.candidate-${channel}`)
const env = { ...process.env, DSH_DESKTOP_CHANNEL: channel }
const electronVersion = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')).devDependencies.electron

const run = (label, command, args, cwd = desktopDir, commandEnv = env) => {
  console.log(`\n[desktop:${channel}] ${label}`)
  const result = spawnSync(command, args, { cwd, env: commandEnv, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${label} failed with status ${String(result.status)}`)
}

const prepareElectronDist = () => {
  const archiveName = `electron-v${electronVersion}-darwin-arm64.zip`
  const cacheRoot = join(homedir(), 'Library', 'Caches', 'electron')
  const archive = readdirSync(cacheRoot, { recursive: true })
    .map(entry => join(cacheRoot, String(entry)))
    .find(entry => entry.endsWith(`/${archiveName}`))
  if (archive === undefined) throw new Error(`verified Electron cache is missing: ${archiveName}`)
  execFileSync('/usr/bin/unzip', ['-t', archive], { stdio: 'ignore' })
  const electronDist = join(desktopDir, '.artifacts', 'electron-dist', `v${electronVersion}-darwin-arm64`)
  const executable = join(electronDist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  if (!existsSync(executable)) {
    rmSync(electronDist, { recursive: true, force: true })
    mkdirSync(electronDist, { recursive: true })
    execFileSync('/usr/bin/unzip', ['-q', archive, '-d', electronDist])
  }
  return electronDist
}

run('build Harness Host and Client runtime', 'npm', ['run', 'build:lib'], root)
run('build product plugins', process.execPath, ['scripts/product/build-plugins.mjs'], root)
run('test product plugins', process.execPath, ['scripts/product/test-plugins.mjs'], root)
run('test desktop', 'npm', ['test'])
run('verify source privacy', 'npm', ['run', 'verify:source-privacy'])
run('prepare icon', 'npm', ['run', 'prepare:icon'])
run('prepare runtime', 'npm', ['run', 'prepare:runtime'])
run('prepare profile', 'npm', ['run', 'prepare:profile'])
run('verify profile/runtime composition', 'npm', ['run', 'verify:profile-runtime'])
run('prepare release metadata', 'npm', ['run', 'prepare:release'])

rmSync(staging, { recursive: true, force: true })
const electronDist = prepareElectronDist()
run('build Electron candidate', join(desktopDir, 'node_modules', '.bin', 'electron-builder'), [
  '--config', 'electron-builder.config.cjs',
  `--config.directories.output=${staging}`,
  `--config.electronDist=${electronDist}`,
  '--mac', 'dir', '--arm64',
])
run('verify and publish product candidate', process.execPath, ['scripts/publish-product-candidate.mjs', channel])
