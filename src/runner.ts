/**
 * DockerRunner: the one executor seam every tool shells `docker` through.
 * Pure CLI wrapping of the `docker` CLI via `ctx.shell` — no daemon library,
 * no SDK. Structured output is read with `--format json` (NDJSON) wherever
 * the CLI supports it; `docker inspect` supplies the raw JSON adapter where
 * it does not. Human-formatted CLI text is never scraped for programmatic
 * fields.
 *
 * @module dsh-docker/runner
 */

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-shell';
import type { ContainerRow, ComposeServiceRow, ImageRow, LogsOutput, ProjectContext, ResolvedConfig } from './types.ts';
import { COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL } from './project.ts';

/** One docker invocation outcome. */
export interface DockerRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when stdout was truncated by the capture budget. */
  stdoutTruncated: boolean;
}

/** Options for a single docker invocation. */
export interface RunOptions {
  project?: ProjectContext;
  workdir?: string;
  signal?: AbortSignal;
  stdoutMaxBytes?: number;
}

/** Shell-quote one argument (single-quote wrapping, POSIX-safe). */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Parse newline-delimited JSON (the `--format json` output shape). */
export function parseNdjson<T>(text: string): T[] {
  const rows: T[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`docker: the CLI did not emit JSON for this command (line: ${line.slice(0, 80)}…) — is the docker CLI recent enough for --format json? (${error instanceof Error ? error.message : String(error)})`);
    }
    rows.push(parsed as T);
  }
  return rows;
}

/** Map the `Labels` field of a ps row into compose project/service. */
function labelsToProjectService(labels: unknown): { project?: string; service?: string } {
  if (typeof labels !== 'string') return {};
  const project = extractLabel(labels, COMPOSE_PROJECT_LABEL);
  const service = extractLabel(labels, COMPOSE_SERVICE_LABEL);
  return {
    ...project === undefined ? {} : { project },
    ...service === undefined ? {} : { service },
  };
}

/** Pull one `key=value` entry out of a comma-joined docker Labels string. */
function extractLabel(labels: string, key: string): string | undefined {
  for (const entry of labels.split(',')) {
    const idx = entry.indexOf('=');
    if (idx === -1) continue;
    if (entry.slice(0, idx) === key) return entry.slice(idx + 1);
  }
  return undefined;
}

/** Parse the `Ports` field of a ps row into a list. */
function parsePorts(ports: unknown): string[] {
  if (typeof ports !== 'string' || ports === '') return [];
  return ports.split(', ').filter((p) => p.length > 0);
}

/**
 * Runs docker commands. Construct with the plugin context (for `ctx.shell`)
 * and a `getConfig` thunk (the settings section may update the resolved
 * config live); tools call the typed helpers, which always shell docker
 * through `ctx.shell.run`.
 */
export class DockerRunner {
  private readonly ctx: Context;
  private readonly getConfig: () => ResolvedConfig;

  constructor(
    ctx: Context,
    getConfig: () => ResolvedConfig,
  ) {
    this.ctx = ctx;
    this.getConfig = getConfig;
  }

