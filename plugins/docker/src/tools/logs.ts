/**
 * `docker_logs`: bounded, non-streaming log pull with an honest truncation
 * flag. Pulls `tail + 1` lines so a capped pull never reads as complete.
 *
 * @module dsh-docker/tools/logs
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools';
import type { DockerRunner } from '../runner.ts';
import { resolveContainerRef } from '../project.ts';
import type { LogsOutput, ResolvedConfig } from '../types.ts';
import { cwdOf, projectOf, toMeta } from './shared.ts';

/** Hard cap on one `docker_logs` tail request. */
export const MAX_LOG_TAIL = 5000;

/** Register the `docker_logs` tool. */
export function applyLogsTool(ctx: Context, runner: DockerRunner, getConfig: () => ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'docker_logs',
    description: 'Pull the last N log lines of a container (bounded, non-streaming). The truncated flag is true when older lines were dropped by the tail cap.',
    parameters: {
      container: { type: 'string', required: true, description: 'Container name, id prefix, or compose service name.' },
      tail: { type: 'integer', description: `Number of lines to pull (default 200, max ${MAX_LOG_TAIL}).` },
      project: { type: 'string', description: 'Explicit compose project name; skips detection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lines: { type: 'array', required: true, items: { type: 'string' } },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as LogsOutput;
        const body = v.lines.length === 0 ? '(no log lines)' : v.lines.join('\n');
        const note = v.truncated ? '\n> (truncated: older lines were dropped by the tail cap)' : '';
        return [{ type: 'text', text: `${body}${note}` }];
      },
      presentationMeta: (_args: unknown, value: unknown) => {
        const v = value as LogsOutput;
        return toMeta({ tool: 'docker_logs', lines: v.lines, truncated: v.truncated });
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<LogsOutput> {
      const a = args as { container: string; tail?: number; project?: string };
      const tail = a.tail === undefined ? 200 : a.tail;
      if (!Number.isInteger(tail) || tail < 0) {
        throw new Error(`docker_logs: tail must be a non-negative integer (got ${String(a.tail)})`);
      }
      if (tail > MAX_LOG_TAIL) {
        throw new Error(`docker_logs: tail ${tail} exceeds the cap of ${MAX_LOG_TAIL}`);
      }
      const project = projectOf(exec, getConfig(), a.project);
      const containers = await runner.ps({ all: true, project: project?.project, signal: exec.signal });
      const resolved = resolveContainerRef(a.container, project, containers);
      if (!resolved.ok) throw new Error(resolved.error);
      return runner.logs(resolved.ref, tail, exec.signal);
    },
    presentCall(args): GenericCallView {
      const a = args as { container: string; tail?: number };
      return { card: 'generic', title: `Logs of ${a.container}`, kind: 'read' };
    },
  }));
}
