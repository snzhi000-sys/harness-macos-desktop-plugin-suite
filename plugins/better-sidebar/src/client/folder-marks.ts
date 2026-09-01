/** The six fixed Explorer entry markers. One emoji is one unambiguous anchor slot. */
export const FOLDER_MARK_EMOJIS = ['🍿', '🍔', '🍟', '🍄', '🚗', '🍎'] as const

export type FolderMarkEmoji = typeof FOLDER_MARK_EMOJIS[number]

export interface FolderMark {
  path: string
  emoji: FolderMarkEmoji
  isDir: boolean
}

export const FOLDER_MARKS_STORAGE_PREFIX = 'dsh-explorer-folder-marks:v1'
export const FOLDER_MARKS_EVENT = 'dsh-explorer-folder-marks-change'

/** One workspace owns one marker cache; the Host file is the durable authority. */
export function folderMarksStorageKey(root: string): string {
  return `${FOLDER_MARKS_STORAGE_PREFIX}:${encodeURIComponent(root)}`
}

function belongsToPath(value: string, path: string): boolean {
  return value === path || value.startsWith(`${path}/`) || value.startsWith(`${path}\\`)
}

function replacePathPrefix(value: string, from: string, to: string): string {
  return belongsToPath(value, from) ? `${to}${value.slice(from.length)}` : value
}

/** Map the retired first/last symbols onto their direct replacements. */
function migrateEmoji(value: unknown): FolderMarkEmoji | undefined {
  if (value === '🌟') return '🍿'
  if (value === '📌') return '🍎'
  return FOLDER_MARK_EMOJIS.includes(value as FolderMarkEmoji) ? value as FolderMarkEmoji : undefined
}

/** Validate persisted data and enforce one path + one anchor per emoji. */
export function sanitizeFolderMarks(value: unknown): FolderMark[] {
  if (!Array.isArray(value)) return []
  const byEmoji = new Map<FolderMarkEmoji, FolderMark>()
  const usedPaths = new Set<string>()
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== 'object') continue
    const record = candidate as Record<string, unknown>
    if (typeof record.path !== 'string' || record.path === '') continue
    const emoji = migrateEmoji(record.emoji)
    if (emoji === undefined) continue
    if (byEmoji.has(emoji) || usedPaths.has(record.path)) continue
    // v1 originally supported directories only and had no kind field.
    const mark = { path: record.path, emoji, isDir: record.isDir !== false }
    byEmoji.set(emoji, mark)
    usedPaths.add(record.path)
  }
  return FOLDER_MARK_EMOJIS.flatMap(emoji => byEmoji.get(emoji) ?? [])
}

/**
 * Toggle one marker. Selecting a different free emoji replaces the path's old
 * marker; an emoji owned by another path is locked until that mark is removed.
 */
export function toggleFolderMark(
  marks: readonly FolderMark[],
  path: string,
  isDir: boolean,
  emoji: FolderMarkEmoji,
): FolderMark[] {
  const current = marks.find(mark => mark.path === path)
  if (current?.emoji === emoji) return marks.filter(mark => mark.path !== path)
  if (marks.some(mark => mark.emoji === emoji && mark.path !== path)) return [...marks]
  return sanitizeFolderMarks([
    ...marks.filter(mark => mark.path !== path),
    { path, emoji, isDir },
  ])
}

/** Keep marked folders coherent when a folder or one of its ancestors is renamed. */
export function renameFolderMarks(marks: readonly FolderMark[], from: string, to: string): FolderMark[] {
  if (from === to) return [...marks]
  return sanitizeFolderMarks(marks.map(mark => ({ ...mark, path: replacePathPrefix(mark.path, from, to) })))
}

/** Remove a deleted marked folder and every marked descendant below it. */
export function deleteFolderMarks(marks: readonly FolderMark[], path: string): FolderMark[] {
  return marks.filter(mark => !belongsToPath(mark.path, path))
}

export function loadFolderMarks(root: string): FolderMark[] {
  try {
    const raw = localStorage.getItem(folderMarksStorageKey(root))
    return raw === null ? [] : sanitizeFolderMarks(JSON.parse(raw) as unknown)
  } catch {
    return []
  }
}

export function saveFolderMarks(root: string, marks: readonly FolderMark[]): FolderMark[] {
  const clean = sanitizeFolderMarks(marks)
  try {
    localStorage.setItem(folderMarksStorageKey(root), JSON.stringify(clean))
  } catch {
    // Storage is best-effort; the caller still keeps the in-memory marks.
  }
  return clean
}
