/**
 * Approval-glob matching: whether a tool call is covered by one of the
 * configured `approval` patterns. Patterns are matched against the tool name
 * without its `docker_` prefix (`rmi:*` covers `docker_rmi`), with `*`
 * matching any run of characters; the special pattern `compose down -v`
 * covers `docker_compose_down` only when it removes volumes.
 *
 * Pure and unit-testable — no I/O.
 *
 * @module dsh-docker/glob
 */

import type { ApprovalPattern } from './types.ts';

/** The special pattern naming volume-removing compose downs. */
export const COMPOSE_DOWN_VOLUMES_PATTERN = 'compose down -v';

/** Strip the `docker_` prefix from a tool name for pattern matching. */
export function patternName(toolName: string): string {
  return toolName.startsWith('docker_') ? toolName.slice('docker_'.length) : toolName;
}

/** Translate a `*`-glob into an anchored RegExp. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Whether one pattern covers the call. `base:*` matches the tool name with any args. */
export function patternMatches(pattern: ApprovalPattern, toolName: string, volumes: boolean): boolean {
  if (pattern === COMPOSE_DOWN_VOLUMES_PATTERN) {
    return toolName === 'docker_compose_down' && volumes;
  }
  // The documented globs carry a `:*` args suffix ("any arguments"); strip it
  // before matching against the bare tool name.
  const base = pattern.endsWith(':*') ? pattern.slice(0, -2) : pattern;
  return globToRegExp(base).test(patternName(toolName));
}

/**
 * Whether the configured approval patterns cover the call. An empty or
 * absent pattern list covers nothing — destructive ops then fail closed.
 */
export function coveredByApproval(patterns: readonly ApprovalPattern[], toolName: string, volumes: boolean): boolean {
  return patterns.some((pattern) => patternMatches(pattern, toolName, volumes));
}
