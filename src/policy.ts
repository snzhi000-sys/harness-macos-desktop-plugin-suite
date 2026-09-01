/**
 * The two-layer guardrail: a `tools/pre-execute` listener that classifies
 * each docker call and routes destructive ops through the dsh-tool-approval
 * gate (`ctx.approval` `approval/request` waterfall), plus a monotonic
 * `ctx.tools.guard()` backstop that refuses the hard-destructive set unless
 * this call carries the approval token recorded by the pre-execute layer.
 *
 * Fail-closed semantics:
 * - a guarded op not covered by the configured approval globs is refused;
 * - a guarded op with no approval channel (no `ctx.approval`, no agent) is
 *   refused — the waterfall resolves `unavailable` and we deny;
 * - a hard-destructive call whose pre-execute listener never ran (another
 *   plugin returned a decision first) reaches the guard without a token and
 *   is refused — a later listener cannot undo that denial.
 *
 * @module dsh-docker/policy
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval';
import { classify } from './classify.ts';
import { coveredByApproval } from './glob.ts';
import type { DockerRunner } from './runner.ts';
import type { ResolvedConfig } from './types.ts';

/** The docker tools this plugin owns. */
export const DOCKER_TOOLS = new Set([
  'docker_ps',
  'docker_logs',
  'docker_inspect',
  'docker_exec',
  'docker_start',
  'docker_stop',
  'docker_restart',
  'docker_rm',
  'docker_images',
  'docker_rmi',
  'docker_prune',
  'docker_compose_up',
  'docker_compose_down',
  'docker_compose_ps',
]);

/** The removal/exec tools the monotonic guard refuses without an evaluation token. */
const GUARD_REFUSAL_TOOLS = new Set(['docker_rm', 'docker_rmi', 'docker_prune']);

/** Whether the guard refuses this call based on args alone (the synchronous backstop). */
function guardRefuses(toolName: string, args: Readonly<Record<string, unknown>>): boolean {
  if (GUARD_REFUSAL_TOOLS.has(toolName)) return true;
  if (toolName === 'docker_compose_down' && args.volumes === true) return true;
  if (toolName === 'docker_exec' && (args.write === true || args.interactive === true)) return true;
  return false;
}

/**
 * Install the two-layer policy on `ctx`. `getConfig` returns the current
 * resolved config (the settings scope may update it live). `runner` is the
 * shared DockerRunner the pre-execute layer uses to resolve runtime facts.
 */
export function applyPolicy(
  ctx: Context,
  runner: DockerRunner,
  getConfig: () => ResolvedConfig,
): { dispose: () => void } {
  /** Tokens of calls the pre-execute layer evaluated (safe) or approved. */
  const evaluatedTokens = new Set<symbol>();

  const disposers: Array<() => void> = [];

  disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
    if (!DOCKER_TOOLS.has(exec.name)) return next();
    const config = getConfig();
    const args = exec.arguments as Readonly<Record<string, unknown>>;
    const resolved = await resolveFacts(ctx, runner, exec, args);
    const verdict = classify(exec.name, args, resolved, config);
    if (verdict.effect === 'safe') {
      evaluatedTokens.add(exec.token);
      return next();
    }
    // Guarded: the approval globs decide whether we ask or refuse.
    const volumes = args.volumes === true;
    if (!coveredByApproval(config.approval, exec.name, volumes)) {
      return { kind: 'deny', reason: `${verdict.reason} — not covered by the configured approval globs; refused` };
    }
    const approver = ctx.get('approval') as ApprovalService | undefined;
    if (approver === undefined || exec.agent === undefined) {
      return { kind: 'deny', reason: `${verdict.reason} — no approval channel (fails closed); refused` };
    }
    let outcome: string;
    try {
      outcome = await approver.request({
        agent: exec.agent,
        toolName: exec.name,
        callId: exec.callId,
        reason: verdict.reason,
        signal: exec.signal,
      });
    } catch (error) {
      outcome = 'unavailable';
      ctx.logger.warn(`dsh-docker: approval request threw (${error instanceof Error ? error.message : String(error)}); refusing`);
    }
    if (outcome === 'allowed-once') {
      evaluatedTokens.add(exec.token);
      return { kind: 'allow' };
    }
    return { kind: 'deny', reason: `${verdict.reason} — approval ${outcome}; refused` };
  }));

  disposers.push(ctx.tools.guard((exec: Readonly<ToolExecution>) => {
    if (!DOCKER_TOOLS.has(exec.name)) return undefined;
    const args = exec.arguments as Readonly<Record<string, unknown>>;
    if (!guardRefuses(exec.name, args)) return undefined;
    if (evaluatedTokens.has(exec.token)) return undefined;
    return `${exec.name}: destructive operation refused — no dsh-docker approval token for this call`;
  }));

  return { dispose: () => { for (const dispose of disposers) dispose(); } };
}

/** Resolve the runtime facts a classification needs (container running? image in use?). */
async function resolveFacts(
  ctx: Context,
  runner: DockerRunner,
  exec: Readonly<ToolExecution>,
  args: Readonly<Record<string, unknown>>,
): Promise<{ running?: boolean; imageInUse?: boolean }> {
  try {
    if (exec.name === 'docker_rm') {
      const ref = typeof args.container === 'string' ? args.container : '';
      if (ref === '') return {};
      const containers = await runner.ps({ all: true, signal: exec.signal });
      const match = containers.find((c) => c.id.startsWith(ref) || c.name === ref);
      return { running: match?.state === 'running' };
    }
    if (exec.name === 'docker_rmi') {
      const ref = typeof args.image === 'string' ? args.image : '';
      if (ref === '') return {};
      const images = await runner.images(exec.signal);
      const match = images.find((i) => i.id.startsWith(ref) || `${i.repository}:${i.tag}` === ref || i.repository === ref);
      return { imageInUse: match?.inUse };
    }
  } catch (error) {
    // Facts are advisory for classification: an unreadable daemon must not
    // crash policy. The tool body will surface the real failure.
    ctx.logger.debug(`dsh-docker: fact resolution failed (${error instanceof Error ? error.message : String(error)})`);
  }
  return {};
}
