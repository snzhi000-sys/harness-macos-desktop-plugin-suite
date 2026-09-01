import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))

function run(label, command, args, cwd) {
  console.log(`\n[product] testing ${label}`)
  const result = spawnSync(command, args, { cwd: resolve(root, cwd), stdio: 'inherit', env: process.env })
  if (result.status !== 0) throw new Error(`${label} tests failed with status ${String(result.status)}`)
}

run('Better Sidebar', 'npm', ['test'], 'plugins/better-sidebar')
run('File Edit', 'npm', ['test'], 'plugins/file-edit')
run('Workspace Lineage', resolve(root, 'node_modules/.bin/vitest'), ['run', '--config', 'vitest.config.ts'], 'plugins/workspace-lineage')
run('Cowork', 'pnpm', ['test'], 'plugins/cowork')
run('Message Edit Host snapshot', process.execPath, ['--check', 'index.mjs'], 'plugins/message-edit')
run('Message Edit Client snapshot', process.execPath, ['--check', 'client.js'], 'plugins/message-edit')
