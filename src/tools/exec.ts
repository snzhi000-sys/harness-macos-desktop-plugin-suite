/**
 * `docker_exec`: run a command inside a container. Read-only by default —
 * no TTY, no write flag — and free of approval; `write: true` or
 * `interactive: true` reclassifies the call into the approval bucket.
 * Non-zero exits are a successful domain outcome carried in the canonical
 * value, never a thrown error.
 *
 * @module dsh-docker/tools/exec
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type TerminalCallView } from '@deepseek-ai/dsh-tools';
import type { DockerRunner } from '../runner.ts';
import { resolveContainerRef } from '../project.ts';
import type { ExecOutput, ResolvedConfig } from '../types.ts';
import { cwdOf, projectOf, toMeta } from './shared.ts';

/** Cap on the captured exec output (per stream). */
const EXEC_OUTPUT_BYTES = 4_194_304;

/** Register the `docker_exec` tool. */
export function applyExecTool(ctx: Context, runner: DockerRunner, getConfig: () => ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'docker_exec',
    description: 'Run a command inside a container (no TTY by default — read-only stance). Setting write or interactive routes the call through the approval gate.',
    parameters: {
      container: { type: 'string', required: true, description: 'Container name, id prefix, or compose service name.' },
      command: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Command argv, e.g. ["sh", "-c", "ls -la"].',
      },
      interactive: { type: 'boolean', description: 'Allocate a TTY and keep stdin open (docker exec -it). Requires approval.' },
      write: { type: 'boolean', description: 'Declare the command may mutate the container (writes files, sends signals, …). Requires approval.' },
      project: { type: 'string', description: 'Explicit compose project name; skips detection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as ExecOutput;
        const parts: string[] = [];
        if (v.stdout !== '') parts.push(v.stdout);
        if (v.stderr !== '') parts.push(v.stderr);
        const body = parts.length === 0 ? '(no output)' : parts.join('\n');
        return [{ type: 'text', text: v.exitCode === 0 ? body : `${body}\n> exit code: ${String(v.exitCode)}` }];
      },
      presentationMeta: (_args: unknown, value: unknown) => {
        const v = value as ExecOutput;
        return toMeta({ tool: 'docker_exec', exitCode: v.exitCode, truncated: false });
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<ExecOutput> {
      const a = args as { container: string; command: string[]; interactive?: boolean; project?: string };
      if (!Array.isArray(a.command) || a.command.length === 0 || a.command.some((part) => typeof part !== 'string' || part === '')) {
        throw new Error('docker_exec: command must be a non-empty array of non-empty strings');
      }
      const project = projectOf(exec, getConfig(), a.project);
      const containers = await runner.ps({ all: true, project: project?.project, signal: exec.signal });
      const resolved = resolveContainerRef(a.container, project, containers);
      if (!resolved.ok) throw new Error(resolved.error);
      const argv = ['exec', ...(a.interactive === true ? ['-it'] : []), resolved.ref, ...a.command];
      const result = await runner.run(argv, { signal: exec.signal, workdir: cwdOf(exec), stdoutMaxBytes: EXEC_OUTPUT_BYTES });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    presentCall(args): TerminalCallView {
      const a = args as { container: string; command: string[] };
      return {
        card: 'terminal',
        title: `docker exec ${a.container} ${a.command.join(' ')}`,
        description: 'Runs inside the container',
      };
    },
  }));
}
