/** Wire types for active DeepSeek plugin package inventory. */

export interface DeepSeekPluginPackageIdentity {
  readonly name: string
  readonly version: string
}

export interface DeepSeekPluginPackageInventoryExtension {
  readonly version: 1
  readonly packages: readonly DeepSeekPluginPackageIdentity[]
}

declare module '@deepseek-ai/dsh-deepseek-llm-api-extensions/types' {
  interface DeepSeekLlmApiExtensionMap {
    dsh_plugin_packages: DeepSeekPluginPackageInventoryExtension
  }
}
