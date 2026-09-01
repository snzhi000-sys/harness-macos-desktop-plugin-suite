import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = fileURLToPath(new URL('..', import.meta.url))
const path = join(desktopDir, 'release-info.json')
const channel = process.env.DSH_DESKTOP_CHANNEL
if (channel !== 'dev' && channel !== 'stable') throw new Error('DSH_DESKTOP_CHANNEL must be dev or stable')
const current = JSON.parse(readFileSync(path, 'utf8'))
const match = /^v(\d+)\.(\d{2})\.(\d{2})$/.exec(current.version)
if (match === null) throw new Error('release-info.json has an invalid version')
let major = Number(match[1])
let minor = Number(match[2])
let patch = Number(match[3]) + 1
if (patch > 99) { patch = 0; minor += 1 }
if (minor > 99) { minor = 0; major += 1 }
const next = { version: `v${String(major)}.${String(minor).padStart(2, '0')}.${String(patch).padStart(2, '0')}`, builtAt: new Date().toISOString(), channel }
const staging = `${path}.next`
writeFileSync(staging, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 })
renameSync(staging, path)
console.log(`release info prepared: ${next.version} (${channel})`)
