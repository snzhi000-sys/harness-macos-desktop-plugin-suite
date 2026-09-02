import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const channel = process.env.DSH_DESKTOP_CHANNEL
if (channel !== 'dev' && channel !== 'stable') {
  throw new Error('DSH_DESKTOP_CHANNEL must be either dev or stable')
}

const outputRoot = resolve(desktopDir, 'dist', channel)
const expectedParent = resolve(desktopDir, 'dist')
if (outputRoot === expectedParent || outputRoot === desktopDir || !outputRoot.startsWith(`${expectedParent}/`)) {
  throw new Error(`refusing to clean unsafe output path: ${outputRoot}`)
}

if (existsSync(outputRoot)) rmSync(outputRoot, { recursive: true, force: true })
console.log(`cleaned ${outputRoot}`)
