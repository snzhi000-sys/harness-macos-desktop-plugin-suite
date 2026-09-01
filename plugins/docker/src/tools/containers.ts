/**
 * Container lifecycle tools: `docker_ps`, `docker_start`, `docker_stop`,
 * `docker_restart`, and `docker_rm`. All typed, all structured JSON output.
 *
 * `start`/`stop`/`restart` accept a container ref or, with no ref, act on
 * the whole detected compose project; with neither, they fail with a clear
 * error instead of guessing.
 *
 * @module dsh-docker/tools/containers
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type GenericCallView, type ToolExecution } from '@deepseek-ai/dsh-tools';
import type { DockerRunner } from '../runner.ts';
import { resolveContainerRef } from '../project.ts';
import type { AffectedOutput, ContainerRow, PsOutput, ResolvedConfig } from '../types.ts';
import { cwdOf, projectOf, renderContainerLine, toMeta } from './shared.ts';

const containerRowSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    id: { type: 'string' as const, required: true as const },
    name: { type: 'string' as const, required: true as const },
    image: { type: 'string' as const, required: true as const },
    state: { type: 'string' as const, required: true as const },
    status: { type: 'string' as const, required: true as const },
    ports: { type: 'array' as const, required: true as const, items: { type: 'string' as const } },
    project: { type: 'string' as const },
    service: { type: 'string' as const },
  },
};

const affectedSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    affected: { type: 'array' as const, required: true as const, items: { type: 'string' as const } },
  },
};

/** Register the container lifecycle tools. */
export function applyContainerTools(ctx: Context, runner: DockerRunner, getConfig: () => ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'docker_ps',
    description: 'List containers with structured rows (id, name, image, state, status, ports, compose project/service). Scoped to the detected compose project when one exists.',
    parameters: {
      all: { type: 'boolean', description: 'Include stopped containers (docker ps -a). Defaults to false.' },
      project: { type: 'string', description: 'Explicit compose project name to scope to; skips detection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          containers: { type: 'array', required: true, items: containerRowSchema },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as PsOutput;
        if (v.containers.length === 0) return [{ type: 'text', text: '(no containers)' }];
        return [{ type: 'text', text: v.containers.map(renderContainerLine).join('\n') }];
      },
      presentationMeta: (_args: unknown, value: unknown) => {
        const v = value as PsOutput;
        return toMeta({ tool: 'docker_ps', rows: v.containers });
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<PsOutput> {
      const a = args as { all?: boolean; project?: string };
      const project = projectOf(exec, getConfig(), a.project);
      const containers = await runner.ps({ all: a.all === true, project: project?.project, signal: exec.signal });
      return { containers };
    },
    presentCall(args): GenericCallView {
      const a = args as { all?: boolean; project?: string };
      return { card: 'generic', title: a.all === true ? 'List all containers' : 'List containers', kind: 'search' };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'docker_start',
    description: 'Start a container (by name, id prefix, or compose service within the detected project). With no ref, start every container of the detected compose project.',
    parameters: {
      container: { type: 'string', description: 'Container name, id prefix, or compose service name.' },
      project: { type: 'string', description: 'Explicit compose project name; skips detection.' },
    },
    output: {
      schema: affectedSchema,
      render: (_args: unknown, value: unknown) => {
        const v = value as AffectedOutput;
        return [{ type: 'text', text: v.affected.length === 0 ? 'nothing to start' : `started: ${v.affected.join(', ')}` }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<AffectedOutput> {
      const a = args as { container?: string; project?: string };
      const project = projectOf(exec, getConfig(), a.project);
      const targets = await resolveTargets(runner, exec, a.container, project, 'start');
      const result = await runner.runOrThrow(['start', ...targets], { signal: exec.signal, workdir: cwdOf(exec) });
      return { affected: result.exitCode === 0 ? targets : [] };
    },
    presentCall(args): GenericCallView {
      const a = args as { container?: string };
      return { card: 'generic', title: a.container === undefined ? 'Start project containers' : `Start ${a.container}`, kind: 'execute' };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'docker_stop',
    description: 'Stop a container (by name, id prefix, or compose service within the detected project). With no ref, stop every container of the detected compose project.',
    parameters: {
      container: { type: 'string', description: 'Container name, id prefix, or compose service name.' },
      project: { type: 'string', description: 'Explicit compose project name; skips detection.' },
    },
    output: {
      schema: affectedSchema,
      render: (_args: unknown, value: unknown) => {
        const v = value as AffectedOutput;
        return [{ type: 'text', text: v.affected.length === 0 ? 'nothing to stop' : `stopped: ${v.affected.join(', ')}` }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<AffectedOutput> {
      const a = args as { container?: string; project?: string };
      const project = projectOf(exec, getConfig(), a.project);
      const targets = await resolveTargets(runner, exec, a.container, project, 'stop');
      await runner.runOrThrow(['stop', ...targets], { signal: exec.signal, workdir: cwdOf(exec) });
      return { affected: targets };
    },
    presentCall(args): GenericCallView {
      const a = args as { container?: string };
      return { card: 'generic', title: a.container === undefined ? 'Stop project containers' : `Stop ${a.container}`, kind: 'execute' };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'docker_restart',
    description: 'Restart a container (by name, id prefix, or compose service within the detected project). With no ref, restart every container of the detected compose project.',
    parameters: {
      container: { type: 'string', description: 'Container name, id prefix, or compose service name.' },
      project: { type: 'string', description: 'Explicit compose project name; skips detection.' },
    },
    output: {
      schema: affectedSchema,
      render: (_args: unknown, value: unknown) => {
        const v = value as AffectedOutput;
        return [{ type: 'text', text: v.affected.length === 0 ? 'nothing to restart' : `restarted: ${v.affected.join(', ')}` }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<AffectedOutput> {
      const a = args as { container?: string; project?: string };
      const project = projectOf(exec, getConfig(), a.project);
      const targets = await resolveTargets(runner, exec, a.container, project, 'restart');
      await runner.runOrThrow(['restart', ...targets], { signal: exec.signal, workdir: cwdOf(exec) });
      return { affected: targets };
    },
    presentCall(args): GenericCallView {
      const a = args as { container?: string };
      return { card: 'generic', title: a.container === undefined ? 'Restart project containers' : `Restart ${a.container}`, kind: 'execute' };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'docker_rm',
    description: 'Remove a stopped container (name, id prefix, or compose service). Removing a running container or passing force requires human approval.',
    parameters: {
      container: { type: 'string', required: true, description: 'Container name, id prefix, or compose service name.' },
      force: { type: 'boolean', description: 'Force removal of a running container (docker rm -f). Requires approval.' },
      project: { type: 'string', description: 'Explicit compose project name; skips detection.' },
    },
    output: {
      schema: affectedSchema,
      render: (_args: unknown, value: unknown) => {
        const v = value as AffectedOutput;
        return [{ type: 'text', text: v.affected.length === 0 ? 'nothing removed' : `removed: ${v.affected.join(', ')}` }];
      },
      presentationMeta: (_args: unknown, value: unknown) => {
        const v = value as AffectedOutput;
        return toMeta({ tool: 'docker_rm', affected: v.affected });
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<AffectedOutput> {
      const a = args as { container: string; force?: boolean; project?: string };
      const project = projectOf(exec, getConfig(), a.project);
      const containers = await runner.ps({ all: true, project: project?.project, signal: exec.signal });
      const resolved = resolveContainerRef(a.container, project, containers);
      if (!resolved.ok) throw new Error(resolved.error);
      const argv = ['rm', ...(a.force === true ? ['-f'] : []), resolved.ref];
      await runner.runOrThrow(argv, { signal: exec.signal, workdir: cwdOf(exec) });
      return { affected: [resolved.ref] };
    },
    presentCall(args): GenericCallView {
      const a = args as { container: string; force?: boolean };
      return { card: 'generic', title: `Remove container ${a.container}`, kind: 'delete' };
    },
  }));
}

/**
 * Resolve the targets of a lifecycle op: the explicit ref resolved within
 * the project, or the whole detected project's containers, or an error.
 */
async function resolveTargets(
  runner: DockerRunner,
  exec: Readonly<ToolExecution>,
  ref: string | undefined,
  project: ReturnType<typeof projectOf>,
  verb: string,
): Promise<string[]> {
  if (ref !== undefined && ref.trim() !== '') {
    const containers = await runner.ps({ all: true, project: project?.project, signal: exec.signal });
    const resolved = resolveContainerRef(ref, project, containers);
    if (!resolved.ok) throw new Error(resolved.error);
    return [resolved.ref];
  }
  if (project !== undefined) {
    const containers = await runner.ps({ all: true, project: project.project, signal: exec.signal });
    if (containers.length === 0) return [];
    return containers.map((c: ContainerRow) => c.name);
  }
  throw new Error(`docker_${verb}: no container ref given and no compose project detected in ${cwdOf(exec) ?? process.cwd()} — refusing to guess`);
}
