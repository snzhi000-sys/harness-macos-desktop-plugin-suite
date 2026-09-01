/**
 * Image tools: `docker_images` (with an `inUse` cross-reference the guard
 * reasons about) and `docker_rmi` (guarded when the image is in use).
 *
 * @module dsh-docker/tools/images
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools';
import type { DockerRunner } from '../runner.ts';
import type { ImagesOutput, ResolvedConfig, RmiOutput } from '../types.ts';
import { cwdOf, toMeta } from './shared.ts';

const imageRowSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    id: { type: 'string' as const, required: true as const },
    repository: { type: 'string' as const, required: true as const },
    tag: { type: 'string' as const, required: true as const },
    size: { type: 'string' as const, required: true as const },
    inUse: { type: 'boolean' as const, required: true as const },
  },
};

/** Register `docker_images` and `docker_rmi`. */
export function applyImageTools(ctx: Context, runner: DockerRunner, getConfig: () => ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'docker_images',
    description: 'List images with structured rows (id, repository, tag, size, inUse). inUse is true when any container references the image.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          images: { type: 'array', required: true, items: imageRowSchema },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as ImagesOutput;
        if (v.images.length === 0) return [{ type: 'text', text: '(no images)' }];
        return [{
          type: 'text',
          text: v.images.map((i) => `${i.repository}:${i.tag}  ${i.size}  ${i.inUse ? 'in use' : 'unused'}  ${i.id}`).join('\n'),
        }];
      },
      presentationMeta: (_args: unknown, value: unknown) => {
        const v = value as ImagesOutput;
        return toMeta({ tool: 'docker_images', rows: v.images });
      },
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec): Promise<ImagesOutput> {
      return { images: await runner.images(exec.signal) };
    },
    presentCall(): GenericCallView {
      return { card: 'generic', title: 'List images', kind: 'search' };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'docker_rmi',
    description: 'Remove an image. Removing an image that is in use by a container requires human approval.',
    parameters: {
      image: { type: 'string', required: true, description: 'Image name, repository, or id prefix.' },
      project: { type: 'string', description: 'Explicit compose project name; skips detection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as RmiOutput;
        return [{ type: 'text', text: v.removed.length === 0 ? 'nothing removed' : `removed: ${v.removed.join(', ')}` }];
      },
      presentationMeta: (_args: unknown, value: unknown) => {
        const v = value as RmiOutput;
        return toMeta({ tool: 'docker_rmi', removed: v.removed });
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<RmiOutput> {
      const a = args as { image: string };
      const image = a.image.trim();
      if (image === '') throw new Error('docker_rmi: image must be a non-empty ref');
      await runner.runOrThrow(['rmi', image], { signal: exec.signal, workdir: cwdOf(exec) });
      return { removed: [image] };
    },
    presentCall(args): GenericCallView {
      const a = args as { image: string };
      return { card: 'generic', title: `Remove image ${a.image}`, kind: 'delete' };
    },
  }));
}
