/** Browser/Preview projection used by the product's right content rail. */

import { allLeaves, closeTab, type SidebarState, type SplitNode } from './state.ts'

const RIGHT_SURFACE_TYPES = new Set(['browser', 'preview'])

/** Preserve pane geometry while hiding every tab outside Browser and Preview. */
export function rightSurfaceTree(node: SplitNode): SplitNode {
  if (node.kind === 'split') {
    return { ...node, children: node.children.map(rightSurfaceTree) }
  }
  const tabs = node.tabs.filter(tab => RIGHT_SURFACE_TYPES.has(tab.type))
  return {
    ...node,
    tabs,
    active: tabs.some(tab => tab.id === node.active) ? node.active : (tabs[0]?.id ?? null),
  }
}

/**
 * Close a workbench tab and collapse the right rail only when that tab was
 * its final Browser/Preview surface.
 */
export function closeTabAndMaybeCollapseRightSurface(
  state: SidebarState,
  paneId: string,
  tabId: string,
): SidebarState {
  const surfaceTabs = allLeaves(state.splits)
    .flatMap(leaf => leaf.tabs)
    .filter(tab => RIGHT_SURFACE_TYPES.has(tab.type))
  const closesLastSurface = surfaceTabs.length === 1 && surfaceTabs[0]?.id === tabId
  const next = closeTab(state, paneId, tabId)
  return closesLastSurface ? { ...next, panelOpen: false } : next
}
