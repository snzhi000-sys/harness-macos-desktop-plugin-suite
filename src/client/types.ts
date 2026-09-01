/**
 * Client-side payload types for the dsh-docker status renderer. The data
 * crosses the wire as JSON on the `tool/result` `meta` (the tool's
 * `presentationMeta` projection), so these are structural mirrors of the
 * host-side row types — deliberately not imports from the host bundle, to
 * keep the client bundle self-contained.
 *
 * @module dsh-docker/client/types
 */

/** The status tools this renderer knows. */
export type DockerStatusTool = 'docker_ps' | 'docker_compose_ps' | 'docker_logs';

/** One container row (docker_ps meta). */
export interface DockerStatusContainerRow {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string[];
  project?: string;
  service?: string;
}

/** One compose service row (docker_compose_ps meta). */
export interface DockerStatusServiceRow {
  name: string;
  id?: string;
  state: string;
  status?: string;
  ports?: string;
}

/** The tool-private `presentationMeta` shapes the renderer consumes. */
export type DockerStatusMeta =
  | { tool: 'docker_ps'; rows: DockerStatusContainerRow[] }
  | { tool: 'docker_compose_ps'; project: string; rows: DockerStatusServiceRow[] }
  | { tool: 'docker_logs'; lines: string[]; truncated: boolean };

/** Narrow an unknown meta value to a supported status meta. */
export function isStatusMeta(meta: unknown): meta is DockerStatusMeta {
  if (typeof meta !== 'object' || meta === null) return false;
  const tool = (meta as { tool?: unknown }).tool;
  return tool === 'docker_ps' || tool === 'docker_compose_ps' || tool === 'docker_logs';
}

/** The renderer-ready chat payload produced by the Definition. */
export interface DockerStatusChatData {
  /** The tool that produced the call. */
  tool: DockerStatusTool;
  /** Short always-visible title. */
  title: string;
  /** True once the tool/result meta arrived. */
  settled: boolean;
  /** Container/compose rows when the call produced a table. */
  rows?: readonly DockerStatusContainerRow[] | readonly DockerStatusServiceRow[];
  /** Compose project name when known. */
  project?: string;
  /** Log lines when the call was docker_logs. */
  lines?: readonly string[];
  /** The log pull was capped and dropped older lines. */
  truncated?: boolean;
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'docker-status': DockerStatusChatData;
  }
}
