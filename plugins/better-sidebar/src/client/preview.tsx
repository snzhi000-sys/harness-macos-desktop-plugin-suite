/** Read-only media/document preview tabs and their file-routing seam. */

import { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import type { Context } from '../context-types.ts'
import { EditorHost } from './EditorHost.tsx'
import { resolveSidebarPath } from './produced-files.ts'
import { firstLeaf, PANEL_MAX, setWidth, type SidebarStore, type SidebarTab } from './state.ts'
import type { BetterSidebarService, FileViewerDescriptor, TabComponentProps } from './service.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** Viewer types owned by the right-side read-only preview surface. */
export const PREVIEW_VIEWER_IDS = ['image', 'video', 'pdf', 'docx', 'xlsx', 'pptx'] as const
const PREVIEW_VIEWERS = new Set<string>(PREVIEW_VIEWER_IDS)
const OFFICE_PREVIEW_VIEWERS = new Set<string>(['docx', 'xlsx', 'pptx'])
export const OFFICE_COMFORTABLE_WIDTH = 520

/** Office previews offer a user-controlled expansion at compact widths. */
export function shouldOfferPreviewExpansion(viewerId: string | undefined, width: number): boolean {
  return viewerId !== undefined && OFFICE_PREVIEW_VIEWERS.has(viewerId) && width < OFFICE_COMFORTABLE_WIDTH
}

/** Heavy Office renderers live only while their Preview is actually visible. */
export function shouldMountPreviewContent(viewerId: string | undefined, visible: boolean): boolean {
  return viewerId === undefined || !OFFICE_PREVIEW_VIEWERS.has(viewerId) || visible
}

/** Return the enabled right-preview viewer for a path, excluding text/editor viewers. */
export function previewViewerForPath(
  service: BetterSidebarService | undefined,
  path: string,
): FileViewerDescriptor | undefined {
  const viewer = service?.matchFileViewer(path)
  return viewer !== undefined && PREVIEW_VIEWERS.has(viewer.id) ? viewer : undefined
}

/** Resolve the viewer stored on a preview tab (used by the tab strip icon). */
export function previewViewerForTab(
  service: BetterSidebarService | undefined,
  tab: SidebarTab,
): FileViewerDescriptor | undefined {
  if (tab.type !== 'preview' || tab.viewerId === undefined) return undefined
  if (service?.isViewerEnabled(tab.viewerId) === false) return undefined
  return service?.getFileViewers().find(viewer => viewer.id === tab.viewerId)
}

/** Render a preview tab with its viewer-specific icon. */
export function previewTabIcon(
  service: BetterSidebarService | undefined,
  tab: SidebarTab,
  size: number,
): ReactNode | undefined {
  const icon = previewViewerForTab(service, tab)?.icon
  if (icon === undefined) return undefined
  return typeof icon === 'function' ? icon(size) : icon
}

/** Component behind the hidden preview tab descriptor. */
export function PreviewHost({ ctx, store, scope, tab, visible }: TabComponentProps): ReactNode {
  const snapshot = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
  const width = snapshot.state?.width ?? PANEL_MAX
  const offerExpansion = shouldOfferPreviewExpansion(tab.viewerId, width)
  const mountContent = shouldMountPreviewContent(tab.viewerId, visible)

  return (
    <div className={css.previewHost}>
      {mountContent && offerExpansion && (
        <div className={css.previewWidthHint}>
          <span>{t('previewWidthHint')}</span>
          <button
            type="button"
            className={css.previewExpandButton}
            onClick={() => { store.reduce(state => setWidth(state, PANEL_MAX)) }}
          >
            {t('expandPreviewPanel')}
          </button>
        </div>
      )}
      {mountContent && (
        <EditorHost
          ctx={ctx}
          store={store}
          scope={scope}
          path={tab.path ?? ''}
          title={tab.title}
          visible={visible}
          viewerId={tab.viewerId}
        />
      )}
    </div>
  )
}

/**
 * Open a supported media/document as one path-deduplicated preview tab.
 * Called only after the unified file router has selected the Preview target.
 */
export function tryOpenFilePreview(
  ctx: Context,
  store: SidebarStore,
  sessionId: string,
  path: string,
  resolvedCwd?: string,
): boolean {
  const service = ctx.betterSidebar
  if (service === undefined || service.getTab('preview') === undefined || !service.isTabEnabled('preview')) return false
  const cwd = resolvedCwd ?? ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
  const absolute = resolveSidebarPath(cwd, path)
  const viewer = previewViewerForPath(service, absolute)
  if (viewer === undefined) return false
  const at = Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\'))
  const title = at === -1 ? absolute : absolute.slice(at + 1)
  // Preview belongs beside Browser in the right surface. Preselecting its
  // tree prevents a focused bottom workbench from capturing the file tab.
  store.reduce(state => ({ ...state, activePane: firstLeaf(state.splits).id }))
  service.openTab({
    type: 'preview',
    id: `preview:${absolute}`,
    title,
    path: absolute,
    viewerId: viewer.id,
  })
  return true
}
