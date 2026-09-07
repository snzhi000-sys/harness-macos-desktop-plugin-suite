/** Model-facing discovery of Profile-authorized child LLM routes. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import { allowedRoutesForParent, type AllowedModelRoute } from './model-selection.ts'

interface ListSubagentModelsRequest {
  readonly provider?: string
  readonly model?: string
}

function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('list_subagent_models requires a calling agent')
  return agent
}

function modelLine(provider: string, model: { id: string; name: string; description?: string }): string {
  return `${provider}/${model.id} — ${model.name}${model.description === undefined ? '' : `: ${model.description}`}`
}

async function listAuthorizedModels(
  ctx: Context,
  configured: readonly AllowedModelRoute[],
  parent: Agent,
  request: ListSubagentModelsRequest,
  signal: AbortSignal,
): Promise<string> {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('cannot discover child LLM routes because the `llm` service is unavailable')
  if (request.model !== undefined && request.provider === undefined) throw new Error('`model` requires `provider`')
  const allowed = allowedRoutesForParent(configured, parentAgentOptionsForDelegation(parent))
  if (request.provider === undefined) {
    const providers = llm.listProviders().filter(provider => allowed.some(route => route.provider === provider.id))
    return providers.length === 0
      ? '(no authorized LLM providers)'
      : providers.map(provider => `${provider.id} — ${provider.name}`).join('\n')
  }
  if (request.provider.length === 0) throw new Error('`provider` must be non-empty')
  const routes = allowed.filter(route => route.provider === request.provider)
  if (routes.length === 0) throw new Error(`LLM provider "${request.provider}" is not allowed for this Session`)
  const provider = llm.listProviders().find(candidate => candidate.id === request.provider)
  if (provider === undefined) throw new Error(`LLM provider "${request.provider}" is not registered`)
  if (request.model === undefined) {
    const models = (await llm.listModels(provider.id)).filter(model => routes.some(route => route.model === model.id))
    return models.length === 0
      ? `(no authorized advertised models for ${provider.id})`
      : models.map(model => modelLine(provider.id, model)).join('\n')
  }
  if (request.model.length === 0) throw new Error('`model` must be non-empty')
  if (!routes.some(route => route.model === request.model)) {
    throw new Error(`child LLM route "${provider.id}/${request.model}" is not allowed for this Session`)
  }
  const model = await llm.resolveModelInfo(provider.id, request.model, signal)
  const efforts = model.reasoning?.efforts.map(effort => (
    `${effort.id}${model.reasoning?.defaultEffort === effort.id ? ' (default)' : ''} — ${effort.name}`
    + (effort.description === undefined ? '' : `: ${effort.description}`)
  )).join('\n') || '(no advertised reasoning efforts)'
  return `${modelLine(provider.id, model)}\nReasoning efforts:\n${efforts}`
}

/**
 * Register the fixed, authorization-filtered child-model discovery tool.
 * @param ctx - tool and LLM service context.
 * @param configured - validated Profile route allowlist.
 * @returns the tool registration disposer.
 */
export function registerListSubagentModels(
  ctx: Context,
  configured: readonly AllowedModelRoute[],
): () => void {
  return ctx.tools.register(defineTool({
    name: 'list_subagent_models',
    description:
      'Discover Provider, model, and reasoning-effort ids authorized for child agents. Call with no '
      + 'arguments to list providers, with `provider` to list its models, or with both fields to inspect '
      + 'one model. Results include only the current parent route and exact Profile-authorized routes.',
    parameters: {
      provider: { type: 'string', description: 'Authorized LLM provider id. Omit to list providers.' },
      model: { type: 'string', description: 'Exact model id. Requires provider.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: result }],
    },
    execute(args, exec) {
      return listAuthorizedModels(ctx, configured, requireAgent(exec.agent), args, exec.signal)
    },
  }))
}
