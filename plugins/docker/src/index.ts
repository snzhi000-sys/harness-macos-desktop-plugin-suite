/**
 * dsh-docker — typed, guarded container control for DSH.
 *
 * A DSH bundle (`dsh plugin add @dsh-docker/bundle`): structured docker and
 * compose tools over `ctx.shell` (never scraped prose), project-aware
 * targeting via a pure `ProjectResolver`, a two-layer guardrail (approval
 * gate for destructive ops + a monotonic deny backstop), an opt-in
 * service-health context, and a replayable status-table renderer in the web
 * client.
 *
 * @module @dsh-docker/bundle
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-user-approval';
import { DockerRunner } from './runner.ts';
import { applyPolicy } from './policy.ts';
import { applyHealth } from './health.ts';
import { applyContainerTools } from './tools/containers.ts';
import { applyLogsTool } from './tools/logs.ts';
import { applyInspectTool } from './tools/inspect.ts';
import { applyExecTool } from './tools/exec.ts';
import { applyImageTools } from './tools/images.ts';
import { applyPruneTool } from './tools/prune.ts';
import { applyComposeTools } from './tools/compose.ts';
import { resolveConfig } from './types.ts';
import type { Config as DockerConfig, ResolvedConfig } from './types.ts';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-docker';

/** Services required to load: the tool registry and the shell executor seam. */
export const inject = ['tools', 'shell'];

const healthContextSchema = z.object({
  enabled: z.boolean().default(false),
  maxServices: z.number().default(12),
});

/** Plugin config (all optional — defaults match the documented behavior). */
export const Config: z<DockerConfig> = z.object({
  enabled: z.boolean().default(true),
  composeFiles: z.array(z.string()).default(['docker-compose.yml', 'compose.yaml']),
  approval: z.array(z.string()).default(['rmi:*', 'rm:*', 'prune:*', 'compose down -v', 'exec:*']),
  execReadOnly: z.boolean().default(true),
  timeoutMs: z.number().default(30_000),
  healthContext: healthContextSchema.default({ enabled: false, maxServices: 12 }),
});

/** Settings namespace of this plugin, owned here for the optional user section. */
const NS = settingsNamespace('dsh-docker');

/**
 * Register the plugin: every tool, the two-layer policy, the opt-in health
 * context, and the optional user-settings section. The settings section
 * layers the profile-patch entry config under the user document, so a live
 * edit reaches the very next tool call.
 */
export function apply(ctx: Context, rawConfig: DockerConfig): void {
  const entry = resolveConfig(rawConfig);
  if (!entry.enabled) return;

  let current = entry;
  const getConfig = (): ResolvedConfig => current;

  const runner = new DockerRunner(ctx, getConfig);

  applyContainerTools(ctx, runner, getConfig);
  applyLogsTool(ctx, runner, getConfig);
  applyInspectTool(ctx, runner, getConfig);
  applyExecTool(ctx, runner, getConfig);
  applyImageTools(ctx, runner, getConfig);
  applyPruneTool(ctx, runner, getConfig);
  applyComposeTools(ctx, runner, getConfig);

  applyPolicy(ctx, runner, getConfig);
  applyHealth(ctx, runner, getConfig);

  installSettingsSection(ctx, NS, Config, rawConfig, {
    setSource: (source) => {
      current = resolveConfig(source());
    },
    onChange: () => {
      // The policy and health layers read `getConfig()` per call, so a
      // committed change is picked up without re-registering anything.
    },
  });
}
