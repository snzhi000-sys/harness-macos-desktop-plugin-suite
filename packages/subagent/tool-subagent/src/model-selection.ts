/** Profile-authorized child LLM route selection for the subagent tool. */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'

/** One exact child LLM route authorized by the Profile. */
export interface AllowedModelRoute {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
}

/** Model-facing child LLM creation fields. */
export interface DelegationModelRequest {
  readonly provider?: string
  readonly model?: string
  readonly reasoning_effort?: string
  readonly max_tokens?: number
}

/**
 * Build the stable identity for one Provider/model pair.
 * @param route - exact route to identify.
 * @returns a collision-free key within JavaScript strings.
 */
export function modelRouteKey(route: AllowedModelRoute): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Validate and detach the exact route list at the Profile config boundary.
 * @param routes - configured Profile routes, or absence when selection is disabled.
 * @returns detached routes in configured order.
 */
export function resolveAllowedModelRoutes(routes: readonly AllowedModelRoute[] | undefined): AllowedModelRoute[] {
  if (routes === undefined) return []
  const seen = new Set<string>()
  return routes.map((candidate) => {
    if (typeof candidate.provider !== 'string' || candidate.provider.length === 0
      || typeof candidate.model !== 'string' || candidate.model.length === 0) {
      throw new Error('subagent model selection requires non-empty provider and model ids')
    }
    const route = { provider: candidate.provider, model: candidate.model }
    const key = modelRouteKey(route)
    if (seen.has(key)) {
      throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`)
    }
    seen.add(key)
    return route
  })
}

/**
 * Test whether a call explicitly selects any child LLM creation value.
 * @param request - model-facing delegation arguments.
 * @returns whether selection authorization and preflight are required.
 */
export function hasDelegationModelRequest(request: DelegationModelRequest): boolean {
  return request.provider !== undefined
    || request.model !== undefined
    || request.reasoning_effort !== undefined
    || request.max_tokens !== undefined
}

/**
 * Build the allowed directory from Profile routes and the parent's exact route.
 * @param configured - validated Profile routes.
 * @param parentOptions - current parent creation options.
 * @returns a detached, deduplicated route list.
 */
export function allowedRoutesForParent(
  configured: readonly AllowedModelRoute[],
  parentOptions: AgentOptions,
): AllowedModelRoute[] {
  const routes = configured.map(route => ({ ...route }))
  if (parentOptions.provider === undefined || parentOptions.model === undefined) return routes
  const inherited = { provider: parentOptions.provider, model: parentOptions.model }
  if (!routes.some(route => modelRouteKey(route) === modelRouteKey(inherited))) routes.push(inherited)
  return routes
}

/**
 * Merge model-supplied fields over configured child defaults.
 * @param parentOptions - current parent route and inference values.
 * @param configured - tool-instance child defaults.
 * @param request - model-facing selection arguments.
 * @param enabled - whether this tool instance exposes selection.
 * @returns child options, or the unchanged configured absence.
 */
export function requestedAgentOptions(
  parentOptions: AgentOptions,
  configured: AgentOptions | undefined,
  request: DelegationModelRequest,
  enabled: boolean,
): AgentOptions | undefined {
  if (!hasDelegationModelRequest(request)) return configured
  if (!enabled) throw new Error('child model selection is disabled for this tool instance')
  if ((request.provider === undefined) !== (request.model === undefined)) {
    throw new Error('child LLM `provider` and `model` must be supplied together')
  }
  for (const [field, value] of [
    ['provider', request.provider],
    ['model', request.model],
    ['reasoning_effort', request.reasoning_effort],
  ] as const) {
    if (value !== undefined && value.length === 0) throw new Error(`child LLM \`${field}\` must be non-empty`)
  }
  if (request.max_tokens !== undefined
    && (!Number.isSafeInteger(request.max_tokens) || request.max_tokens <= 0)) {
    throw new Error('child LLM `max_tokens` must be a positive safe integer')
  }

  const baselineProvider = configured?.provider ?? parentOptions.provider
  const baselineModel = configured?.model ?? parentOptions.model
  const routeChanged = request.provider !== undefined
    && (request.provider !== baselineProvider || request.model !== baselineModel)
  const { reasoningEffort: _configuredEffort, ...withoutConfiguredEffort } = configured ?? {}
  return {
    ...routeChanged && request.reasoning_effort === undefined ? withoutConfiguredEffort : configured,
    ...request.provider === undefined ? {} : { provider: request.provider, model: request.model },
    ...request.reasoning_effort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(request.reasoning_effort) },
    ...request.max_tokens === undefined ? {} : { maxTokens: request.max_tokens },
  }
}

/**
 * Enforce Profile and parent authority at the child-creation operation.
 * @param allowed - effective exact-route allowlist.
 * @param parentOptions - current parent route.
 * @param requested - resolved child options.
 * @param request - model-facing selection arguments.
 */
export function assertAllowedModelSelection(
  allowed: readonly AllowedModelRoute[],
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
  request: DelegationModelRequest,
): void {
  if (!hasDelegationModelRequest(request)) return
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot select child LLM values without an effective provider and model')
  }
  if (allowed.some(route => route.provider === provider && route.model === model)) return
  throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session`)
}

/**
 * Resolve a selected child route through its live adapter before creation.
 * @param llm - live LLM directory and resolver.
 * @param parentOptions - current parent route and inference values.
 * @param requested - resolved child options.
 * @param signal - caller cancellation for adapter discovery.
 */
export async function preflightChildLlmRoute(
  llm: LlmRuntime,
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
  signal: AbortSignal,
): Promise<void> {
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot select child LLM values without an effective provider and model')
  }
  const routeChanged = provider !== parentOptions.provider || model !== parentOptions.model
  const reasoningEffort = requested?.reasoningEffort
    ?? (!routeChanged ? parentOptions.reasoningEffort : undefined)
  const maxTokens = requested?.maxTokens ?? parentOptions.maxTokens
  await llm.resolveCallConfig({
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
    ...maxTokens === undefined ? {} : { maxTokens },
  }, signal)
}

/**
 * Fail before registration when a provider would ignore child Agent options.
 * @param provider - configured subagent provider.
 */
export function assertModelSelectionProvider(provider: SubagentProvider): void {
  if (provider.capabilities.agentOptions === true) return
  throw new Error(`tool-subagent: provider "${provider.name}" does not support child agentOptions`)
}
