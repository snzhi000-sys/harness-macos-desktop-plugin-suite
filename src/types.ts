/**
 * dsh-docker shared types: the plugin configuration, the resolved compose
 * project, the tool-output row vocabularies, and the policy classification.
 * Pure types plus a few resolvers — no runtime harness imports, so this
 * module is safe for the standalone policy and resolver tests to consume.
 *
 * @module dsh-docker/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-session';

/** One container row of the canonical `docker_ps` output. */
export interface ContainerRow {
  /** Short 12-hex container id. */
  id: string;
  /** Container name (the CLI `--format` names column). */
  name: string;
  /** Image reference the container runs. */
  image: string;
  /** Engine lifecycle state, e.g. `running` | `exited` | `created`. */
  state: string;
  /** Human status line, e.g. `Up 2 hours`. */
  status: string;
  /** Published/bound ports, e.g. `0.0.0.0:8080->80/tcp`. */
  ports: string[];
  /** Compose project name, derived from the `com.docker.compose.project` label. */
  project?: string;
  /** Compose service name, derived from the `com.docker.compose.service` label. */
  service?: string;
}

/** Canonical `docker_ps` output. */
export interface PsOutput {
  containers: ContainerRow[];
}

/** Canonical `docker_logs` output. */
export interface LogsOutput {
  lines: string[];
  /** True when the pull hit the `tail` cap and dropped older lines. */
  truncated: boolean;
}

/** Canonical `docker_inspect` output: the raw engine JSON, validated as an open object. */
export type InspectOutput = Record<string, JsonValue>;

/** Canonical `docker_exec` output. */
export interface ExecOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Canonical `docker_start` / `docker_stop` / `docker_restart` / `docker_rm` output. */
export interface AffectedOutput {
  /** Refs (names or ids) the operation acted on. */
  affected: string[];
}

/** One image row of the canonical `docker_images` output. */
export interface ImageRow {
  id: string;
  repository: string;
  tag: string;
  /** Human size, e.g. `123MB`. */
  size: string;
  /** True when at least one container (running or stopped) references this image. */
  inUse: boolean;
}

/** Canonical `docker_images` output. */
export interface ImagesOutput {
  images: ImageRow[];
}

/** Canonical `docker_rmi` output. */
export interface RmiOutput {
  /** Image refs removed. */
  removed: string[];
}

/** Canonical `docker_prune` output. */
export interface PruneOutput {
  /** What was pruned (system/images/containers/volumes/networks). */
  scope: string;
  /** Whether `-a` (also unused images) was passed. */
  all: boolean;
  /** Whether `--volumes` was passed. */
  volumes: boolean;
  /** True when the engine reported success (exit 0). */
  ok: boolean;
}

/** One compose service row of the canonical `docker_compose_ps` output. */
export interface ComposeServiceRow {
  name: string;
  /** Container id (short). */
  id?: string;
  state: string;
  status?: string;
  ports?: string;
}

/** Canonical `docker_compose_ps` output. */
export interface ComposePsOutput {
  project: string;
  services: ComposeServiceRow[];
}

/** Canonical `docker_compose_up` output. */
export interface ComposeUpOutput {
  project: string;
  /** Service names the stack was asked to start. */
  services: string[];
  /** `--detach` as executed. */
  detached: boolean;
}

/** Canonical `docker_compose_down` output. */
export interface ComposeDownOutput {
  project: string;
  affected: string[];
  /** Whether `-v` (volumes) was passed. */
  volumes: boolean;
}

/**
 * The resolved compose project context one tool call runs under. `undefined`
 * when no compose file was detected and no explicit project override was
 * given — container-scoped tools then operate globally and the
 * project-aware behaviors are off.
 */
export interface ProjectContext {
  /** Compose file path passed as `-f`. */
  file: string;
  /** Compose project name passed as `-p`. */
  project: string;
  /** Absolute working directory the compose file was discovered in. */
  cwd: string;
}

/** Runtime facts a tool call needs for policy classification (resolved before classify). */
export interface ResolvedFacts {
  /** Whether the target container is currently running. */
  running?: boolean;
  /** Whether the target image is referenced by any container. */
  imageInUse?: boolean;
}

/** The policy verdict for one tool call. */
export type ToolEffect = {
  effect: 'safe';
  reason: string;
} | {
  effect: 'guarded';
  reason: string;
};

/** Approval globs as configured; `*` matches any run of characters. */
export type ApprovalPattern = string;

/** Plugin configuration as accepted from the profile patch (all optional). */
export interface Config {
  /** Master switch for the whole plugin. */
  enabled?: boolean;
  /** Compose file names searched, config-ordered, walking up from the tool cwd. */
  composeFiles?: string[];
  /**
   * Ops routed to the human approval gate. Ops in the hard-destructive set
   * that are NOT covered by a pattern here are refused outright (fail closed).
   */
  approval?: ApprovalPattern[];
  /**
   * Treat an unflagged `docker_exec` as read-only (safe). `false` flips the
   * default for users who accept the risk of ungated exec.
   */
  execReadOnly?: boolean;
  /** Command timeout for one docker invocation, in milliseconds. */
  timeoutMs?: number;
  /** Service-health context tuning. */
  healthContext?: {
    enabled?: boolean;
    maxServices?: number;
  };
}

/** The plugin configuration with every default materialized. */
export interface ResolvedConfig {
  enabled: boolean;
  composeFiles: string[];
  approval: ApprovalPattern[];
  execReadOnly: boolean;
  timeoutMs: number;
  healthContext: HealthContextConfig;
}

/** Health-context tuning with defaults materialized. */
export interface HealthContextConfig {
  enabled: boolean;
  maxServices: number;
}

/** Plugin-wide defaults. */
export const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  composeFiles: ['docker-compose.yml', 'compose.yaml'],
  approval: ['rmi:*', 'rm:*', 'prune:*', 'compose down -v', 'exec:*'],
  execReadOnly: true,
  timeoutMs: 30_000,
  healthContext: { enabled: false, maxServices: 12 },
};

/** Merge a raw config against the defaults (defensive against partial patches). */
export function resolveConfig(raw: Config | undefined): ResolvedConfig {
  const r = raw ?? {};
  return {
    enabled: r.enabled ?? DEFAULT_CONFIG.enabled,
    composeFiles: r.composeFiles ?? DEFAULT_CONFIG.composeFiles,
    approval: r.approval ?? DEFAULT_CONFIG.approval,
    execReadOnly: r.execReadOnly ?? DEFAULT_CONFIG.execReadOnly,
    timeoutMs: r.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    healthContext: {
      enabled: r.healthContext?.enabled ?? DEFAULT_CONFIG.healthContext.enabled,
      maxServices: r.healthContext?.maxServices ?? DEFAULT_CONFIG.healthContext.maxServices,
    },
  };
}
