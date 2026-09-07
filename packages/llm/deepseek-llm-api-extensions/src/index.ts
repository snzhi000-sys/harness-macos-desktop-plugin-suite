/** Additive top-level field registry for official DeepSeek requests. */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  DeepSeekLlmApiExtensionMap, DeepSeekLlmApiExtensionProvider, DeepSeekLlmApiExtensionRequest,
  DeepSeekLlmApiJson, PreparedDeepSeekLlmApiExtensions,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { deepseekLlmApiExtensions: DeepSeekLlmApiExtensionRegistry }
}

interface ErasedProvider {
  prepare(request: DeepSeekLlmApiExtensionRequest):
    | { readonly value: DeepSeekLlmApiJson; accept?(): void | Promise<void> }
    | undefined
    | Promise<{ readonly value: DeepSeekLlmApiJson; accept?(): void | Promise<void> } | undefined>
}

function freezeJson<T extends DeepSeekLlmApiJson>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Array.isArray(value) ? value : Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

async function acceptAll(callbacks: readonly (() => void | Promise<void>)[]): Promise<void> {
  const outcomes = await Promise.allSettled(callbacks.map(callback => Promise.resolve().then(callback)))
  const failures = outcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    .map(outcome => outcome.reason as unknown)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'DeepSeek LLM API extension acceptance failed')
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const result = await Promise.race([work, aborted.promise])
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Registry of independently owned top-level fields for official DeepSeek requests. */
export class DeepSeekLlmApiExtensionRegistry extends Service {
  private readonly providers = new Map<string, ErasedProvider>()

  constructor(ctx: Context) { super(ctx, 'deepseekLlmApiExtensions') }

  /**
   * Register one field owner for this plugin lifecycle.
   * @param field - Unique top-level DeepSeek request field owned by the provider.
   * @param provider - Lifecycle-bound producer for that field.
   * @returns A disposer that releases field ownership.
   */
  register<K extends keyof DeepSeekLlmApiExtensionMap>(
    field: K,
    provider: DeepSeekLlmApiExtensionProvider<DeepSeekLlmApiExtensionMap[K]>,
  ): () => Promise<void> {
    const fieldName = field as string
    if (fieldName.length === 0 || fieldName.trim() !== fieldName) {
      throw new Error('deepseek-llm-api-extensions: field must be a non-blank trimmed string')
    }
    const erased = provider as ErasedProvider
    return this.ctx.effect(() => {
      if (this.providers.has(fieldName)) {
        throw new Error(`deepseek-llm-api-extensions: field ${JSON.stringify(fieldName)} is already registered`)
      }
      this.providers.set(fieldName, erased)
      return () => { this.providers.delete(fieldName) }
    }, `deepseekLlmApiExtensions.register(${JSON.stringify(fieldName)})`)
  }

  /**
   * Prepare a detached extension snapshot and one joint acceptance transaction.
   * @param request - Exact serialized request facts and cancellation signal.
   * @returns Frozen fields plus an idempotent post-2xx acceptance callback.
   */
  async prepare(request: DeepSeekLlmApiExtensionRequest): Promise<PreparedDeepSeekLlmApiExtensions> {
    request.signal.throwIfAborted()
    const prepared = await abortable(Promise.all([...this.providers.entries()].map(async ([field, provider]) => ({
      field,
      result: await provider.prepare(request),
    }))), request.signal)
    const fields: Record<string, DeepSeekLlmApiJson> = Object.create(null) as Record<string, DeepSeekLlmApiJson>
    const callbacks: Array<() => void | Promise<void>> = []
    for (const { field, result } of prepared) {
      if (result === undefined) continue
      fields[field] = freezeJson(structuredClone(result.value))
      if (result.accept !== undefined) callbacks.push(result.accept.bind(result))
    }
    Object.freeze(fields)
    let acceptance: Promise<void> | undefined
    return { fields, accept: () => acceptance ??= acceptAll(callbacks) }
  }
}

export default DeepSeekLlmApiExtensionRegistry
