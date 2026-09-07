/** Active Loader-backed package inventory for official DeepSeek requests. */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Entry, EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { DeepSeekPluginPackageIdentity, DeepSeekPluginPackageInventoryExtension } from './types.ts'
import type {} from './types.ts'

export type * from './types.ts'
export const name = 'plugin-package-inventory-deepseek'
export const inject = ['agents', 'deepseekLlmApiExtensions', 'loader']

export interface Config {
  /** Whether DeepSeek requests include the active package name/version inventory. */
  enabled?: boolean
}
export const Config: z<Config> = z.object({ enabled: z.boolean().default(true) })

interface PackageManifest { readonly name?: unknown; readonly version?: unknown }
interface ActiveEntry { readonly entry: Entry; readonly bareBaseUrl?: string }

function barePackageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.includes(':') || isAbsolute(specifier)) return undefined
  const [first = '', second = ''] = specifier.split('/')
  return first.startsWith('@') ? `${first}/${second}` : first
}

function identityFromManifest(path: string, allowAnonymous: boolean): DeepSeekPluginPackageIdentity | undefined {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
  if (allowAnonymous && manifest.name === undefined) return undefined
  if (typeof manifest.name !== 'string' || manifest.name.length === 0
    || typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`plugin-package-inventory-deepseek: ${path} must declare non-empty name and version`)
  }
  return { name: manifest.name, version: manifest.version }
}

function barePackageManifest(packageName: string, anchors: readonly string[]): string | undefined {
  for (const anchor of anchors) {
    const searchPaths = createRequire(anchor).resolve.paths(packageName)
    if (searchPaths === null) continue
    for (const searchPath of searchPaths) {
      const manifest = join(searchPath, packageName, 'package.json')
      if (existsSync(manifest)) return manifest
    }
  }
  return undefined
}

function nearestManifest(modulePath: string): string | undefined {
  let current = dirname(modulePath)
  const root = parse(current).root
  while (true) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) return manifest
    if (current === root) return undefined
    current = dirname(current)
  }
}

class PackageIdentityResolver {
  private readonly cache = new Map<string, DeepSeekPluginPackageIdentity | undefined>()
  constructor(private readonly hostBaseUrl: string) {}

  resolve({ entry, bareBaseUrl }: ActiveEntry): DeepSeekPluginPackageIdentity | undefined {
    const treeBase = entry.parent.tree.ctx.baseUrl ?? this.hostBaseUrl
    const anchors = [...new Set([bareBaseUrl ?? treeBase, treeBase, this.hostBaseUrl, import.meta.url])]
    const key = `${anchors.join('\u0000')}\u0000${entry.options.name}`
    if (this.cache.has(key)) return this.cache.get(key)
    const packageName = barePackageName(entry.options.name)
    let manifest: string | undefined
    if (packageName !== undefined) {
      manifest = barePackageManifest(packageName, anchors)
      if (manifest === undefined) {
        throw new Error(`plugin-package-inventory-deepseek: cannot resolve active package ${JSON.stringify(packageName)}`)
      }
    } else if (!entry.options.name.startsWith('cordis:')) {
      const moduleUrl = isAbsolute(entry.options.name)
        ? pathToFileURL(entry.options.name)
        : new URL(entry.options.name, treeBase)
      if (moduleUrl.protocol === 'file:') manifest = nearestManifest(fileURLToPath(moduleUrl))
    }
    const identity = manifest === undefined ? undefined : identityFromManifest(manifest, packageName === undefined)
    this.cache.set(key, identity)
    return identity
  }
}

function activeEntries(tree: EntryTree, rootBareBaseUrl?: string): ActiveEntry[] {
  return [...tree.entries()]
    .filter(entry => !entry.options.group && !entry.disabled && entry.fiber?.state === FiberState.ACTIVE)
    .map(entry => ({
      entry,
      ...entry.parent.tree === tree && rootBareBaseUrl !== undefined ? { bareBaseUrl: rootBareBaseUrl } : {},
    }))
}

function compareWireText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function collectActivePluginPackages(
  ctx: Context,
  resolver: PackageIdentityResolver,
  hostBaseUrl: string,
  sessionId?: string,
): Promise<DeepSeekPluginPackageIdentity[]> {
  const entries = activeEntries(ctx.loader)
  if (sessionId !== undefined && ctx.get('agentPresets') !== undefined) {
    const agent = ctx.agents.get(SessionId(sessionId))
    if (agent !== undefined) {
      const { standingMountFor } = await import('@deepseek-ai/dsh-agent-presets')
      const presetTree = standingMountFor(agent.ctx)?.tree
      if (presetTree !== undefined) entries.push(...activeEntries(presetTree, hostBaseUrl))
    }
  }
  const unique = new Map<string, DeepSeekPluginPackageIdentity>()
  for (const activeEntry of entries) {
    const identity = resolver.resolve(activeEntry)
    if (identity !== undefined) unique.set(`${identity.name}\u0000${identity.version}`, identity)
  }
  return [...unique.values()].sort((left, right) =>
    compareWireText(left.name, right.name) || compareWireText(left.version, right.version))
}

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return
  const hostBaseUrl = ctx.baseUrl ?? import.meta.url
  const resolver = new PackageIdentityResolver(hostBaseUrl)
  ctx.deepseekLlmApiExtensions.register('dsh_plugin_packages', {
    prepare: async (request) => {
      const value: DeepSeekPluginPackageInventoryExtension = {
        version: 1,
        packages: await collectActivePluginPackages(ctx, resolver, hostBaseUrl, request.sessionId),
      }
      return { value }
    },
  })
}
