/**
 * The file explorer: a lazy VSCode-style tree rooted at the session's
 * working directory. Levels load on expansion (one API call per directory),
 * directories sort first, hidden entries render dimmed, and the expansion
 * set lives in the per-session state. Clicking a file opens an editor tab.
 *
 * Right-click opens a context menu to reference, rename, create child folders, or copy the
 * relative/absolute path (with a brief "copied" label after a successful
 * write); file rows also offer a download action (the
 * host serves raw bytes, binary-safe).
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCodeOutline16, IconCopyOutline16, IconDownloadOutline16, IconFolderClose16, IconFolderOpen16,
  IconFolderOpenOutline16,
  IconLinkOutline16, IconProjectAddOutline16, IconTrashOutline16, Menu, Modal, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconDocxOutline16, IconEditOutline16, IconHtmlOutline16, IconImageOutline16, IconMarkdownOutline16,
  IconEyeOutline16, IconGlobeOutline16, IconPdfOutline16, IconPptxOutline16, IconXlsxOutline16,
} from './icons.tsx'
import { api, downloadUrl, type ExplorerVisibilityMutationWire, type FsDeletePreview, type FsEntry } from './api.ts'
import { relativeTo } from './paths.ts'
import {
  deleteFolderMarks, FOLDER_MARK_EMOJIS, FOLDER_MARKS_EVENT, folderMarksStorageKey,
  loadFolderMarks, renameFolderMarks, saveFolderMarks, sanitizeFolderMarks, toggleFolderMark,
  type FolderMark, type FolderMarkEmoji,
} from './folder-marks.ts'
import {
  deleteUncommonPaths, EXPLORER_VISIBILITY_EVENT, renameUncommonPaths, sanitizeExplorerVisibility,
  toggleUncommonPath, type ExplorerVisibility,
} from './uncommon-paths.ts'
import { t } from './locales.ts'
import { scheduleStartupTask, type StartupTaskLane } from './startup-tasks.ts'
import { explorerDataForWorkspace, storeExplorerDataForWorkspace } from './workspace-explorer-cache.ts'
import css from './sidebar.module.css'

export interface LevelData {
  entries?: FsEntry[]
  error?: string
}

/** Root label: the last path segment (mirror of the host rootLabel). */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** Parent path for either POSIX or Windows-style separators. */
function parentPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at <= 0 ? trimmed.slice(0, Math.max(1, at + 1)) : trimmed.slice(0, at)
}

/** Replace one path prefix while keeping unrelated entries byte-for-byte stable. */
function remapPath(path: string, from: string, to: string): string {
  return path === from || path.startsWith(`${from}/`) || path.startsWith(`${from}\\`)
    ? `${to}${path.slice(from.length)}`
    : path
}

/**
 * Optimistically remap the already-rendered tree after a successful rename.
 * Keeping every loaded level populated prevents the scroll container from
 * briefly collapsing to zero height (which would clamp scrollTop to 0).
 */
export function remapExplorerDataAfterRename(
  cache: Record<string, LevelData>,
  from: string,
  to: string,
): Record<string, LevelData> {
  const next: Record<string, LevelData> = {}
  for (const [levelPath, level] of Object.entries(cache)) {
    const entries = level.entries?.map((entry) => {
      const path = remapPath(entry.path, from, to)
      if (path === entry.path) return entry
      const exact = entry.path === from
      const name = exact ? baseName(to) : entry.name
      return { ...entry, path, name, ...(exact ? { hidden: name.startsWith('.') } : {}) }
    })
    next[remapPath(levelPath, from, to)] = entries === undefined ? level : { ...level, entries }
  }
  return next
}

/** Move one already-rendered file/folder and remap its loaded subtree. */
export function remapExplorerDataAfterMove(
  cache: Record<string, LevelData>,
  from: string,
  to: string,
): Record<string, LevelData> {
  let source: FsEntry | undefined
  for (const level of Object.values(cache)) {
    source = level.entries?.find(entry => entry.path === from)
    if (source !== undefined) break
  }
  if (source === undefined) return cache

  const sourceParent = parentPath(from)
  const targetParent = parentPath(to)
  const moved: FsEntry = { ...source, path: to, name: baseName(to), hidden: baseName(to).startsWith('.') }
  // Prefix-remap every loaded child level first. For a directory this keeps
  // its expanded subtree mounted at the new path; for a file only the source
  // row changes.
  const next = remapExplorerDataAfterRename(cache, from, to)
  for (const parent of new Set([sourceParent, targetParent])) {
    const level = next[parent]
    if (level?.entries === undefined) continue
    let entries = level.entries.filter(entry => entry.path !== from && entry.path !== to)
    if (parent === targetParent) entries = [...entries, moved]
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    next[parent] = { ...level, entries }
  }
  return next
}

/** Compact, deterministic byte size used by the delete confirmation. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** Editable stem + immutable suffix. Dotfiles without a second dot have no suffix. */
function editableName(name: string, isDir: boolean): { stem: string; suffix: string } {
  if (isDir) return { stem: name, suffix: '' }
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? { stem: name, suffix: '' } : { stem: name.slice(0, dot), suffix: name.slice(dot) }
}

/** Explorer's built-in-browser action is intentionally HTML-only. */
export function isHtmlFilePath(path: string): boolean {
  return /\.html?$/i.test(path)
}

/**
 * The file-type glyph for an explorer row, keyed off the lowercase extension.
 * Markdown gets the classic "M↓" badge tinted the theme's info blue, and the
 * tabular text formats (csv/tsv) get the spreadsheet grid tinted the theme's
 * success green; the other known office/media types get their matching
 * outline glyphs (default ink), and everything else falls back to the generic
 * code glyph.
 */
