/**
 * Service-health context (opt-in): one compact line per compose service —
 * `dev-api ▲up  dev-db ▲up  worker ▼exited(1)` — injected before the next
 * model request via `agent.inject` (`source: { kind: 'plugin', plugin:
 * 'dsh-docker' }`), so the agent's first instinct on a failing test is
 * checking the right container instead of guessing.
 *
 * Disabled by default (`healthContext.enabled: false`), capped at
 * `maxServices`, and skipped entirely when no compose project is detected.
 * The docker read is TTL-cached so a long debugging session does not pay a
 * `docker compose ps` on every step.
 *
 * @module dsh-docker/health
 */

import { existsSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import { createMessage } from '@deepseek-ai/dsh-llm';
import type { ComposeServiceRow } from './types.ts';
import { resolveProject } from './project.ts';
import type { DockerRunner } from './runner.ts';
import type { ResolvedConfig } from './types.ts';

/** TTL for the per-project health read, in milliseconds. */
const HEALTH_CACHE_TTL_MS = 2000;

interface CacheEntry {
  lines: string[];
  at: number;
}

/** Render one service's health glyph. */
export function healthGlyph(service: ComposeServiceRow): string {
  switch (service.state) {
    case 'running':
      return service.status !== undefined && /healthy/i.test(service.status) ? '▲healthy' : '▲up';
    case 'exited':
      return '▼exited';
    case 'paused':
      return '⏸paused';
    case 'restarting':
      return '↻restarting';
    case 'created':
      return '○created';
    case 'dead':
      return '✕dead';
    default:
      return service.state;
  }
}

/** Render the compact health lines, capped at `maxServices`. */
export function renderHealthLines(services: readonly ComposeServiceRow[], maxServices: number): string[] {
  const capped = services.slice(0, maxServices);
  const lines = capped.map((service) => `${service.name} ${healthGlyph(service)}`);
  if (services.length > maxServices) lines.push(`+${services.length - maxServices} more`);
  return lines;
}

/** Install the opt-in health-context injection. */
export function applyHealth(ctx: Context, runner: DockerRunner, getConfig: () => ResolvedConfig): void {
  const cache = new Map<string, CacheEntry>();

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    const config = getConfig();
    if (!config.enabled || !config.healthContext.enabled) return decision;
    try {
      const cwd = payload.agent.session.header.cwd;
      if (cwd === undefined) return decision;
      const project = resolveProject(cwd, config.composeFiles, (path) => existsSync(path));
      if (project === undefined) return decision;
      const now = Date.now();
      const cached = cache.get(project.project);
      let lines: string[];
      if (cached !== undefined && now - cached.at < HEALTH_CACHE_TTL_MS) {
        lines = cached.lines;
      } else {
        const services = await runner.composePs(project, payload.signal);
        lines = renderHealthLines(services, config.healthContext.maxServices);
        cache.set(project.project, { lines, at: now });
      }
      if (lines.length === 0) return decision;
      const text = `[dsh-docker] ${project.project} services: ${lines.join('  ')}`;
      payload.agent.inject(createMessage({
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-docker' },
      }));
    } catch (error) {
      // Daemon down, compose file broken, agent disposed — the health line is
      // advisory and must never break the step.
      ctx.logger.debug(`dsh-docker: health context skipped (${error instanceof Error ? error.message : String(error)})`);
    }
    return decision;
  });
}
