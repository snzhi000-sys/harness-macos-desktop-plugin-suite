/**
 * The replayable conversation-node Definition behind the dsh-docker status
 * renderer: one stable id per docker tool call (`tool/call` callId), state
 * built from the call arguments and the `tool/result` `presentationMeta`
 * (which is persisted on the durable log, so replay reproduces the same
 * table without the canonical value). Pure of I/O and clock — the assembler
 * calls these on live streaming AND session-log replay.
 *
 * @module dsh-docker/client/definition
 */

import type {
  ConversationLocation,
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import { isStatusMeta, type DockerStatusChatData, type DockerStatusMeta, type DockerStatusTool } from './types.ts';

/** The Definition kind. */
export const DOCKER_STATUS_KIND = 'docker-status';

/** The tools this Definition renders. */
const STATUS_TOOLS = new Set<string>(['docker_ps', 'docker_compose_ps', 'docker_logs']);

/** The Definition-local state for one tool call. */
export interface DockerStatusState {
  readonly tool: DockerStatusTool;
  readonly args: Readonly<Record<string, unknown>>;
  readonly meta: DockerStatusMeta | undefined;
  readonly settled: boolean;
}

/** Extract the status tool from one event, or undefined. */
function statusToolOf(event: SessionEvent): DockerStatusTool | undefined {
  if (event.type === 'tool/call') {
    const name = event.data.name;
    return STATUS_TOOLS.has(name) ? (name as DockerStatusTool) : undefined;
  }
  if (event.type === 'tool/result' && isStatusMeta(event.data.meta)) {
    return event.data.meta.tool;
  }
  return undefined;
}

/** Extract the stable callId from one event, or undefined. */
function callIdOf(event: SessionEvent): string | undefined {
  if (event.type === 'tool/call') return String(event.data.callId);
  if (event.type === 'tool/result') {
    const content = event.data.message.content;
    const block = Array.isArray(content) ? content[0] : undefined;
    if (typeof block === 'object' && block !== null && 'toolCallId' in block) {
      return String((block as { toolCallId: unknown }).toolCallId);
    }
  }
  return undefined;
}

/** Parse the durable `tool/call` arguments JSON defensively. */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Title for one call, derived from args. */
function titleOf(tool: DockerStatusTool, args: Readonly<Record<string, unknown>>): string {
  switch (tool) {
    case 'docker_ps':
      return args.all === true ? 'All containers' : 'Containers';
    case 'docker_compose_ps':
      return 'Compose services';
    case 'docker_logs':
      return `Logs of ${typeof args.container === 'string' ? args.container : 'container'}`;
  }
}

/** Resolve the location of one Context for the view node. */
function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' };
}

/** Project the State into the renderer-ready chat payload. */
function viewData(state: DockerStatusState): DockerStatusChatData {
  const base: DockerStatusChatData = {
    tool: state.tool,
    title: titleOf(state.tool, state.args),
    settled: state.settled,
  };
  const meta = state.meta;
  if (meta === undefined) return base;
  switch (meta.tool) {
    case 'docker_ps':
      return { ...base, rows: meta.rows };
    case 'docker_compose_ps':
      return { ...base, project: meta.project, rows: meta.rows };
    case 'docker_logs':
      return { ...base, lines: meta.lines, truncated: meta.truncated };
  }
}

/** The Definition registered with `ctx.conversationEvents`. */
export const dockerStatusDefinition: ConversationNodeDefinition<DockerStatusState> = {
  kind: DOCKER_STATUS_KIND,
  target: 'chat',
  match: (event) => {
    const tool = statusToolOf(event);
    if (tool === undefined) return null;
    const id = callIdOf(event);
    if (id === undefined) return null;
    return { id, role: event.type === 'tool/call' ? 'start' : 'update' };
  },
  start: (_context, match) => {
    if (match.event.type !== 'tool/call') throw new Error(`${DOCKER_STATUS_KIND} requires a tool/call start`);
    const tool = statusToolOf(match.event);
    if (tool === undefined) throw new Error(`${DOCKER_STATUS_KIND} start event carries no status tool`);
    return {
      tool,
      args: parseArguments(match.event.data.arguments),
      meta: undefined,
      settled: false,
    };
  },
  update: (context, match) => {
    if (match.event.type === 'tool/result' && isStatusMeta(match.event.data.meta)) {
      return { ...context.state, meta: match.event.data.meta, settled: true };
    }
    return context.state;
  },
  publication: (match: ConversationMatch) => (match.event.type === 'tool/result' ? 'immediate' : 'animation-frame'),
  buildViewNode: (context) => {
    if (context.state === undefined) return null;
    return {
      key: context.key,
      kind: DOCKER_STATUS_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: locationOf(context),
      visibility: 'visible',
      data: viewData(context.state),
    };
  },
};
