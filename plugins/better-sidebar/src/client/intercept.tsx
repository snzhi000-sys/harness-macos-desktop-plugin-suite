/**
 * Interception of the chat's produced-files row: the turn-tail chain entry
 * that replaces ui-deliverables' row when the closing turn produced files.
 * The takeover looks identical (same chip row); the chips open the file in
 * the unified file router instead of the host OS. Priority -1 runs before the default-0
 * deliverables entry; when nothing was produced the selector returns null
 * and the original row renders unchanged.
 */
import { IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { api, downloadUrl, htmlUrl } from './api.ts'
import { deletePathInState, renamePathInState, type SidebarStore } from './state.ts'
import { t } from './locales.ts'
import { resolveSidebarPath, selectProducedFiles } from './produced-files.ts'
import { relativeTo } from './paths.ts'
import { wrapOpenPath } from './openpath-intercept.ts'
import { planFileOpen, resolveProbedFileOpen, type FileOpenPlan } from './file-open-router.ts'
import { tryOpenFilePreview } from './preview.tsx'
import css from './sidebar.module.css'

/** Whether the independent top-level “文件” workspace can accept a file open. */
export function hasTopFileWorkspace(): boolean {
  const fileEdit = (typeof window !== 'undefined') ? (window as any).__dshFileEdit : undefined
  return fileEdit !== undefined && typeof fileEdit.open === 'function'
}

/** Trigger a binary-safe browser download through the sidebar Host route. */
function downloadFile(sessionId: string, cwd: string | undefined, path: string): void {
  if (typeof document === 'undefined') return
  const anchor = document.createElement('a')
  anchor.href = downloadUrl({ sessionId, cwd }, path)
  anchor.download = ''
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export interface FileOpenOptions {
  /** Host/OS open for workspaces.openPath; direct UI callers default to download. */
  fallback?: () => void | Promise<void>
  /** Test seam for the catch-all code viewer's text/binary probe. */
  probe?: () => Promise<'text' | 'binary'>
}

/** Unified file opener used by Explorer, chat, tool results and other plugins. */
export async function openSidebarFile(
  ctx: Context,
  store: SidebarStore,
  sessionId: string,
  path: string,
  resolvedCwd?: string,
  options: FileOpenOptions = {},
): Promise<'preview' | 'file-edit' | 'fallback'> {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  const cwd = resolvedCwd ?? summary?.cwd
  const absolute = resolveSidebarPath(cwd, path)
  const projectedPath = relativeTo(cwd ?? '', absolute)
  const outsideWorkspace = cwd !== undefined && projectedPath === absolute
  const fallback = async (): Promise<'fallback'> => {
    if (options.fallback !== undefined) await options.fallback()
    else downloadFile(sessionId, cwd, absolute)
    return 'fallback'
  }

  let plan: FileOpenPlan = planFileOpen(ctx.betterSidebar, absolute)
  if (plan.target === 'probe') {
    // The sidebar media probe is intentionally workspace-scoped. External
    // text targets are validated and classified by dsh-file-edit's Host
    // resolver instead, so artifact links do not fail before reaching it.
    if (outsideWorkspace) plan = resolveProbedFileOpen(plan, 'text')
    else
    try {
      const kind = options.probe !== undefined
        ? await options.probe()
        : (await api.fsRead({ sessionId, cwd }, absolute)).kind
      plan = resolveProbedFileOpen(plan, kind)
    } catch {
      return fallback()
    }
  }

  if (plan.target === 'preview') {
    return tryOpenFilePreview(ctx, store, sessionId, absolute, cwd) ? 'preview' : fallback()
  }
  if (plan.target === 'file-edit') {
    const fileEdit = (typeof window !== 'undefined') ? (window as any).__dshFileEdit : undefined
    if (fileEdit !== undefined && typeof fileEdit.open === 'function') {
      try {
        const opened = await fileEdit.open({
          sessionId,
          cwd,
          absolutePath: absolute,
          path: projectedPath,
        })
        return opened === false ? fallback() : 'file-edit'
      } catch {
        return fallback()
      }
    }
  }
  return fallback()
}

/** Open a workspace HTML document in a fresh built-in Browser tab. */
export function openHtmlInBrowser(
  ctx: Context,
  sessionId: string,
  path: string,
  resolvedCwd?: string,
): void {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  const absolute = resolveSidebarPath(resolvedCwd ?? summary?.cwd, path)
  const at = Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\'))
  const title = at === -1 ? absolute : absolute.slice(at + 1)
  const route = htmlUrl({ sessionId, cwd: resolvedCwd ?? summary?.cwd }, absolute)
  const url = typeof window === 'undefined' ? route : new URL(route, window.location.origin).href
  ctx.betterSidebar?.openTab({ type: 'browser', title, url })
}

/** Synchronize a successful Explorer rename with both sidebar tabs and dsh-file-edit's top-level tabs. */
export function synchronizeRenamedPath(store: SidebarStore, cwd: string | undefined, from: string, to: string): void {
  store.reduce(state => renamePathInState(state, from, to))
  const fileEdit = (typeof window !== 'undefined') ? (window as any).__dshFileEdit : undefined
  if (fileEdit !== undefined && typeof fileEdit.rename === 'function') {
    fileEdit.rename(relativeTo(cwd ?? '', from), relativeTo(cwd ?? '', to))
  }
}

/** Synchronize a successful Explorer deletion with sidebar and file-edit tabs. */
export function synchronizeDeletedPath(store: SidebarStore, cwd: string | undefined, path: string): void {
  store.reduce(state => deletePathInState(state, path))
  const fileEdit = (typeof window !== 'undefined') ? (window as any).__dshFileEdit : undefined
  if (fileEdit !== undefined && typeof fileEdit.markDeleted === 'function') {
    fileEdit.markDeleted(relativeTo(cwd ?? '', path))
  }
}

/** The intercepted produced-files row (visual twin of the deliverables chips). */
export function SidebarProducedFiles(props: {
  matched: readonly string[]
  openInSidebar: (path: string) => void
}) {
  const { matched, openInSidebar } = props
  const shown = matched.slice(0, 6)
  const hidden = matched.length - shown.length
  return (
    <div className={css.producedRow}>
      <span className={css.producedLabel}>{t('produced')}</span>
      {shown.map(path => {
        const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
        const name = at === -1 ? path : path.slice(at + 1)
        return (
          <button
            key={path}
            type="button"
            className={css.producedChip}
            title={path}
            onClick={() => { openInSidebar(path) }}
          >
            <IconCodeOutline16 size={12} />
            <span>{name}</span>
          </button>
        )
      })}
      {hidden > 0 && <span className={css.producedMore}>+{hidden}</span>}
    </div>
  )
}

/**
 * Register the turn-tail interception (returns the disposer).
 *
 * The slot is a CHILD slot the host's ui-conversation declares in its
 * `conversation.chat.node` children table (kind: chain, scope: session).
 * Registering it directly races the declaration — the ui-slots core's
 * load-time validation throws "not declared (a parent entry's children
 * table must declare it)" when the parent entry is not on the ledger yet.
 * slots.inject waits for the declaration: the callback runs synchronously
 * when the slot is already declared, otherwise it runs inside the declaring
 * register() call once the declaration commits; declaration collapse
 * disposes the entry and a later declaration re-registers it. This mirrors
 * @deepseek-ai/dsh-client-ui-deliverables' registration of the same slot.
 */
export function registerTurnTailInterception(ctx: Context, store: SidebarStore): () => void {
  return ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    // Every produced file uses the same Preview/file-edit/fallback router.
    select: (owner) => {
      return selectProducedFiles(owner)
    },
    priority: -1,
    registrant: 'dsh-better-sidebar',
    inject: (sessionId: string) => ({
      openInSidebar: (path: string) => { void openSidebarFile(ctx, store, sessionId, path) },
    }),
  }, SidebarProducedFiles))
}

/**
 * Register the chat file-open interception: wraps `ctx.workspaces.openPath`
 * — the single funnel every chat-side file open goes through (tool-row path
 * links, the produced-files row, prose mentions and standard plugin requests)
 * — so all formats share the same Preview/file-edit/fallback decision. Gated
 * by `interceptOpenPath`; the original Host/OS method remains the router's
 * final fallback. Returns the disposer restoring the original (HMR-safe).
 */
export function registerOpenPathInterception(ctx: Context, store: SidebarStore): () => void {
  return wrapOpenPath(ctx.workspaces, {
    takeoverEnabled: () => store.getPrefs().interceptOpenPath !== false,
    currentSessionId: () => ctx.sessions.list.getSnapshot().current,
    openInSidebar: async (path, sessionId, fallback) => {
      await openSidebarFile(ctx, store, sessionId, path, undefined, { fallback })
    },
  })
}
