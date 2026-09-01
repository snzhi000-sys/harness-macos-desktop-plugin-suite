/**
 * dsh-docker client plugin: registers the `docker-status` conversation-node
 * Definition and its keyed Chat renderer, so `docker_ps` /
 * `docker_compose_ps` / `docker_logs` output renders as a replayable table —
 * collapsed by default, expandable.
 *
 * @module dsh-docker/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { dockerStatusDefinition, DOCKER_STATUS_KIND } from './definition.ts';
import { DockerStatusView } from './view.ts';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-docker';

/** Services required to load: the conversation-event registry and the slot registry. */
export const inject = ['conversationEvents', 'slots'];

/** Register the Definition and the Chat node renderer. */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(dockerStatusDefinition);
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: DOCKER_STATUS_KIND,
    locale: 'conversation',
  }, DockerStatusView));
}
