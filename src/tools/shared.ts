/**
 * Shared helpers for the docker tools: project resolution from the calling
 * agent's working directory and small renderers shared across tools.
 *
 * @module dsh-docker/tools/shared
 */

import { existsSync } from 'node:fs';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-session';
import { resolveProject } from '../project.ts';
import type { ProjectContext, ResolvedConfig } from '../types.ts';

/** Cast a JSON-serializable projection to JsonValue at the tool boundary. */
export function toMeta(value: unknown): JsonValue {
  return value as unknown as JsonValue;
}

/** The working directory of the calling agent, when one exists. */
export function cwdOf(exec: Readonly<Pick<ToolExecution, 'agent'>>): string | undefined {
  return exec.agent?.session.header.cwd;
}

/**
 * Resolve the project context for one call: an explicit `project` override
 * wins; otherwise detect from the agent cwd. Returns undefined when neither
 * applies (global operation).
 */
export function projectOf(
  exec: Readonly<Pick<ToolExecution, 'agent'>>,
  config: ResolvedConfig,
  projectArg?: string,
): ProjectContext | undefined {
  const cwd = cwdOf(exec) ?? process.cwd();
  return resolveProject(cwd, config.composeFiles, (path) => existsSync(path), projectArg);
}

/** Render one container row as a compact text line for `output.render`. */
export function renderContainerLine(row: { name: string; state: string; status: string; image: string; ports: string[] }): string {
  const ports = row.ports.length > 0 ? `  ports: ${row.ports.join(', ')}` : '';
  return `${row.name}  ${row.state} (${row.status})  image: ${row.image}${ports}`;
}
