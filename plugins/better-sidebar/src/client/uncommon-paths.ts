export interface UncommonPath {
  path: string
  isDir: boolean
}

export interface ExplorerVisibility {
  paths: UncommonPath[]
  hideUncommon: boolean
}

export const EXPLORER_VISIBILITY_EVENT = 'dsh-explorer-visibility-change'

function belongsToPath(value: string, path: string): boolean {
  return value === path || value.startsWith(`${path}/`) || value.startsWith(`${path}\\`)
}

function replacePathPrefix(value: string, from: string, to: string): string {
  return belongsToPath(value, from) ? `${to}${value.slice(from.length)}` : value
}

export function sanitizeUncommonPaths(value: unknown): UncommonPath[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const paths: UncommonPath[] = []
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== 'object') continue
    const record = candidate as Record<string, unknown>
    if (typeof record.path !== 'string' || record.path === '' || seen.has(record.path)) continue
    seen.add(record.path)
    paths.push({ path: record.path, isDir: record.isDir === true })
  }
  return paths
}

export function sanitizeExplorerVisibility(value: unknown): ExplorerVisibility {
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  return { paths: sanitizeUncommonPaths(record.paths), hideUncommon: record.hideUncommon === true }
}

export function toggleUncommonPath(paths: readonly UncommonPath[], path: string, isDir: boolean): UncommonPath[] {
  return paths.some(entry => entry.path === path)
    ? paths.filter(entry => entry.path !== path)
    : [...paths, { path, isDir }]
}

export function renameUncommonPaths(paths: readonly UncommonPath[], from: string, to: string): UncommonPath[] {
  if (from === to) return [...paths]
  return sanitizeUncommonPaths(paths.map(entry => ({ ...entry, path: replacePathPrefix(entry.path, from, to) })))
}

export function deleteUncommonPaths(paths: readonly UncommonPath[], path: string): UncommonPath[] {
  return paths.filter(entry => !belongsToPath(entry.path, path))
}
