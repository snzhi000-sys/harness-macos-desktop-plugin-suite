/**
 * Renderer-lifetime Explorer listings, owned by workspace root rather than
 * conversation id. Session switches inside one workspace therefore reuse
 * already loaded directories; a later poll remains responsible for freshness.
 */
import type { LevelData } from './ExplorerView.tsx'

const listingsByRoot = new Map<string, Record<string, LevelData>>()

/** Read the cached listings for one workspace, or an empty tree on first use. */
export function explorerDataForWorkspace(root: string | undefined): Record<string, LevelData> {
  if (root === undefined) return {}
  return listingsByRoot.get(root) ?? {}
}

/** Replace one workspace's immutable Explorer listing snapshot. */
export function storeExplorerDataForWorkspace(root: string, data: Record<string, LevelData>): void {
  listingsByRoot.set(root, data)
}

/** Test-only cache reset; production data lives only for the renderer lifetime. */
export function clearWorkspaceExplorerCache(): void {
  listingsByRoot.clear()
}
