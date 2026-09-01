/**
 * `docker_prune`: engine cleanup. The canonical output is the request plus
 * the engine's exit — the engine's reclaimed-space prose stays in
 * `output.render`, never in the canonical value (we do not scrape
 * human-formatted text). `--all`/`--volumes`/system-scope prunes are
 * guarded.
 *
 * @module dsh-docker/tools/prune
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools';
import type { DockerRunner } from '../runner.ts';
import type { PruneOutput, ResolvedConfig } from '../types.ts';
import { cwdOf, toMeta } from './shared.ts';

/** Valid prune scopes mapped to docker subcommands. */
const SCOPES = {
  system: 'system',
  images: 'image',
  containers: 'container',
  volumes: 'volume',
  networks: 'network',
} as const;

/** Register the `docker_prune` tool. */
export function applyPruneTool(ctx: Context, runner: DockerRunner, getConfig: () => ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'docker_prune',
    description: 'Prune unused Docker resources (system, images, containers, volumes, networks). all/volumes/system-scope prunes require human approval.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['system', 'images', 'containers', 'volumes', 'networks'],
        description: 'What to prune (default system).',
      },
      all: { type: 'boolean', description: 'Also remove unused-but-not-dangling images (docker ... prune -a). Requires approval.' },
      volumes: { type: 'boolean', description: 'Also remove unused volumes (docker system prune --volumes). Requires approval.' },
      project: { type: 'string', description: 'Explicit compose project name; skips detection (used for scope filtering).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', required: true },
          all: { type: 'boolean', required: true },
          volumes: { type: 'boolean', required: true },
          ok: { type: 'boolean', required: true },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as PruneOutput;
        return [{ type: 'text', text: `docker ${v.scope} prune${v.all ? ' --all' : ''}${v.volumes ? ' --volumes' : ''} ${v.ok ? 'completed' : 'failed'}` }];
      },
      presentationMeta: (_args: unknown, value: unknown) => {
        const v = value as PruneOutput;
        return toMeta({ tool: 'docker_prune', scope: v.scope, all: v.all, volumes: v.volumes });
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<PruneOutput> {
      const a = args as { scope?: string; all?: boolean; volumes?: boolean; project?: string };
      const scope = a.scope === undefined || SCOPES[a.scope as keyof typeof SCOPES] === undefined ? 'system' : a.scope;
      const sub = SCOPES[scope as keyof typeof SCOPES];
      const argv = [sub === 'system' ? 'system' : sub, 'prune', '-f'];
      if (a.all === true) argv.push('--all');
      if (a.volumes === true && sub === 'system') argv.push('--volumes');
      const result = await runner.run(argv, { signal: exec.signal, workdir: cwdOf(exec) });
      if (result.exitCode !== 0) {
        const detail = (result.stderr.trim() !== '' ? result.stderr.trim() : result.stdout.trim()) || `exit ${String(result.exitCode)}`;
        throw new Error(`docker_prune failed: ${detail.slice(0, 400)}`);
      }
      return { scope, all: a.all === true, volumes: a.volumes === true, ok: true };
    },
    presentCall(args): GenericCallView {
      const a = args as { scope?: string; all?: boolean; volumes?: boolean };
      const scope = a.scope ?? 'system';
      return { card: 'generic', title: `Prune ${scope}${a.all === true ? ' (all)' : ''}`, kind: 'delete' };
    },
  }));
}
