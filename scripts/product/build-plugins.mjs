import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))

function run(label, command, args, cwd) {
  console.log(`\n[product] building ${label}`)
  const result = spawnSync(command, args, { cwd: resolve(root, cwd), stdio: 'inherit', env: process.env })
  if (result.status !== 0) throw new Error(`${label} build failed with status ${String(result.status)}`)
}

run('Better Sidebar', 'npm', ['run', 'build'], 'plugins/better-sidebar')
run('File Edit', 'npm', ['run', 'build:client'], 'plugins/file-edit')
run('Workspace Lineage', 'npm', ['run', 'build'], 'plugins/workspace-lineage')
run('Cowork', 'pnpm', ['build'], 'plugins/cowork')

// The migrated Message Edit source snapshot lacks its historical build script.
// Keep the current runtime verifiable without pretending it is reproducible.
const messageRoot = resolve(root, 'plugins/message-edit')
for (const file of ['index.mjs', 'client.js', 'client.js.map']) {
  if (!existsSync(resolve(messageRoot, file))) throw new Error(`Message Edit runtime snapshot is missing ${file}`)
}
const sourceMap = JSON.parse(readFileSync(resolve(messageRoot, 'client.js.map'), 'utf8'))
if (!Array.isArray(sourceMap.sourcesContent) || sourceMap.sourcesContent.some(value => typeof value !== 'string')) {
  throw new Error('Message Edit source map does not contain its recoverable Client sources')
}
run('Message Edit Host snapshot', process.execPath, ['--check', 'index.mjs'], 'plugins/message-edit')
run('Message Edit Client snapshot', process.execPath, ['--check', 'client.js'], 'plugins/message-edit')
console.warn('[product] Message Edit remains snapshot-only until its missing build source is restored')
