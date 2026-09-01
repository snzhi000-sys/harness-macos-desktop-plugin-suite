/** Pure routing decisions for the unified file-open funnel. */

import type { BetterSidebarService, FileViewerDescriptor } from './service.ts'
import { PREVIEW_VIEWER_IDS } from './preview.tsx'

const PREVIEW_VIEWERS = new Set<string>(PREVIEW_VIEWER_IDS)

export type FileOpenPlan =
  | { target: 'preview'; viewer: FileViewerDescriptor }
  | { target: 'file-edit'; viewer: FileViewerDescriptor }
  | { target: 'probe'; viewer: FileViewerDescriptor }
  | { target: 'fallback'; reason: 'preview-disabled' | 'download-only' | 'no-viewer' | 'binary' }

function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const at = name.lastIndexOf('.')
  return at <= 0 || at === name.length - 1 ? '' : name.slice(at + 1).toLowerCase()
}

/** Highest-priority Preview viewer claiming this extension, including disabled viewers. */
function declaredPreviewViewer(service: BetterSidebarService, path: string): FileViewerDescriptor | undefined {
  const ext = extensionOf(path)
  return service.getFileViewers()
    .map((viewer, index) => ({ viewer, index }))
    .filter(({ viewer }) => PREVIEW_VIEWERS.has(viewer.id) && viewer.exts.includes(ext))
    .sort((a, b) => (b.viewer.priority ?? 0) - (a.viewer.priority ?? 0) || a.index - b.index)[0]?.viewer
}

/**
 * Decide without reading bytes. Catch-all code requires one Host probe so an
 * unknown binary never gets sent to the top-level text editor by mistake.
 */
export function planFileOpen(service: BetterSidebarService | undefined, path: string): FileOpenPlan {
  if (service === undefined) return { target: 'fallback', reason: 'no-viewer' }

  const viewer = service.matchFileViewer(path)
  if (viewer !== undefined && PREVIEW_VIEWERS.has(viewer.id)) return { target: 'preview', viewer }

  // `matchFileViewer` deliberately skips disabled viewers. When a declared
  // Preview renderer is off, do not let the low-priority code/download
  // fallbacks claim its binary format. A higher-priority non-Preview viewer
  // may still intentionally override the extension and go to file-edit.
  const declaredPreview = declaredPreviewViewer(service, path)
  if (
    declaredPreview !== undefined
    && !service.isViewerEnabled(declaredPreview.id)
    && (viewer === undefined || viewer.id === 'code' || viewer.fetchStrategy === 'binary-download')
  ) {
    return { target: 'fallback', reason: 'preview-disabled' }
  }

  if (viewer === undefined) return { target: 'fallback', reason: 'no-viewer' }
  if (viewer.fetchStrategy === 'binary-download') return { target: 'fallback', reason: 'download-only' }
  if (viewer.id === 'code') return { target: 'probe', viewer }
  return { target: 'file-edit', viewer }
}

/** Finish a catch-all text/binary probe. */
export function resolveProbedFileOpen(plan: FileOpenPlan, kind: 'text' | 'binary'): FileOpenPlan {
  if (plan.target !== 'probe') return plan
  return kind === 'text'
    ? { target: 'file-edit', viewer: plan.viewer }
    : { target: 'fallback', reason: 'binary' }
}
