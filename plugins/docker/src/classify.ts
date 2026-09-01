/**
 * The guardrail policy: classify one tool call's intended effect as `safe` or
 * `guarded`, purely from the tool name, its validated arguments, and the
 * resolved runtime facts (`ResolvedFacts`). This is the single source of
 * truth both the approval router and the monotonic guard consume, so the two
 * layers cannot drift apart. It unit-tests without a daemon.
 *
 * @module dsh-docker/classify
 */

import type { ResolvedConfig, ResolvedFacts, ToolEffect } from './types.ts';

/** Whether an argument value is exactly `true` (the schema already validated booleans). */
function isTrue(value: unknown): boolean {
  return value === true;
}

/**
 * Classify one call. `resolved` carries the runtime facts the caller
 * gathered (container running? image in use?) — the facts that turn a
 * name-only classifier into one that can reason about destruction.
 */
export function classify(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  resolved: ResolvedFacts,
  config: ResolvedConfig,
): ToolEffect {
  switch (toolName) {
    case 'docker_rmi': {
      if (resolved.imageInUse === true) {
        return { effect: 'guarded', reason: `docker_rmi on image "${String(args.image)}" which is in use by a container` };
      }
      return { effect: 'safe', reason: 'docker_rmi on an image no container references' };
    }
    case 'docker_rm': {
      if (resolved.running === true || isTrue(args.force)) {
        return { effect: 'guarded', reason: `docker_rm${isTrue(args.force) ? ' -f' : ''} on container "${String(args.container)}" (running or force-removed)` };
      }
      return { effect: 'safe', reason: 'docker_rm on a stopped container' };
    }
    case 'docker_prune': {
      const scope = typeof args.scope === 'string' ? args.scope : 'system';
      if (isTrue(args.all) || isTrue(args.volumes) || scope === 'system') {
        return { effect: 'guarded', reason: `docker_prune (scope ${scope}${isTrue(args.all) ? ', --all' : ''}${isTrue(args.volumes) ? ', --volumes' : ''}) removes more than dangling images` };
      }
      return { effect: 'safe', reason: `docker_prune scope ${scope} only removes what the engine scopes to` };
    }
    case 'docker_compose_down': {
      if (isTrue(args.volumes)) {
        return { effect: 'guarded', reason: 'docker_compose_down -v also removes named volumes' };
      }
      return { effect: 'safe', reason: 'docker_compose_down without -v keeps volumes' };
    }
    case 'docker_exec': {
      if (!config.execReadOnly) {
        return { effect: 'safe', reason: 'execReadOnly is off — exec runs ungated by operator choice' };
      }
      if (isTrue(args.write) || isTrue(args.interactive)) {
        return { effect: 'guarded', reason: `docker_exec${isTrue(args.interactive) ? ' --interactive' : ''}${isTrue(args.write) ? ' (write)' : ''} may mutate the container` };
      }
      return { effect: 'safe', reason: 'docker_exec without a TTY runs read-only by default' };
    }
    default:
      return { effect: 'safe', reason: `${toolName} has no guarded effect` };
  }
}

/** The hard-destructive set the monotonic guard refuses without an approval token. */
export function isHardDestructive(toolName: string, args: Readonly<Record<string, unknown>>, resolved: ResolvedFacts, config: ResolvedConfig): boolean {
  return classify(toolName, args, resolved, config).effect === 'guarded';
}
