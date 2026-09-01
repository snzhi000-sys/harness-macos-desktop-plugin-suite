/**
 * `docker_inspect`: the raw engine JSON for one container or image, validated
 * as an open object. The thin adapter — the one tool whose output is the
 * engine's own structure, not a normalized row.
 *
 * @module dsh-docker/tools/inspect
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools';
import type { DockerRunner } from '../runner.ts';
import type { InspectOutput, ResolvedConfig } from '../types.ts';
import { cwdOf, toMeta } from './shared.ts';

/** Register the `docker_inspect` tool. */
export function applyInspectTool(ctx: Context, runner: DockerRunner, _getConfig: () => ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'docker_inspect',
    description: 'Return the raw docker inspect JSON for one container or image (engine-native structure).',
    parameters: {
      target: { type: 'string', required: true, description: 'Container or image name / id.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
      ],
      presentationMeta: (_args: unknown, value: unknown) => {
        const v = value as InspectOutput;
        return toMeta({ tool: 'docker_inspect', id: String(v.Id ?? v.id ?? '') });
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<InspectOutput> {
      const a = args as { target: string };
      const target = a.target.trim();
      if (target === '') throw new Error('docker_inspect: target must be a non-empty container or image ref');
      const result = await runner.runOrThrow(['inspect', target], { signal: exec.signal, workdir: cwdOf(exec) });
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== 'object' || parsed[0] === null) {
        throw new Error('docker_inspect: expected exactly one inspect record');
      }
      return parsed[0] as InspectOutput;
    },
    presentCall(args): GenericCallView {
      const a = args as { target: string };
      return { card: 'generic', title: `Inspect ${a.target}`, kind: 'read' };
    },
  }));
}
