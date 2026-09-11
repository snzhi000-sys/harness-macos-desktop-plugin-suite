/** Launch the local research characters in an isolated Dev profile; original downloads remain untouched. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const suite = fileURLToPath(new URL('../../../', import.meta.url))
const app = resolve(process.env.DSH_PET_TEST_APP ?? join(suite, 'desktop/dist/dev/mac-arm64/DeepSeek Harness Dev.app'))
if (!app.endsWith('/DeepSeek Harness Dev.app') || !existsSync(app)) throw new Error('需要已构建的独立 Dev App')
const artifacts = join(suite, 'desktop/.artifacts')
const userData = join(artifacts, 'desktop-pet-v2-demo-user-data')
mkdirSync(userData, { recursive: true })
if (!existsSync(join(userData, 'desktop-pet-window.json'))) writeFileSync(join(userData, 'desktop-pet-window.json'), JSON.stringify({ visible: true, height: 520 }), { mode: 0o600 })
const child = spawn(join(app, 'Contents/MacOS/DeepSeek Harness Dev'), [`--user-data-dir=${userData}`], { detached: true, stdio: 'ignore' })
child.on('error', error => { console.error(error.message); process.exitCode = 1 }); child.unref()
console.log(`已启动 Live2D 独立体验版，进程 ${child.pid}`)