function fileIcon(name: string): ReactNode {
  const dot = name.lastIndexOf('.')
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
  switch (ext) {
    case 'md': case 'markdown': case 'mdx':
      return <IconMarkdownOutline16 size={14} className={css.fileIconMarkdown} />
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg':
    case 'bmp': case 'ico': case 'avif':
      return <IconImageOutline16 size={14} />
    case 'pdf':
      return <IconPdfOutline16 size={14} />
    case 'doc': case 'docx':
      return <IconDocxOutline16 size={14} />
    case 'csv': case 'tsv':
      return <IconXlsxOutline16 size={14} className={css.fileIconCsv} />
    case 'xls': case 'xlsx':
      return <IconXlsxOutline16 size={14} />
    case 'ppt': case 'pptx':
      return <IconPptxOutline16 size={14} />
    case 'html': case 'htm':
      return <IconHtmlOutline16 size={14} />
    default:
      return <IconCodeOutline16 size={14} />
  }
}

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

/** How often the explorer polls the visible directories for external changes. */
const EXPLORER_POLL_MS = 2000

/** Hovering a collapsed drop target for this long reveals its children. */
const DROP_EXPAND_MS = 650

/** Private drag payload: external Finder/browser drops never match it. */
const EXPLORER_ENTRY_MIME = 'application/x-dsh-explorer-entry'

/** True when two directory listings expose the same entries (path + kind). */
function sameEntries(a: FsEntry[] | undefined, b: FsEntry[]): boolean {
  if (a === undefined) return false
  if (a.length !== b.length) return false
  return a.every((entry, index) => {
    const other = b[index]
    return other !== undefined && entry.path === other.path && entry.isDir === other.isDir
  })
}

