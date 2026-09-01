import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scanReleaseTree } from '../src/release-privacy.mjs'

const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const channel = process.env.DSH_DESKTOP_CHANNEL
if (channel !== 'dev' && channel !== 'stable') {
  throw new Error('DSH_DESKTOP_CHANNEL must be either dev or stable')
}
const productName = channel === 'dev' ? 'DeepSeek Harness Dev.app' : 'DeepSeek Harness.app'
const appPath = resolve(process.argv[2] ?? join(desktopDir, 'dist', channel, 'mac-arm64', productName))
if (!existsSync(appPath)) throw new Error(`release App not found: ${appPath}`)

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${basename(command)} failed: ${result.stderr || result.stdout}`)
}

const auditRoot = mkdtempSync(join(tmpdir(), 'dsh-release-privacy-'))
try {
  const resources = join(appPath, 'Contents', 'Resources')
  const extracted = [
    ['runtime', join(resources, 'runtime-bootstrap', 'runtime.tar.gz'), 'tar'],
    ['profile', join(resources, 'profile-bootstrap', 'profile.tar.gz'), 'tar'],
    ['app-asar', join(resources, 'app.asar'), 'asar'],
  ]
  const violations = []
  for (const [label, archive, kind] of extracted) {
    if (!existsSync(archive)) throw new Error(`release archive not found: ${archive}`)
    const destination = join(auditRoot, label)
    mkdirSync(destination, { recursive: true })
    if (kind === 'tar') run('/usr/bin/tar', ['-xzf', archive, '-C', destination])
    else run(join(desktopDir, 'node_modules', '.bin', 'asar'), ['extract', archive, destination])
    violations.push(...scanReleaseTree(destination, { label }))
  }

  if (violations.length > 0) {
    for (const [file, rule] of violations) console.error(`${file}: ${rule}`)
    process.exitCode = 1
  } else {
    console.log(`release privacy verification passed: ${appPath}`)
  }
} finally {
  rmSync(auditRoot, { recursive: true, force: true })
}
