import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import * as PluginInventory from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
const SIGNAL = new AbortController().signal

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function packagePlugin(
  root: string,
  dir: string,
  manifest: object,
  source = 'export default () => {}\n',
): Promise<string> {
  const packageDir = join(root, dir)
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({ type: 'module', ...manifest })}\n`)
  await writeFile(join(packageDir, 'plugin.mjs'), source)
  return `./${dir}/plugin.mjs`
}

async function harness(enabled?: boolean): Promise<{ ctx: Context; root: string; disposeInventory: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-packages-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(join(root, 'cordis.yml')).href
  await ctx.plugin(Loader)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
  const inventory = enabled === undefined ? ctx.plugin(PluginInventory) : ctx.plugin(PluginInventory, { enabled })
  await inventory
  return { ctx, root, disposeInventory: () => inventory.dispose() }
}

describe('DeepSeek plugin package inventory', () => {
  it('contributes by default and can be explicitly disabled', async () => {
    const defaultHarness = await harness()
    const defaultFields = await defaultHarness.ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL })
    expect(defaultFields.fields).toHaveProperty('dsh_plugin_packages')

    const disabledHarness = await harness(false)
    const disabledFields = await disabledHarness.ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL })
    expect(disabledFields.fields).not.toHaveProperty('dsh_plugin_packages')
  })

  it('reports only active package names and versions, deduplicated and stably sorted', async () => {
    const { ctx, root } = await harness()
    const oneA = await packagePlugin(root, 'one-a', { name: 'one', version: '1.0.0', privatePath: '/secret' })
    const oneB = await packagePlugin(root, 'one-b', { name: 'one', version: '2.0.0' })
    const alpha = await packagePlugin(root, 'alpha', { name: 'alpha', version: '3.0.0' })
    const disabled = await packagePlugin(root, 'disabled', { name: 'disabled', version: '1.0.0' })
    await mkdir(join(root, 'loose'), { recursive: true })
    await writeFile(join(root, 'loose/plugin.mjs'), 'export default () => {}\n')

    await ctx.loader.create({ name: oneA })
    await ctx.loader.create({ name: oneA })
    await ctx.loader.create({ name: oneB })
    await ctx.loader.create({ name: alpha })
    await ctx.loader.create({ name: disabled, disabled: true })
    await ctx.loader.create({ name: './loose/plugin.mjs' })

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL })
    expect(prepared.fields.dsh_plugin_packages).toEqual({
      version: 1,
      packages: [
        { name: 'alpha', version: '3.0.0' },
        { name: 'one', version: '1.0.0' },
        { name: 'one', version: '2.0.0' },
      ],
    })
    expect(JSON.stringify(prepared.fields.dsh_plugin_packages)).not.toContain(root)
    expect(JSON.stringify(prepared.fields.dsh_plugin_packages)).not.toContain('privatePath')
  })

  it('rejects malformed identity metadata instead of reporting a partial identity', async () => {
    const { ctx, root } = await harness()
    const bad = await packagePlugin(root, 'bad', { name: 'bad' })
    await ctx.loader.create({ name: bad })
    await expect(ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL }))
      .rejects.toThrow(/must declare non-empty name and version/)
  })

  it('omits loose modules and supports an embedding without a base URL', async () => {
    const { ctx, root } = await harness()
    const marker = await packagePlugin(root, 'marker-only', {})
    await ctx.loader.create({ name: marker })
    await expect(ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL }))
      .resolves.toMatchObject({ fields: { dsh_plugin_packages: { version: 1, packages: [] } } })

    const direct = new Context()
    contexts.push(direct)
    await direct.plugin(Loader)
    await direct.plugin(AgentRegistry)
    await direct.plugin(DeepSeekLlmApiExtensionRegistry)
    await direct.plugin(PluginInventory)
    await expect(direct.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL }))
      .resolves.toMatchObject({ fields: { dsh_plugin_packages: { version: 1, packages: [] } } })
  })

  it('withdraws the field when the contributing plugin unloads', async () => {
    const { ctx, disposeInventory } = await harness()
    expect((await ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL })).fields)
      .toHaveProperty('dsh_plugin_packages')
    await disposeInventory()
    expect((await ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL })).fields)
      .not.toHaveProperty('dsh_plugin_packages')
  })
})