export function ExplorerView(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  onToggle: (path: string) => void
  /** Expand every ancestor of a marked file/folder so its row can be focused. */
  onRevealPath?: (path: string, isDir: boolean) => void
  /** Close every currently expanded Explorer directory. */
  onCollapseAll?: () => void
  onOpenFile: (path: string) => void
  /** Insert a file/folder path as an occurrence-backed inline chat chip. */
  onReferenceFile: (path: string, isDir?: boolean) => void
  /** Open an HTML file in a new built-in Browser tab. Omitted when Browser is disabled. */
  onOpenInBrowser?: (path: string) => void
  /** Keep parent-owned tabs/expanded paths coherent after a successful rename. */
  onRenamed?: (from: string, to: string) => void
  /** Close tabs and expansion state belonging to a successfully deleted entry. */
  onDeleted?: (path: string) => void
  /** Shared serial lane for post-paint Host reconciliation. */
  startupTasks?: StartupTaskLane
}) {
  const { sessionId, cwd, expanded, onToggle, onRevealPath, onCollapseAll, onOpenFile, onReferenceFile, onOpenInBrowser, onRenamed, onDeleted, startupTasks } = props
  const root = cwd
  const [data, setData] = useState<Record<string, LevelData>>(() => explorerDataForWorkspace(root))
  const dataRef = useRef(data)
  const rootRef = useRef(root)
  rootRef.current = root
  /** The current request authority changes with the conversation, while the cached data does not. */
  const scopeRef = useRef({ sessionId, cwd })
  scopeRef.current = { sessionId, cwd }
  /** Workspace-scoped file/folder anchors survive conversation switches. */
  const [folderMarks, setFolderMarks] = useState<FolderMark[]>([])
  /** Invalidates a slower Host hydration when the user edits marks meanwhile. */
  const folderMarksRevision = useRef(0)
  /** Workspace-scoped uncommon paths and their current Explorer projection. */
  const [visibility, setVisibility] = useState<ExplorerVisibility>({ paths: [], hideUncommon: false })
  /** Root rows wait for persisted visibility intent to avoid a visible-then-hidden flash. */
  const [visibilityReady, setVisibilityReady] = useState(false)
  /** Synchronous authority for event handlers; React updater functions must stay side-effect free. */
  const visibilityRef = useRef(visibility)
  /** Invalidates a slower Host hydration when the user edits visibility meanwhile. */
  const visibilityRevision = useRef(0)
  const [revealedPath, setRevealedPath] = useState<string | null>(null)
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null)
  const explorerBody = useRef<HTMLDivElement | null>(null)
  const rowElements = useRef(new Map<string, HTMLDivElement>())
  const revealTimer = useRef<number | null>(null)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; x: number; y: number } | null>(null)
  /** A marker's right-click menu contains only the explicit delete action. */
  const [markMenu, setMarkMenu] = useState<{ emoji: FolderMarkEmoji; x: number; y: number } | null>(null)
  /** Native-drag state. The ref is authoritative during drag events; state paints feedback. */
  const draggingPathRef = useRef<string | null>(null)
  const [draggingPath, setDraggingPath] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [movingPath, setMovingPath] = useState<string | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)
  /** Finder reveal failures do not disturb tree, selection, or move state. */
  const [revealError, setRevealError] = useState<string | null>(null)
  const expandDropTimer = useRef<number | null>(null)
  const expandDropTarget = useRef<string | null>(null)
  /** Native Harness confirmation modal, populated by the host-side size preflight. */
  const [deleting, setDeleting] = useState<{
    preview: FsDeletePreview
    busy: boolean
    error?: string
  } | null>(null)
  /** Inline rename editor. Files keep `suffix` outside the input and immutable. */
  const [renaming, setRenaming] = useState<{
    path: string
    isDir: boolean
    stem: string
    suffix: string
    saving: boolean
    error?: string
  } | null>(null)
  const renameInput = useRef<HTMLInputElement | null>(null)
  /** The path whose mounted input already received its initial focus/select. */
  const focusedRenamePath = useRef<string | null>(null)

  const acceptVisibility = useCallback((value: unknown): ExplorerVisibility => {
    const clean = sanitizeExplorerVisibility(value)
    visibilityRef.current = clean
    setVisibility(clean)
    return clean
  }, [])

  useEffect(() => () => {
    if (expandDropTimer.current !== null) window.clearTimeout(expandDropTimer.current)
    if (revealTimer.current !== null) window.clearTimeout(revealTimer.current)
  }, [])

  // Marks are workspace-owned; changing conversations under one root must
  // not rehydrate the same record.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const cached = explorerDataForWorkspace(root)
    dataRef.current = cached
    setData(cached)
  }, [root])

  useEffect(() => {
    const revision = ++folderMarksRevision.current
    if (root === undefined) {
      setFolderMarks([])
      return
    }
    const local = loadFolderMarks(root)
    setFolderMarks(local)
    const controller = new AbortController()
    void scheduleStartupTask(startupTasks, async () => {
      const result = await api.explorerMarksGet(scopeRef.current, controller.signal)
      // One-time migration from the old origin/port-scoped localStorage.
      // Once the Host has an initialized workspace record (including an
      // intentionally empty one), it is always authoritative.
      const remote = !result.initialized && local.length > 0
        ? (await api.explorerMarksSet(scopeRef.current, local)).marks
        : result.marks
      if (folderMarksRevision.current !== revision) return
      const clean = saveFolderMarks(root, remote)
      setFolderMarks(clean)
    }, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) console.warn('[dsh-better-sidebar] failed to hydrate Explorer marks:', error)
    })
    return () => { controller.abort() }
  }, [root, startupTasks])

  // Visibility is workspace-owned; the session id is request authority,
  // not its cache identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const revision = ++visibilityRevision.current
    if (root === undefined) {
      acceptVisibility({ paths: [], hideUncommon: false })
      setVisibilityReady(true)
      return
    }
    setVisibilityReady(false)
    const controller = new AbortController()
    void api.explorerVisibilitySnapshot(scopeRef.current, controller.signal).then((result) => {
      if (visibilityRevision.current !== revision) return
      acceptVisibility(result)
      setVisibilityReady(true)
      return scheduleStartupTask(startupTasks, async () => {
        const reconciled = await api.explorerVisibilityGet(scopeRef.current, controller.signal)
        if (visibilityRevision.current !== revision) return
        acceptVisibility(reconciled)
      }, controller.signal)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setVisibilityReady(true)
        console.warn('[dsh-better-sidebar] failed to hydrate Explorer visibility:', error)
      }
    })
    return () => { controller.abort() }
  }, [root, acceptVisibility, startupTasks])

  // Keep two mounted Explorer surfaces (and separate Harness windows) in
  // sync. The custom event covers this window; StorageEvent covers others.
  useEffect(() => {
    if (root === undefined) return
    const key = folderMarksStorageKey(root)
    const accept = (value: unknown): void => { setFolderMarks(sanitizeFolderMarks(value)) }
    const onLocalChange = (event: Event): void => {
      const detail = (event as CustomEvent<{ root?: unknown; marks?: unknown }>).detail
      if (detail?.root === root) accept(detail.marks)
    }
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== key) return
      try { accept(event.newValue === null ? [] : JSON.parse(event.newValue) as unknown) } catch { accept([]) }
    }
    window.addEventListener(FOLDER_MARKS_EVENT, onLocalChange)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(FOLDER_MARKS_EVENT, onLocalChange)
      window.removeEventListener('storage', onStorage)
    }
  }, [root])

  // Keep separately mounted Explorer surfaces in this Web window coherent.
  useEffect(() => {
    if (root === undefined) return
    const onChange = (event: Event): void => {
      const detail = (event as CustomEvent<{ root?: unknown; visibility?: unknown }>).detail
      if (detail?.root === root) {
        // A peer's newer state must also invalidate this instance's slower
        // initial Host hydration response.
        visibilityRevision.current += 1
        acceptVisibility(detail.visibility)
        setVisibilityReady(true)
      }
    }
    window.addEventListener(EXPLORER_VISIBILITY_EVENT, onChange)
    return () => { window.removeEventListener(EXPLORER_VISIBILITY_EVENT, onChange) }
  }, [root, acceptVisibility])

  const updateFolderMarks = useCallback((transform: (current: readonly FolderMark[]) => FolderMark[]): void => {
    if (root === undefined) return
    folderMarksRevision.current += 1
    setFolderMarks((current) => {
      const next = saveFolderMarks(root, transform(current))
      // Publish after React finishes this updater; a synchronous custom event
      // could otherwise re-enter setState in another mounted Explorer.
      queueMicrotask(() => {
        window.dispatchEvent(new CustomEvent(FOLDER_MARKS_EVENT, { detail: { root, marks: next } }))
        void api.explorerMarksSet({ sessionId, cwd: root }, next).catch((error: unknown) => {
          console.warn('[dsh-better-sidebar] failed to persist Explorer marks:', error)
        })
      })
      return next
    })
  }, [root, sessionId])

  const updateVisibility = useCallback((
    mutation: ExplorerVisibilityMutationWire,
    transform: (current: ExplorerVisibility) => ExplorerVisibility,
  ): void => {
    if (root === undefined) return
    const revision = ++visibilityRevision.current
    const next = acceptVisibility(transform(visibilityRef.current))
    // Run persistence exactly once per UI action, outside React's state
    // updater semantics (which may replay updater functions).
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent(EXPLORER_VISIBILITY_EVENT, { detail: { root, visibility: next } }))
      void api.explorerVisibilityUpdate({ sessionId, cwd: root }, mutation).then((stored) => {
        const authoritative = sanitizeExplorerVisibility(stored)
        window.dispatchEvent(new CustomEvent(EXPLORER_VISIBILITY_EVENT, { detail: { root, visibility: authoritative } }))
        if (visibilityRevision.current === revision) acceptVisibility(authoritative)
      }).catch((error: unknown) => {
        console.warn('[dsh-better-sidebar] failed to persist Explorer visibility:', error)
      })
    })
  }, [root, sessionId, acceptVisibility])

  useEffect(() => {
    if (renaming === null) {
      focusedRenamePath.current = null
      return
    }
    if (renaming.saving || focusedRenamePath.current === renaming.path) return
    const input = renameInput.current
    // A newly-created child of a collapsed folder mounts one render after the
    // rename state (when the parent expansion arrives). Do not mark it focused
    // until the real input exists; the `expanded` change retries this effect.
    if (input === null) return
    focusedRenamePath.current = renaming.path
    // Focusing a deeply indented rename field must not make the browser
    // programmatically scroll the horizontally clipped Explorer body.
    if (explorerBody.current !== null) explorerBody.current.scrollLeft = 0
    input.focus({ preventScroll: true })
    input.select()
    if (explorerBody.current !== null) explorerBody.current.scrollLeft = 0
  }, [renaming?.path, renaming?.saving, expanded])

  const storeLevel = useCallback((workspaceRoot: string, path: string, level: LevelData) => {
    const base = explorerDataForWorkspace(workspaceRoot)
    const next = { ...base, [path]: level }
    storeExplorerDataForWorkspace(workspaceRoot, next)
    if (rootRef.current !== workspaceRoot) return
    dataRef.current = next
    setData(next)
  }, [])

  /** Update the cache belonging to the Explorer currently on screen. */
  const storeCurrentLevel = useCallback((path: string, level: LevelData) => {
    if (root === undefined) return
    storeLevel(root, path, level)
  }, [root, storeLevel])

  const loadDir = useCallback((dir: string) => {
    if (dataRef.current[dir] !== undefined) return
    const workspaceRoot = root
    if (workspaceRoot === undefined) return
    storeLevel(workspaceRoot, dir, {})
    api.fsTree(scopeRef.current, dir).then((listing) => {
      storeLevel(workspaceRoot, dir, { entries: listing.entries })
    }).catch((error: unknown) => {
      storeLevel(workspaceRoot, dir, { error: error instanceof Error ? error.message : String(error) })
    })
  }, [root, storeLevel])

  useEffect(() => {
    // Load the visible set; already-loaded levels (kept in the cache) are
    // not refetched. The poll below keeps them fresh.
    const root = cwd
    if (root === undefined) return
    loadDir(root)
    for (const dir of expanded) loadDir(dir)
  }, [cwd, expanded, loadDir])

  // ── Auto-refresh: poll the visible directories for external changes ──────
  // Files added (or removed) by the model or other tools won't otherwise show
  // up, so this interval refetches the root + expanded directories and mutates
  // state only when a listing actually changed (or a level recovered from an
  // error) — collapsed levels and steady directories are left untouched.
  const expandedKey = expanded.join('\u0000')
  useEffect(() => {
    if (cwd === undefined) return
    const dirs = [cwd, ...expanded]
    const poll = () => {
      for (const dir of dirs) {
        api.fsTree(scopeRef.current, dir).then((listing) => {
          const prev = dataRef.current[dir]
          if (prev === undefined) return
          if (prev.error !== undefined || !sameEntries(prev.entries, listing.entries)) {
            storeLevel(cwd, dir, { entries: listing.entries })
          }
        }).catch(() => { /* transient failure: ignore, next tick retries */ })
      }
    }
    const id = window.setInterval(poll, EXPLORER_POLL_MS)
    return () => window.clearInterval(id)
    // `expanded` is captured through its stable key below to avoid identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, expandedKey, storeLevel])

  /** Copy `text`; on success flip the row's copied label for a moment. */
  const copyPath = useCallback((text: string, path: string): void => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopiedPath(path)
      window.setTimeout(() => {
        setCopiedPath(current => current === path ? null : current)
      }, COPIED_MS)
    })
  }, [])

  /** Trailing uncommon marker plus the short-lived copy confirmation. */
  const rowStatus = (path: string): ReactNode => {
    if (renaming?.path === path) return null
    const uncommon = visibility.paths.some(entry => entry.path === path)
    if (copiedPath === path) {
      return <span className={css.explorerCopied}>{t('copied')}</span>
    }
    return uncommon && !visibility.hideUncommon
      ? (
          <span className={css.explorerUncommonMark} title={t('uncommonMarked')} aria-label={t('uncommonMarked')}>
            <IconEyeOutline16 size={13} />
          </span>
        )
      : null
  }

  const openRowMenu = (event: MouseEvent, path: string, isDir: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setMarkMenu(null)
    setRowMenu({ path, isDir, x: event.clientX, y: event.clientY })
  }

  const beginRename = (path: string, isDir: boolean): void => {
    const parts = editableName(baseName(path), isDir)
    setRenaming({ path, isDir, ...parts, saving: false })
  }

  const submitRename = async (): Promise<void> => {
    const current = renaming
    if (current === null || current.saving) return
    if (current.stem.trim() === '') {
      // An empty editor means "keep the old/default name". This is especially
      // useful for a freshly-created folder: clearing the selected default and
      // clicking elsewhere leaves the already-created "新文件夹" in place.
      setRenaming(value => value?.path === current.path ? null : value)
      return
    }
    const original = editableName(baseName(current.path), current.isDir).stem
    if (current.stem === original) {
      setRenaming(value => value?.path === current.path ? null : value)
      return
    }
    setRenaming(value => value?.path === current.path
      ? { ...current, saving: true, error: undefined }
      : value)
    try {
      const result = await api.fsRename({ sessionId, cwd }, current.path, current.stem)
      // Never empty the whole cache here. The old clear-then-refetch flow
      // collapsed the scrollable body for one render and forced the browser
      // back to the top. Remap the live cache in-place from the user's point
      // of view, then let the host listings below quietly verify it.
      dataRef.current = remapExplorerDataAfterRename(dataRef.current, current.path, result.path)
      if (cwd !== undefined) storeExplorerDataForWorkspace(cwd, dataRef.current)
      setData(dataRef.current)
      setCopiedPath(value => value === null ? null : remapPath(value, current.path, result.path))
      // A second rename/create action may have started while the request was
      // in flight; never clear that newer editor when this response arrives.
      setRenaming(value => value?.path === current.path ? null : value)
      updateFolderMarks(marks => renameFolderMarks(marks, current.path, result.path))
      updateVisibility(
        { kind: 'rename-path', from: current.path, to: result.path },
        value => ({ ...value, paths: renameUncommonPaths(value.paths, current.path, result.path) }),
      )
      onRenamed?.(current.path, result.path)
      // Refresh every visible level in the background. Folder paths are
      // remapped before requesting, so the expanded subtree stays mounted.
      const visible = [...new Set([...(cwd === undefined ? [] : [cwd]), ...expanded]
        .map(path => remapPath(path, current.path, result.path)))]
      for (const dir of visible) {
        api.fsTree({ sessionId, cwd }, dir).then((listing) => {
          storeCurrentLevel(dir, { entries: listing.entries })
        }).catch((error: unknown) => {
          storeCurrentLevel(dir, { error: error instanceof Error ? error.message : String(error) })
        })
      }
    } catch (error) {
      focusedRenamePath.current = null
      setRenaming(value => value?.path === current.path
        ? {
            ...current,
            saving: false,
            error: error instanceof Error ? error.message : String(error),
          }
        : value)
    }
  }

  /** Create one child directory, reveal it, then immediately edit its name. */
  const createFolder = async (parent: string): Promise<void> => {
    try {
      const result = await api.fsMkdir({ sessionId, cwd }, parent)
      const listing = await api.fsTree({ sessionId, cwd }, parent)
      storeCurrentLevel(parent, { entries: listing.entries })
      // The root level is permanently visible; a nested parent must open so
      // the new child row (and its focused editor) can actually be seen.
      if (parent !== cwd && !expanded.includes(parent)) onToggle(parent)
      beginRename(result.path, true)
    } catch (error) {
      storeCurrentLevel(parent, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Create one empty Markdown child, reveal it, then edit only its stem. */
  const createMarkdown = async (parent: string): Promise<void> => {
    try {
      const result = await api.fsCreateMarkdown({ sessionId, cwd }, parent)
      const listing = await api.fsTree({ sessionId, cwd }, parent)
      storeCurrentLevel(parent, { entries: listing.entries })
      if (parent !== cwd && !expanded.includes(parent)) onToggle(parent)
      beginRename(result.path, false)
    } catch (error) {
      storeCurrentLevel(parent, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Ask the Host to reveal one file, folder, or workspace root in Finder. */
  const revealInFinder = async (path: string): Promise<void> => {
    setRevealError(null)
    try {
      await api.fsReveal({ sessionId, cwd }, path)
    } catch (error) {
      setRevealError(t('revealFailed', { message: error instanceof Error ? error.message : String(error) }))
    }
  }

  /** Load safe metadata before offering the irreversible confirmation. */
  const prepareDelete = async (path: string): Promise<void> => {
    try {
      const preview = await api.fsDeletePreview({ sessionId, cwd }, path)
      setDeleting({ preview, busy: false })
    } catch (error) {
      const parent = parentPath(path)
      storeCurrentLevel(parent, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Delete only after the modal's explicit confirmation, then refresh the parent immediately. */
  const confirmDelete = async (): Promise<void> => {
    const current = deleting
    if (current === null || current.busy) return
    setDeleting({ ...current, busy: true, error: undefined })
    try {
      await api.fsDelete({ sessionId, cwd }, current.preview.path)
      const parent = parentPath(current.preview.path)
      const nextData = { ...dataRef.current }
      for (const key of Object.keys(nextData)) {
        if (key === current.preview.path || key.startsWith(`${current.preview.path}/`) || key.startsWith(`${current.preview.path}\\`)) {
          delete nextData[key]
        }
      }
      dataRef.current = nextData
      if (cwd !== undefined) storeExplorerDataForWorkspace(cwd, nextData)
      setData(nextData)
      const listing = await api.fsTree({ sessionId, cwd }, parent)
      storeCurrentLevel(parent, { entries: listing.entries })
      setDeleting(null)
      updateFolderMarks(marks => deleteFolderMarks(marks, current.preview.path))
      updateVisibility(
        { kind: 'delete-path', path: current.preview.path },
        value => ({ ...value, paths: deleteUncommonPaths(value.paths, current.preview.path) }),
      )
      onDeleted?.(current.preview.path)
    } catch (error) {
      setDeleting(value => value?.preview.path === current.preview.path
        ? { ...value, busy: false, error: error instanceof Error ? error.message : String(error) }
        : value)
    }
  }

  const rowName = (entry: FsEntry): ReactNode => {
    const editor = renaming?.path === entry.path ? renaming : null
    if (editor === null) return <span className={css.explorerName}>{entry.name}</span>
    return (
      <span className={css.explorerRenameWrap} onClick={(event) => { event.stopPropagation() }}>
        <input
          ref={renameInput}
          className={clsx(css.explorerRenameInput, editor.error !== undefined && css.explorerRenameInputError)}
          value={editor.stem}
          disabled={editor.saving}
          aria-label={t('renameName')}
          aria-invalid={editor.error !== undefined || undefined}
          title={editor.error}
          onChange={(event) => { setRenaming({ ...editor, stem: event.target.value, error: undefined }) }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') {
              event.preventDefault()
              // One commit path for both Enter and clicking elsewhere.
              event.currentTarget.blur()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setRenaming(null)
            }
          }}
          onBlur={() => { void submitRename() }}
        />
        {editor.suffix !== '' && <span className={css.explorerRenameSuffix}>{editor.suffix}</span>}
        {editor.saving && <span className={css.explorerRenameStatus}>{t('renaming')}</span>}
        {editor.error !== undefined && <span className={css.explorerRenameStatus} title={editor.error}>!</span>}
      </span>
    )
  }

  const clearDropExpand = (): void => {
    if (expandDropTimer.current !== null) window.clearTimeout(expandDropTimer.current)
    expandDropTimer.current = null
    expandDropTarget.current = null
  }

  const clearDragFeedback = (): void => {
    clearDropExpand()
    draggingPathRef.current = null
    setDraggingPath(null)
    setDropTarget(null)
  }

  const canDropInto = (source: string | null, destination: string): source is string =>
    source !== null
    && parentPath(source) !== destination
    && destination !== source
    && !destination.startsWith(`${source}/`)
    && !destination.startsWith(`${source}\\`)

  const scheduleDropExpand = (destination: string): void => {
    if (destination === cwd || expanded.includes(destination) || expandDropTarget.current === destination) return
    clearDropExpand()
    expandDropTarget.current = destination
    expandDropTimer.current = window.setTimeout(() => {
      expandDropTimer.current = null
      expandDropTarget.current = null
      if (draggingPathRef.current !== null && !expanded.includes(destination)) onToggle(destination)
    }, DROP_EXPAND_MS)
  }

  const beginEntryDrag = (event: DragEvent<HTMLDivElement>, path: string): void => {
    const target = event.target as HTMLElement
    if (target.closest('button,input') !== null || renaming?.path === path || movingPath !== null) {
      event.preventDefault()
      return
    }
    draggingPathRef.current = path
    setDraggingPath(path)
    setMoveError(null)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(EXPLORER_ENTRY_MIME, path)
    // Chromium requires at least one broadly-supported type before it starts
    // a native drag; expose only the filename, never the absolute path.
    event.dataTransfer.setData('text/plain', baseName(path))
  }

  const dragOverFolder = (event: DragEvent<HTMLElement>, destination: string): void => {
    const source = draggingPathRef.current
    if (!canDropInto(source, destination)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget(current => current === destination ? current : destination)
    scheduleDropExpand(destination)
  }

  const leaveDropFolder = (event: DragEvent<HTMLElement>, destination: string): void => {
    const related = event.relatedTarget as Node | null
    if (related !== null && event.currentTarget.contains(related)) return
    if (dropTarget === destination) setDropTarget(null)
    if (expandDropTarget.current === destination) clearDropExpand()
  }

  const moveEntry = async (path: string, destination: string): Promise<void> => {
    if (!canDropInto(path, destination) || movingPath !== null) return
    setMovingPath(path)
    setMoveError(null)
    try {
      const result = await api.fsMove({ sessionId, cwd }, path, destination)
      dataRef.current = remapExplorerDataAfterMove(dataRef.current, path, result.path)
      if (cwd !== undefined) storeExplorerDataForWorkspace(cwd, dataRef.current)
      setData(dataRef.current)
      setCopiedPath(value => value === null ? null : remapPath(value, path, result.path))
      setHighlightedPath(value => value === null ? null : remapPath(value, path, result.path))
      setRevealedPath(value => value === null ? null : remapPath(value, path, result.path))
      updateFolderMarks(marks => renameFolderMarks(marks, path, result.path))
      updateVisibility(
        { kind: 'rename-path', from: path, to: result.path },
        value => ({ ...value, paths: renameUncommonPaths(value.paths, path, result.path) }),
      )
      onRenamed?.(path, result.path)
      // Quietly verify both affected directory listings. Updating only these
      // levels preserves the Explorer's scroll position and expansion state.
      for (const dir of new Set([parentPath(path), destination])) {
        api.fsTree({ sessionId, cwd }, dir).then((listing) => {
          storeCurrentLevel(dir, { entries: listing.entries })
        }).catch(() => { /* the normal poll retries transient failures */ })
      }
    } catch (error) {
      setMoveError(t('moveFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setMovingPath(null)
    }
  }

  const dropIntoFolder = (event: DragEvent<HTMLElement>, destination: string): void => {
    const source = draggingPathRef.current
    if (!canDropInto(source, destination)) return
    event.preventDefault()
    event.stopPropagation()
    clearDragFeedback()
    void moveEntry(source, destination)
  }

  const autoScrollWhileDragging = (event: DragEvent<HTMLDivElement>): void => {
    if (draggingPathRef.current === null) return
    const element = event.currentTarget
    const rect = element.getBoundingClientRect()
    const edge = 32
    if (event.clientY < rect.top + edge) element.scrollTop -= 14
    else if (event.clientY > rect.bottom - edge) element.scrollTop += 14
  }

  /** Download a file through the host route (raw bytes, binary-safe). */
  const downloadFile = (path: string): void => {
    const url = downloadUrl({ sessionId, cwd }, path)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  /** A marker click opens the ancestor chain, focuses the row, and opens files. */
  const revealMarkedPath = (mark: FolderMark): void => {
    onRevealPath?.(mark.path, mark.isDir)
    setRevealedPath(mark.path)
    if (!mark.isDir) onOpenFile(mark.path)
  }

  useEffect(() => {
    if (revealedPath === null) return
    const element = rowElements.current.get(revealedPath)
    if (element === undefined) return
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    element.focus({ preventScroll: true })
    setHighlightedPath(revealedPath)
    setRevealedPath(null)
    if (revealTimer.current !== null) window.clearTimeout(revealTimer.current)
    revealTimer.current = window.setTimeout(() => {
      setHighlightedPath(current => current === revealedPath ? null : current)
      revealTimer.current = null
    }, 1200)
  }, [data, expanded, revealedPath])

  const renderLevel = (dir: string, depth: number): ReactNode => {
    const level = data[dir]
    if (level === undefined) {
      return <div className={css.explorerRow} style={{ paddingLeft: depth * 22 + 6 }}>{t('loading')}</div>
    }
    if (level.error !== undefined) {
      return (
        <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: depth * 22 + 6 }}>
          {level.error}
        </div>
      )
    }
    const uncommon = new Set(visibility.paths.map(entry => entry.path))
    const entries = (level.entries ?? []).filter(entry => !visibility.hideUncommon || !uncommon.has(entry.path))
    return entries.map(entry => {
      if (entry.isDir) {
        const isOpen = expanded.includes(entry.path)
        const mark = folderMarks.find(candidate => candidate.path === entry.path)
        return (
          <div key={entry.path}>
            <div
              ref={(element) => {
                if (element === null) rowElements.current.delete(entry.path)
                else rowElements.current.set(entry.path, element)
              }}
              role="button"
              tabIndex={0}
              draggable={renaming?.path !== entry.path && movingPath !== entry.path}
              aria-grabbed={draggingPath === entry.path || undefined}
              aria-expanded={isOpen}
              className={clsx(
                css.explorerRow,
                css.explorerDir,
                entry.hidden && css.explorerHidden,
                draggingPath === entry.path && css.explorerRowDragging,
                movingPath === entry.path && css.explorerRowMoving,
                dropTarget === entry.path && css.explorerDropTarget,
                highlightedPath === entry.path && css.explorerAnchorHighlight,
              )}
              style={{ paddingLeft: depth * 22 + 6 }}
              onClick={() => { onToggle(entry.path) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onToggle(entry.path)
                }
              }}
              onContextMenu={(event) => { openRowMenu(event, entry.path, true) }}
              onDragStart={(event) => { beginEntryDrag(event, entry.path) }}
              onDragEnd={() => { clearDragFeedback() }}
              onDragOver={(event) => { dragOverFolder(event, entry.path) }}
              onDragEnter={(event) => { dragOverFolder(event, entry.path) }}
              onDragLeave={(event) => { leaveDropFolder(event, entry.path) }}
              onDrop={(event) => { dropIntoFolder(event, entry.path) }}
            >
              {mark === undefined
                ? (isOpen ? <IconFolderOpen16 size={14} /> : <IconFolderClose16 size={14} />)
                : <span className={css.explorerFolderMark} aria-hidden="true">{mark.emoji}</span>}
              {rowName(entry)}
              {rowStatus(entry.path)}
            </div>
            {isOpen && renderLevel(entry.path, depth + 1)}
          </div>
        )
      }
      return (
        <div
          key={entry.path}
          ref={(element) => {
            if (element === null) rowElements.current.delete(entry.path)
            else rowElements.current.set(entry.path, element)
          }}
          role="button"
          tabIndex={0}
          draggable={renaming?.path !== entry.path && movingPath !== entry.path}
          aria-grabbed={draggingPath === entry.path || undefined}
          className={clsx(
            css.explorerRow,
            entry.hidden && css.explorerHidden,
            draggingPath === entry.path && css.explorerRowDragging,
            movingPath === entry.path && css.explorerRowMoving,
            highlightedPath === entry.path && css.explorerAnchorHighlight,
          )}
          style={{ paddingLeft: depth * 22 + 6 }}
          title={entry.path}
          onClick={() => { onOpenFile(entry.path) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpenFile(entry.path)
            }
          }}
          onContextMenu={(event) => { openRowMenu(event, entry.path, false) }}
          onDragStart={(event) => { beginEntryDrag(event, entry.path) }}
          onDragEnd={() => { clearDragFeedback() }}
        >
          {(() => {
            const mark = folderMarks.find(candidate => candidate.path === entry.path)
            return mark === undefined
              ? fileIcon(entry.name)
              : <span className={css.explorerFolderMark} aria-hidden="true">{mark.emoji}</span>
          })()}
          {rowName(entry)}
          {rowStatus(entry.path)}
        </div>
      )
    })
  }

  return (
    <div className={css.explorer}>
      <div
        className={clsx(
          css.explorerHeader,
          root !== undefined && draggingPath !== null && parentPath(draggingPath) !== root && css.explorerRootDropReady,
          root !== undefined && dropTarget === root && css.explorerRootDropTarget,
        )}
        onDragOver={root === undefined ? undefined : (event) => { dragOverFolder(event, root) }}
        onDragEnter={root === undefined ? undefined : (event) => { dragOverFolder(event, root) }}
        onDragLeave={root === undefined ? undefined : (event) => { leaveDropFolder(event, root) }}
        onDrop={root === undefined ? undefined : (event) => { dropIntoFolder(event, root) }}
        onContextMenu={root === undefined ? undefined : (event) => { openRowMenu(event, root, true) }}
      >
        <div className={css.explorerMarks} role="toolbar" aria-label={t('folderMarks')}>
          {folderMarks.length === 0
            ? <span className={css.explorerProjectName} title={root}>{root === undefined ? t('noSession') : baseName(root)}</span>
            : folderMarks.map(mark => (
                <button
                  key={mark.emoji}
                  type="button"
                  className={css.explorerMarkButton}
                  title={baseName(mark.path)}
                  aria-label={t('openFolderMark', { name: baseName(mark.path) })}
                  onClick={(event) => {
                    event.stopPropagation()
                    revealMarkedPath(mark)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setRowMenu(null)
                    setMarkMenu({ emoji: mark.emoji, x: event.clientX, y: event.clientY })
                  }}
                >
                  {mark.emoji}
                </button>
              ))}
        </div>
        <Tooltip label={t('toggleUncommonVisibility')} side="bottom" delayMs={400}>
          <button
            type="button"
            disabled={!visibilityReady}
            className={clsx(css.explorerVisibilityToggle, visibility.hideUncommon && css.explorerVisibilityToggleActive)}
            aria-label={t('toggleUncommonVisibility')}
            aria-pressed={visibility.hideUncommon}
            onClick={(event) => {
              event.stopPropagation()
              const hidden = !visibilityRef.current.hideUncommon
              updateVisibility(
                { kind: 'set-hidden', hidden },
                value => ({ ...value, hideUncommon: hidden }),
              )
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <IconEyeOutline16 size={15} />
          </button>
        </Tooltip>
        <Tooltip label={t('collapseAllFolders')} side="bottom" delayMs={400}>
          <button
            type="button"
            className={css.explorerCollapseAll}
            aria-label={t('collapseAllFolders')}
            aria-disabled={expanded.length === 0}
            onClick={(event) => {
              event.stopPropagation()
              if (expanded.length > 0) onCollapseAll?.()
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <IconFolderClose16 size={15} />
          </button>
        </Tooltip>
      </div>
      {moveError !== null && <div className={css.explorerMoveError} role="alert">{moveError}</div>}
      {revealError !== null && <div className={css.explorerMoveError} role="alert">{revealError}</div>}
      <div
        ref={explorerBody}
        className={css.explorerBody}
        onDragOver={autoScrollWhileDragging}
        onScroll={(event) => {
          // `overflow-x: hidden` blocks gestures but still permits focus-driven
          // programmatic scrolling. Keep the only valid horizontal origin at 0.
          if (event.currentTarget.scrollLeft !== 0) event.currentTarget.scrollLeft = 0
        }}
      >
        {root === undefined ? (
          <div className={css.explorerEmpty}>{t('noSession')}</div>
        ) : (
          visibilityReady && data[root] !== undefined && renderLevel(root, 0)
        )}
      </div>
      {/*
        The one shared context menu, positioned at the right-click cursor
        (portal so the explorer's overflow clip cannot crop it).
      */}
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={[
          ...(rowMenu !== null && rowMenu.path !== root
            ? [
                {
                  id: 'folder-marks',
                  label: (
                    <div className={css.explorerMarkPalette} aria-label={t('chooseFolderMark')}>
                      {FOLDER_MARK_EMOJIS.map((emoji) => {
                        const selected = folderMarks.some(mark => mark.path === rowMenu.path && mark.emoji === emoji)
                        const occupied = folderMarks.some(mark => mark.path !== rowMenu.path && mark.emoji === emoji)
                        return (
                          <button
                            key={emoji}
                            type="button"
                            className={clsx(
                              css.explorerMarkChoice,
                              selected && css.explorerMarkChoiceSelected,
                              occupied && css.explorerMarkChoiceDisabled,
                            )}
                            aria-label={t('setFolderMark', { emoji })}
                            aria-pressed={selected}
                            disabled={occupied}
                            onClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              updateFolderMarks(marks => toggleFolderMark(marks, rowMenu.path, rowMenu.isDir, emoji as FolderMarkEmoji))
                              setRowMenu(null)
                            }}
                          >
                            <span aria-hidden="true">{emoji}</span>
                            {selected && <span className={css.explorerMarkCheck} aria-hidden="true">✓</span>}
                          </button>
                        )
                      })}
                    </div>
                  ),
                },
                { type: 'separator' as const, id: 'folder-marks-separator' },
                {
                  id: 'toggle-uncommon',
                  label: visibility.paths.some(entry => entry.path === rowMenu.path)
                    ? t('unmarkUncommon')
                    : t('markUncommon'),
                  icon: <IconEyeOutline16 size={14} />,
                },
                { type: 'separator' as const, id: 'uncommon-separator' },
              ]
            : []),
          { id: 'reveal-finder', label: t('revealInFinder'), icon: <IconFolderOpenOutline16 size={14} /> },
          ...(rowMenu?.isDir === false
            ? [{ id: 'open', label: t('openEditor'), icon: <IconCodeOutline16 size={14} /> }]
            : []),
          ...(rowMenu?.isDir === false && isHtmlFilePath(rowMenu.path) && onOpenInBrowser !== undefined
            ? [{ id: 'open-browser', label: t('openInBuiltInBrowser'), icon: <IconGlobeOutline16 size={14} /> }]
            : []),
          ...(rowMenu?.isDir === true
            ? [
                { id: 'new-folder', label: t('newFolder'), icon: <IconProjectAddOutline16 size={14} /> },
                { id: 'new-markdown', label: t('newMarkdown'), icon: <IconMarkdownOutline16 size={14} /> },
              ]
            : []),
          ...(rowMenu !== null && rowMenu.path !== root
            ? [{ id: 'rename', label: t('rename'), icon: <IconEditOutline16 size={14} /> }]
            : []),
          // Download applies to files only (the host route refuses directories).
          ...(rowMenu?.isDir === false
            ? [{ id: 'download', label: t('download'), icon: <IconDownloadOutline16 size={14} /> }]
            : []),
          { id: 'reference', label: t('reference'), icon: <IconLinkOutline16 size={14} /> },
          { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={14} /> },
          { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> },
          // Destructive action is intentionally always the absolute last row.
          ...(rowMenu !== null && rowMenu.path !== root
            ? [{ id: 'delete', label: t('delete'), icon: <IconTrashOutline16 size={14} />, danger: true }]
            : []),
        ]}
        onSelect={(id) => {
          const target = rowMenu
          if (target === null) return
          if (id === 'folder-marks') return
          setRowMenu(null)
          if (id === 'toggle-uncommon') {
            updateVisibility(
              { kind: 'toggle-path', path: target.path, isDir: target.isDir },
              value => ({
                ...value,
                paths: toggleUncommonPath(value.paths, target.path, target.isDir),
              }),
            )
            return
          }
          if (id === 'open-browser') {
            onOpenInBrowser?.(target.path)
            return
          }
          if (id === 'open') {
            onOpenFile(target.path)
            return
          }
          if (id === 'reveal-finder') {
            void revealInFinder(target.path)
            return
          }
          if (id === 'rename') {
            beginRename(target.path, target.isDir)
            return
          }
          if (id === 'new-folder') {
            void createFolder(target.path)
            return
          }
          if (id === 'new-markdown') {
            void createMarkdown(target.path)
            return
          }
          if (id === 'reference') {
            onReferenceFile(target.path, target.isDir)
            return
          }
          if (id === 'download') {
            downloadFile(target.path)
            return
          }
          if (id === 'delete') {
            void prepareDelete(target.path)
            return
          }
          copyPath(
            id === 'relative' ? relativeTo(cwd ?? '', target.path) : target.path,
            target.path,
          )
        }}
        portal
        align="start"
        getAnchorRect={() => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0))}
        anchor={<span />}
      />
      <Menu
        open={markMenu !== null}
        onClose={() => { setMarkMenu(null) }}
        items={[{ id: 'delete-mark', label: t('delete'), icon: <IconTrashOutline16 size={14} />, danger: true }]}
        onSelect={(id) => {
          const target = markMenu
          setMarkMenu(null)
          if (id === 'delete-mark' && target !== null) {
            updateFolderMarks(marks => marks.filter(mark => mark.emoji !== target.emoji))
          }
        }}
        portal
        align="start"
        getAnchorRect={() => (markMenu === null ? null : new DOMRect(markMenu.x, markMenu.y, 0, 0))}
        anchor={<span />}
      />
      <Modal
        open={deleting !== null}
        onClose={() => { if (deleting?.busy !== true) setDeleting(null) }}
        title={deleting?.preview.kind === 'folder' ? t('deleteFolderTitle') : t('deleteFileTitle')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" disabled={deleting?.busy} onClick={() => { setDeleting(null) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={deleting?.busy} onClick={() => { void confirmDelete() }}>{t('confirm')}</Button>
          </>
        )}
      >
        {deleting !== null && (
          <div className={css.explorerDeleteBody}>
            <p className={css.explorerDeleteQuestion}>{t('deleteQuestion').replace('{name}', deleting.preview.name)}</p>
            <dl className={css.explorerDeleteMeta}>
              <div><dt>{t('deleteType')}</dt><dd>{deleting.preview.kind === 'folder' ? t('folder') : t('file')}</dd></div>
              <div><dt>{t('deleteSize')}</dt><dd>{formatSize(deleting.preview.size)}</dd></div>
            </dl>
            {deleting.error !== undefined && <p className={css.explorerDeleteError}>{deleting.error}</p>}
          </div>
        )}
      </Modal>
    </div>
  )
}
