/**
 * Compose tools: `docker_compose_up`, `docker_compose_down`,
 * `docker_compose_ps`. Every call runs with an explicit `-f <file>` and
 * `-p <project>`, so `stop dev-api` can never mean a coincidentally-named
 * container on the machine. `down -v` is the guarded flag.
 *
 * @module dsh-docker/tools/compose
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools';
import { composeArgs, type DockerRunner } from '../runner.ts';
import type { ComposeDownOutput, ComposePsOutput, ComposeUpOutput, ProjectContext, ResolvedConfig } from '../types.ts';
import { cwdOf, projectOf, toMeta } from './shared.ts';

const serviceRowSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    name: { type: 'string' as const, required: true as const },
    id: { type: 'string' as const },
    state: { type: 'string' as const, required: true as const },
    status: { type: 'string' as const },
    ports: { type: 'string' as const },
  },
};

/** Register the compose tools. */
export function applyComposeTools(ctx: Context, runner: DockerRunner, getConfig: () => ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'docker_compose_up',
    description: 'Bring up a compose stack (detached by default) for the detected project or an explicit project.',
    parameters: {
      services: {
        type: 'array',
        items: { type: 'string' },
        description: 'Compose service names to start; omitted starts every service.',
      },
      detach: { type: 'boolean', description: 'Run detached (docker compose up -d). Defaults to true.' },
      project: { type: 'string', description: 'Explicit compose project name; skips detection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: { type: 'string', required: true },
          services: { type: 'array', required: true, items: { type: 'string' } },
          detached: { type: 'boolean', required: true },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as ComposeUpOutput;
        return [{
          type: 'text',
          text: `compose up (project ${v.project}) ${v.detached ? 'detached' : 'attached'}: ${v.services.length === 0 ? '(all services)' : v.services.join(', ')}`,
        }];
      },
      presentationMeta: (_args: unknown, value: unknown) => {
        const v = value as ComposeUpOutput;
        return toMeta({ tool: 'docker_compose_up', project: v.project, services: v.services });
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<ComposeUpOutput> {
      const a = args as { services?: string[]; detach?: boolean; project?: string };
      const project = requireProject(exec, getConfig(), a.project);
      const services = validateServices(a.services);
      const detached = a.detach !== false;
      const argv = composeArgs(project, ['up', ...(detached ? ['-d'] : []), ...services]);
      await runner.runOrThrow(argv, { signal: exec.signal, workdir: project.cwd });
      return { project: project.project, services, detached };
    },
    presentCall(args): GenericCallView {
      const a = args as { services?: string[] };
      return { card: 'generic', title: a.services !== undefined && a.services.length > 0 ? `Compose up ${a.services.join(', ')}` : 'Compose up', kind: 'execute' };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'docker_compose_down',
    description: 'Tear down a compose stack for the detected project or an explicit project. volumes: true also removes named volumes and requires human approval.',
    parameters: {
      services: {
        type: 'array',
        items: { type: 'string' },
        description: 'Compose service names to stop/remove; omitted acts on every service.',
      },
      volumes: { type: 'boolean', description: 'Also remove named volumes (docker compose down -v). Requires approval.' },
      project: { type: 'string', description: 'Explicit compose project name; skips detection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: { type: 'string', required: true },
          affected: { type: 'array', required: true, items: { type: 'string' } },
          volumes: { type: 'boolean', required: true },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as ComposeDownOutput;
        return [{
          type: 'text',
          text: `compose down (project ${v.project})${v.volumes ? ' with volumes' : ''}: ${v.affected.length === 0 ? '(no services named)' : v.affected.join(', ')}`,
        }];
      },
      presentationMeta: (_args: unknown, value: unknown) => {
        const v = value as ComposeDownOutput;
        return toMeta({ tool: 'docker_compose_down', project: v.project, volumes: v.volumes, affected: v.affected });
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<ComposeDownOutput> {
      const a = args as { services?: string[]; volumes?: boolean; project?: string };
      const project = requireProject(exec, getConfig(), a.project);
      const services = validateServices(a.services);
      const argv = composeArgs(project, ['down', ...(a.volumes === true ? ['-v'] : []), ...services]);
      await runner.runOrThrow(argv, { signal: exec.signal, workdir: project.cwd });
      return { project: project.project, affected: services, volumes: a.volumes === true };
    },
    presentCall(args): GenericCallView {
      const a = args as { volumes?: boolean };
      return { card: 'generic', title: a.volumes === true ? 'Compose down (with volumes)' : 'Compose down', kind: 'execute' };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'docker_compose_ps',
    description: 'List the services of the detected compose project (or an explicit project) with structured rows (name, id, state, status, ports).',
    parameters: {
      project: { type: 'string', description: 'Explicit compose project name; skips detection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: { type: 'string', required: true },
          services: { type: 'array', required: true, items: serviceRowSchema },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as ComposePsOutput;
        if (v.services.length === 0) return [{ type: 'text', text: `(project ${v.project}: no services up)` }];
        return [{
          type: 'text',
          text: v.services.map((s) => `${s.name}  ${s.state}${s.status !== undefined ? ` (${s.status})` : ''}${s.ports !== undefined ? `  ${s.ports}` : ''}`).join('\n'),
        }];
      },
      presentationMeta: (_args: unknown, value: unknown) => {
        const v = value as ComposePsOutput;
        return toMeta({ tool: 'docker_compose_ps', project: v.project, rows: v.services });
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<ComposePsOutput> {
      const a = args as { project?: string };
      const project = requireProject(exec, getConfig(), a.project);
      const services = await runner.composePs(project, exec.signal);
      return { project: project.project, services };
    },
    presentCall(): GenericCallView {
      return { card: 'generic', title: 'Compose services', kind: 'search' };
    },
  }));
}

/** Compose tools need a project: the detected one or an explicit override. */
function requireProject(
  exec: Parameters<typeof projectOf>[0],
  config: ResolvedConfig,
  projectArg?: string,
): ProjectContext {
  const project = projectOf(exec, config, projectArg);
  if (project === undefined) {
    throw new Error('no compose file detected in this working directory and no project override given — pass project to target a stack explicitly');
  }
  return project;
}

/** Validate the optional services array. */
function validateServices(services: unknown): string[] {
  if (services === undefined) return [];
  if (!Array.isArray(services) || services.some((s) => typeof s !== 'string' || s.trim() === '')) {
    throw new Error('services must be an array of non-empty service names');
  }
  return services as string[];
}
