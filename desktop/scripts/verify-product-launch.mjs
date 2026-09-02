import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const channel = process.argv[2]
const appPath = resolve(process.argv[3] ?? '')
if (channel !== 'dev' && channel !== 'stable') throw new Error('channel must be dev or stable')
const productName = channel === 'dev' ? 'DeepSeek Harness Dev' : 'DeepSeek Harness'
const executable = join(appPath, 'Contents', 'MacOS', productName)
const userData = mkdtempSync(join(tmpdir(), `dsh-${channel}-launch-`))
const logPath = join(userData, 'logs', 'desktop.log')
const child = spawn(executable, [`--user-data-dir=${userData}`], { stdio: 'ignore' })

const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
try {
  let ready = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`candidate exited before startup with code ${String(child.exitCode)}`)
    if (existsSync(logPath) && readFileSync(logPath, 'utf8').includes('backend ready at')) {
      ready = true
      break
    }
    await delay(2_000)
  }
  if (!ready) throw new Error(`candidate did not become ready; log: ${logPath}`)
  if (existsSync(join(userData, 'harness', '.credentials.yaml'))) throw new Error('isolated launch imported credentials')
  if (!existsSync(join(userData, 'harness', 'profiles', '.web-bundled-profile-id'))) throw new Error('isolated launch did not install the bundled profile')
  const log = readFileSync(logPath, 'utf8')
  if (!log.includes('packaged runtime') || !log.includes('installed or upgraded bundled clean plugin profile')) {
    throw new Error('isolated launch did not use the packaged runtime and profile')
  }
  const backendUrl = [...log.matchAll(/backend ready at (http:\/\/127\.0\.0\.1:\d+)/g)].at(-1)?.[1]
  if (backendUrl === undefined) throw new Error('isolated launch log did not expose the backend URL')
  const response = await fetch(`${backendUrl}/sidebar/api/app.release-info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const payload = await response.json()
  const info = payload?.value
  if (!response.ok || payload?.ok !== true || info?.channel !== channel) throw new Error('release-info API returned the wrong channel')
  if (typeof info?.builtAt !== 'string' || !Number.isFinite(Date.parse(info.builtAt))) throw new Error('release-info API did not return a valid build time')
  if (typeof info?.version !== 'string' || !/^v\d+\.\d{2}\.\d{2}$/.test(info.version)) throw new Error('release-info API did not return a valid version')
  console.log(`isolated ${productName} launch verified with empty userData`)
} finally {
  if (child.exitCode === null) child.kill('SIGTERM')
  for (let attempt = 0; child.exitCode === null && attempt < 40; attempt += 1) await delay(250)
  if (child.exitCode === null) child.kill('SIGKILL')
  rmSync(userData, { recursive: true, force: true })
}
