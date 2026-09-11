/** Restore only this plugin's browser build dependencies when its lockfile changes. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const hash = createHash('sha256').update(readFileSync('package-lock.json')).digest('hex')
const marker = 'node_modules/.desktop-pet-lock'
if (!existsSync(marker) || readFileSync(marker, 'utf8') !== hash) {
  const result = spawnSync('npm', ['ci', '--workspaces=false', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('Desktop pet dependency installation failed')
  writeFileSync(marker, hash)
}
