import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)))
const result = spawnSync('git', ['ls-files', '-z'], { cwd: repositoryRoot, encoding: 'buffer' })
if (result.status !== 0) throw new Error('Unable to enumerate tracked files')

const files = result.stdout.toString('utf8').split('\0').filter(Boolean)
const forbiddenNames = [
  /(^|\/)\.sessions?(\/|$)/,
  /(^|\/)\.artifacts(\/|$)/,
  /(^|\/)quarantine(\/|$)/,
  /(^|\/)dsh-file-edit-state(\/|$)/,
  /\.(?:sqlite3?|db|p12|mobileprovision)$/i,
  /(^|\/)\.env(?:\.|$)/,
]
const privateMarkers = [
  homedir(),
  ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
  ['-----BEGIN OPENSSH ', 'PRIVATE KEY-----'].join(''),
]
const violations = []

for (const relative of files) {
  const path = resolve(repositoryRoot, relative)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(path)
    if (isAbsolute(target)) violations.push([relative, 'absolute-symlink'])
    continue
  }
  if (!stat.isFile()) continue
  if (forbiddenNames.some(pattern => pattern.test(relative))) violations.push([relative, 'forbidden-state-file'])
  if (stat.size > 5 * 1024 * 1024) continue
  const buffer = readFileSync(path)
  if (buffer.includes(0)) continue
  const content = buffer.toString('utf8')
  if (privateMarkers.some(marker => marker.length > 0 && content.includes(marker))) {
    violations.push([relative, 'private-content-marker'])
  }
}

if (violations.length > 0) {
  for (const [file, rule] of violations) console.error(`${file}: ${rule}`)
  process.exitCode = 1
} else {
  console.log(`privacy verification passed for ${String(files.length)} tracked files`)
}