  /** Run one docker argv through `ctx.shell`, honoring the abort signal. */
  async run(args: readonly string[], opts: RunOptions = {}): Promise<DockerRunResult> {
    const command = ['docker', ...args].map(shq).join(' ');
    const spec = this.ctx.shell.resolve({
      command,
      workdir: opts.workdir ?? process.cwd(),
      timeoutMs: this.getConfig().timeoutMs,
      signal: opts.signal,
      stdoutMaxBytes: opts.stdoutMaxBytes ?? 1_048_576,
    });
    const result = await this.ctx.shell.run(spec);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.text,
      stderr: result.stderr.text,
      stdoutTruncated: result.stdout.truncated,
    };
  }

  /** Run a command and require a zero exit, throwing a descriptive error otherwise. */
  async runOrThrow(args: readonly string[], opts: RunOptions = {}): Promise<DockerRunResult> {
    const result = await this.run(args, opts);
    if (result.exitCode !== 0) {
      const detail = (result.stderr.trim() !== '' ? result.stderr.trim() : result.stdout.trim()) || `exit ${String(result.exitCode)}`;
      throw new Error(`docker ${args[0] ?? ''} failed: ${detail.slice(0, 400)}`);
    }
    return result;
  }

  /**
   * `docker ps [--all] [--filter label=com.docker.compose.project=<project>]`.
   * `project`/`service` come from the ps `Labels` field; when the CLI omits
   * it, one `docker inspect` batch supplies them (the adapter).
   */
  async ps(opts: { all?: boolean; project?: string; signal?: AbortSignal } = {}): Promise<ContainerRow[]> {
    const args: string[] = ['ps', '--format', 'json'];
    if (opts.all === true) args.push('--all');
    if (opts.project !== undefined) args.push('--filter', `label=${COMPOSE_PROJECT_LABEL}=${opts.project}`);
    const result = await this.runOrThrow(args, { signal: opts.signal });
    const rows = parseNdjson<Record<string, unknown>>(result.stdout);
    const containers: ContainerRow[] = rows.map((row) => {
      const id = String(row.ID ?? '');
      const labels = labelsToProjectService(row.Labels);
      return {
        id,
        name: String(row.Names ?? id),
        image: String(row.Image ?? ''),
        state: String(row.State ?? ''),
        status: String(row.Status ?? ''),
        ports: parsePorts(row.Ports),
        ...labels.project === undefined ? {} : { project: labels.project },
        ...labels.service === undefined ? {} : { service: labels.service },
      };
    });
    if (containers.length > 0 && containers.some((c) => c.project === undefined)) {
      // Older CLI without Labels in ps output: one inspect batch supplies the labels.
      const labels = await this.inspectLabels(containers.map((c) => c.id), opts.signal);
      for (const container of containers) {
        const found = labels.get(container.id);
        if (found === undefined) continue;
        container.project = found.project;
        container.service = found.service;
      }
    }
    return containers;
  }

  /** One `docker inspect` batch: map container id → compose project/service. */
  async inspectLabels(ids: readonly string[], signal?: AbortSignal): Promise<Map<string, { project?: string; service?: string }>> {
    if (ids.length === 0) return new Map();
    const result = await this.runOrThrow(['inspect', '--format', '{{json .}}', ...ids], { signal });
    const parsed = JSON.parse(result.stdout) as Array<{
      Id?: string;
      Config?: { Labels?: Record<string, string> };
    }>;
    const map = new Map<string, { project?: string; service?: string }>();
    for (const item of parsed) {
      const id = item.Id ?? '';
      if (id === '') continue;
      const labels = item.Config?.Labels ?? {};
      map.set(id, {
        ...labels[COMPOSE_PROJECT_LABEL] === undefined ? {} : { project: labels[COMPOSE_PROJECT_LABEL] },
        ...labels[COMPOSE_SERVICE_LABEL] === undefined ? {} : { service: labels[COMPOSE_SERVICE_LABEL] },
      });
    }
    return map;
  }

  /**
   * `docker logs --tail <tail+1> <container>` — pull one extra line so
   * truncation is detectable: more than `tail` lines means the pull was
   * capped and the oldest lines were dropped.
   */
  async logs(container: string, tail: number, signal?: AbortSignal): Promise<LogsOutput> {
    const pull = tail + 1;
    const result = await this.runOrThrow(['logs', '--tail', String(pull), container], { signal, stdoutMaxBytes: 8_388_608 });
    let lines = splitLogLines(result.stdout);
    const truncated = lines.length > tail;
    if (truncated) lines = lines.slice(lines.length - tail);
    return { lines, truncated };
  }

  /** `docker images --format json` plus an `inUse` cross-reference from `docker ps -a`. */
  async images(signal?: AbortSignal): Promise<ImageRow[]> {
    const [imagesResult, psResult] = await Promise.all([
      this.runOrThrow(['images', '--format', 'json'], { signal }),
      this.runOrThrow(['ps', '-a', '--format', 'json'], { signal }),
    ]);
    const rows = parseNdjson<Record<string, unknown>>(imagesResult.stdout);
    const running = parseNdjson<Record<string, unknown>>(psResult.stdout);
    const inUseIds = new Set<string>();
    const inUseRefs = new Set<string>();
    for (const container of running) {
      const imageId = String(container.ImageID ?? '');
      if (imageId !== '' && imageId !== '<none>') inUseIds.add(imageId);
      const image = String(container.Image ?? '');
      if (image !== '' && image !== '<none>') inUseRefs.add(image);
    }
    const images: ImageRow[] = rows.map((row) => {
      const id = String(row.ID ?? '');
      const repository = String(row.Repository ?? '');
      const tag = String(row.Tag ?? '');
      const reference = `${repository}:${tag}`;
      return {
        id,
        repository,
        tag,
        size: String(row.Size ?? ''),
        inUse: inUseIds.has(id) || (repository !== '<none>' && inUseRefs.has(reference)) || inUseRefs.has(repository),
      };
    });
    return images;
  }

  /** `docker compose -p <project> -f <file> ps --format json`. */
  async composePs(project: ProjectContext, signal?: AbortSignal): Promise<ComposeServiceRow[]> {
    const result = await this.runOrThrow(composeArgs(project, ['ps', '--format', 'json']), { signal, workdir: project.cwd });
    const rows = parseNdjson<Record<string, unknown>>(result.stdout);
    return rows.map((row) => {
      const name = String(row.Name ?? row.Service ?? '');
      const id = String(row.ID ?? '');
      return {
        name,
        ...id === '' || id === '<none>' ? {} : { id },
        state: String(row.State ?? ''),
        ...row.Status === undefined ? {} : { status: String(row.Status) },
        ...row.Ports === undefined || row.Ports === '' ? {} : { ports: String(row.Ports) },
      };
    });
  }
}

/** Build the argv for a compose-scoped command. */
export function composeArgs(project: ProjectContext, sub: readonly string[]): string[] {
  const args: string[] = ['compose'];
  if (project.file !== '') args.push('-f', project.file);
  args.push('-p', project.project);
  args.push(...sub);
  return args;
}

/** Split docker log output into lines without a trailing empty element. */
export function splitLogLines(text: string): string[] {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
