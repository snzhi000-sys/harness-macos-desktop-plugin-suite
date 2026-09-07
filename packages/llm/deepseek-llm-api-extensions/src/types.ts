/** Provider-specific JSON and contribution types for DeepSeek request extensions. */

export type DeepSeekLlmApiJson =
  | null | boolean | number | string | DeepSeekLlmApiJson[] | { [key: string]: DeepSeekLlmApiJson }

/** Declaration-merged table of top-level DeepSeek request extension fields. */
export interface DeepSeekLlmApiExtensionMap {}

/** Exact serialized request facts visible to extension providers. */
export interface DeepSeekLlmApiExtensionRequest {
  readonly body: Readonly<Record<string, DeepSeekLlmApiJson>>
  readonly sessionId?: string
  readonly purpose?: 'compaction' | 'session-title'
  readonly signal: AbortSignal
}

/** One prepared field and its optional post-2xx commit. */
export interface PreparedDeepSeekLlmApiExtension<T extends DeepSeekLlmApiJson> {
  readonly value: T
  accept?(): void | Promise<void>
}

/** Provider registered under one extension field. */
export interface DeepSeekLlmApiExtensionProvider<T extends DeepSeekLlmApiJson> {
  prepare(request: DeepSeekLlmApiExtensionRequest):
    | PreparedDeepSeekLlmApiExtension<T>
    | undefined
    | Promise<PreparedDeepSeekLlmApiExtension<T> | undefined>
}

/** Prepared fields and their idempotent joint acceptance transaction. */
export interface PreparedDeepSeekLlmApiExtensions {
  readonly fields: Readonly<Partial<DeepSeekLlmApiExtensionMap>>
  accept(): Promise<void>
}
