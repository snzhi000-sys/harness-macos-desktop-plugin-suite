/**
 * Project-aware targeting: locate the compose project a tool call belongs to
 * and resolve ambiguous container/service refs within it.
 *
 * `ProjectResolver` is pure and unit-testable — it performs no I/O. The
 * caller supplies the directory walk results (via an injected `exists`
 * probe) and the container inventory (via {@link resolveRef} inputs).
 *
 * @module dsh-docker/project
 */

import type { ContainerRow, ProjectContext } from './types.ts';

/** Probe one path for a compose file (injectable for tests). */
export type PathProbe = (absolutePath: string) => boolean;

/** Compose project-name derivation rules, exported for tests and reuse. */
export function composeProjectName(dirBasename: string): string {
  return dirBasename.toLowerCase();
}

/**
 * Find the first compose file walking up from `cwd`, in the configured
 * `composeFiles` order (config-ordered, as the spec requires). Returns the
 * absolute compose file path, or `undefined` when no ancestor directory has
 * one.
 */
export function findComposeFile(cwd: string, composeFiles: readonly string[], probe: PathProbe): string | undefined {
  let dir = cwd;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const name of composeFiles) {
      const candidate = dir === '/' ? `/${name}` : `${dir}/${name}`;
      if (probe(candidate)) return candidate;
    }
    if (dir === '/') return undefined;
    const idx = dir.lastIndexOf('/');
    if (idx <= 0) {
      // '/a' → '/' (the parent of a one-level path is the root)
      dir = '/';
      continue;
    }
    dir = dir.slice(0, idx);
  }
}

/** Base name of an absolute path (POSIX; the runner normalizes workdirs). */
export function baseName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Build the project context for one tool call. Detection is skipped entirely
 * when `projectOverride` is set (explicit targeting wins). Returns
 * `undefined` when neither detection nor an override produced a project.
 */
export function resolveProject(
  cwd: string,
  composeFiles: readonly string[],
  probe: PathProbe,
  projectOverride?: string,
): ProjectContext | undefined {
  if (projectOverride !== undefined && projectOverride.length > 0) {
    return { file: '', project: projectOverride, cwd };
  }
  const file = findComposeFile(cwd, composeFiles, probe);
  if (file === undefined) return undefined;
  return { file, project: composeProjectName(baseName(file.slice(0, file.lastIndexOf('/')))), cwd };
}

/** The compose label keys docker stamps on containers it manages. */
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

/**
 * Resolve a container/service ref within a project first, falling back to a
 * global match only when unambiguous. Returns the canonical ref to pass to
 * the engine plus the resolved container row, or an error string listing
 * candidates when the ref is ambiguous or unknown.
 */
export function resolveContainerRef(
  ref: string,
  project: ProjectContext | undefined,
  containers: readonly ContainerRow[],
): { ok: true; ref: string; row: ContainerRow | undefined } | { ok: false; error: string } {
  const needle = ref.trim();
  if (needle.length === 0) {
    return { ok: false, error: 'container ref must be a non-empty string' };
  }
  const candidates = containers.filter((c) => matchesRef(c, needle));
  if (candidates.length === 0) {
    return { ok: false, error: `docker: no container matches "${needle}"` };
  }
  // A project-scoped exact name/service match wins; otherwise an exact global
  // name match wins; anything else must be unambiguous.
  const scoped = project === undefined ? undefined : candidates.filter((c) => c.project === project.project);
  const scopedExact = scoped?.filter((c) => c.name === needle || c.service === needle);
  if (scopedExact !== undefined && scopedExact.length === 1) {
    return { ok: true, ref: scopedExact[0]!.name, row: scopedExact[0] };
  }
  const globalExact = candidates.filter((c) => c.name === needle);
  if (globalExact.length === 1) {
    return { ok: true, ref: globalExact[0]!.name, row: globalExact[0] };
  }
  const scopedOnly = scoped?.length === 1 ? scoped : undefined;
  if (scopedOnly !== undefined) {
    return { ok: true, ref: scopedOnly[0]!.name, row: scopedOnly[0] };
  }
  if (candidates.length === 1) {
    return { ok: true, ref: candidates[0]!.name, row: candidates[0] };
  }
  const names = candidates.map((c) => `${c.name}${c.project !== undefined ? ` (project ${c.project})` : ''}`).join(', ');
  return { ok: false, error: `docker: ref "${needle}" is ambiguous — candidates: ${names}` };
}

/** Whether one container row matches a ref (id prefix, name, or service name). */
function matchesRef(row: ContainerRow, needle: string): boolean {
  if (row.id.startsWith(needle)) return true;
  if (row.name === needle) return true;
  if (row.service !== undefined && row.service === needle) return true;
  return false;
}
