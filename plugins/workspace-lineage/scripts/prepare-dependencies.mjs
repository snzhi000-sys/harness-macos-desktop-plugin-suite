import { lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const suiteRoot = resolve(pluginRoot, '../..')
const betterSidebarRoot = resolve(suiteRoot, 'plugins/better-sidebar')

const links = new Map([
  ['@deepseek-ai/cordis', 'node_modules/@deepseek-ai/cordis'],
  ['@deepseek-ai/dsh-agent', 'node_modules/@deepseek-ai/dsh-agent'],
  ['@deepseek-ai/dsh-client-locale', 'node_modules/@deepseek-ai/dsh-client-locale'],
  ['@deepseek-ai/dsh-client-runtime', 'node_modules/@deepseek-ai/dsh-client-runtime'],
  ['@deepseek-ai/dsh-client-schema-form', 'node_modules/@deepseek-ai/dsh-client-schema-form'],
  ['@deepseek-ai/dsh-client-ui-conversation', 'node_modules/@deepseek-ai/dsh-client-ui-conversation'],
  ['@deepseek-ai/dsh-client-ui-primitives', 'node_modules/@deepseek-ai/dsh-client-ui-primitives'],
  ['@deepseek-ai/dsh-client-ui-settings', 'node_modules/@deepseek-ai/dsh-client-ui-settings'],
  ['@deepseek-ai/dsh-client-ui-slots', 'node_modules/@deepseek-ai/dsh-client-ui-slots'],
  ['@deepseek-ai/dsh-client-web-react', 'node_modules/@deepseek-ai/dsh-client-web-react'],
  ['@deepseek-ai/dsh-host-webserver', 'node_modules/@deepseek-ai/dsh-host-webserver'],
  ['@deepseek-ai/dsh-invariants', 'node_modules/@deepseek-ai/dsh-invariants'],
  ['@deepseek-ai/dsh-llm', 'node_modules/@deepseek-ai/dsh-llm'],
  ['@deepseek-ai/dsh-session', 'node_modules/@deepseek-ai/dsh-session'],
  ['@deepseek-ai/dsh-settings', 'node_modules/@deepseek-ai/dsh-settings'],
  ['@deepseek-ai/dsh-tools', 'node_modules/@deepseek-ai/dsh-tools'],
  ['clsx', 'node_modules/clsx'],
  ['react', 'node_modules/react'],
  ['@types/react', 'node_modules/@types/react'],
])

links.set('@deepseek-ai/dsh-client-ui-sidebar', resolve(suiteRoot, 'packages/client/ui-sidebar'))

async function ensureLink(name, source) {
  const target = resolve(pluginRoot, 'node_modules', name)
  const sourcePath = source.startsWith('/') ? source : resolve(betterSidebarRoot, source)
  await lstat(sourcePath)
  await mkdir(dirname(target), { recursive: true })

  try {
    const stat = await lstat(target)
    if (!stat.isSymbolicLink()) {
      throw new Error(`refusing to replace non-symlink dependency: ${target}`)
    }
    const current = resolve(dirname(target), await readlink(target))
    if (current === sourcePath) return
    await unlink(target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  await symlink(relative(dirname(target), sourcePath), target, 'dir')
}

for (const [name, source] of links) await ensureLink(name, source)

console.log(`[workspace-lineage] prepared ${links.size} local dependency links`)
