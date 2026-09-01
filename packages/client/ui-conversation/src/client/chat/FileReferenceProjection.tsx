import type { ReactNode } from 'react'
import css from './MessageItem.module.css'

export interface FileReferenceProjection {
  readonly path: string
  readonly name: string
  readonly kind: 'file' | 'folder'
  readonly mode: 'path' | 'lines'
  readonly start?: number
  readonly end?: number
  readonly status?: string
}

export type FileReferenceRun =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reference'; readonly reference: FileReferenceProjection }

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function tagEnd(text: string, start: number): number {
  let quote = ''
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '>') return index + 1
  }
  return -1
}

function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>()
  const pattern = /([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(tag)) !== null) {
    attributes.set(match[1] ?? '', decodeXmlAttribute(match[2] ?? match[3] ?? ''))
  }
  return attributes
}

function closingTagEnd(text: string, start: number): number {
  let cursor = start
  while (cursor < text.length) {
    const next = text.indexOf('<', cursor)
    if (next < 0) return -1
    if (text.startsWith('<![CDATA[', next)) {
      const cdataEnd = text.indexOf(']]>', next + 9)
      if (cdataEnd < 0) return -1
      cursor = cdataEnd + 3
      continue
    }
    const close = /^<\/file-reference\s*>/.exec(text.slice(next))
    if (close !== null) return next + close[0].length
    cursor = next + 1
  }
  return -1
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const number = Number.parseInt(value, 10)
  return number > 0 ? number : undefined
}

function projectionOf(openingTag: string): FileReferenceProjection | null {
  const attributes = attributesOf(openingTag)
  const path = attributes.get('path')
  if (path === undefined || path === '') return null
  const start = positiveInteger(attributes.get('start'))
  const end = positiveInteger(attributes.get('end')) ?? start
  const mode = attributes.get('mode') === 'lines' || start !== undefined ? 'lines' : 'path'
  const kind = mode === 'lines' ? 'file' : attributes.get('kind') === 'folder' ? 'folder' : 'file'
  const pieces = path.split(/[\\/]/)
  const status = attributes.get('status')
  return {
    path,
    name: pieces[pieces.length - 1] || path,
    kind,
    mode,
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(status !== undefined ? { status } : {}),
  }
}

/**
 * Split logged model-facing text into ordinary text and file-reference spans.
 * Malformed tags remain ordinary text; no transcript content is discarded
 * unless a complete, path-bearing reference container is recognized.
 */
export function parseFileReferenceRuns(text: string): FileReferenceRun[] {
  const runs: FileReferenceRun[] = []
  let cursor = 0
  let search = 0
  while (search < text.length) {
    const start = text.indexOf('<file-reference', search)
    if (start < 0) break
    const boundary = text[start + '<file-reference'.length]
    if (boundary !== undefined && !/[\s/>]/.test(boundary)) {
      search = start + '<file-reference'.length
      continue
    }
    const openingEnd = tagEnd(text, start)
    if (openingEnd < 0) break
    const openingTag = text.slice(start, openingEnd)
    const reference = projectionOf(openingTag)
    if (reference === null) {
      search = openingEnd
      continue
    }
    const selfClosing = /\/\s*>$/.test(openingTag)
    const end = selfClosing ? openingEnd : closingTagEnd(text, openingEnd)
    if (end < 0) break
    if (start > cursor) runs.push({ kind: 'text', text: text.slice(cursor, start) })
    runs.push({ kind: 'reference', reference })
    cursor = end
    search = end
  }
  if (cursor < text.length) runs.push({ kind: 'text', text: text.slice(cursor) })
  if (runs.length === 0 && text !== '') runs.push({ kind: 'text', text })
  return runs
}

function FileIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3 1.75h6l4 4v8.5H3zM9 1.75v4h4" />
    </svg>
  )
}

function FolderIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M1.75 4.25h4l1.2 1.5h7.3v6.5h-12.5zM1.75 4.25v-1.5h4l1.2 1.5" />
    </svg>
  )
}

export function FileReferenceChip({ reference }: { reference: FileReferenceProjection }): ReactNode {
  const range = reference.start === undefined
    ? null
    : reference.start === reference.end
      ? String(reference.start)
      : `${reference.start}–${reference.end}`
  return (
    <span
      className={css.fileReferenceChip}
      data-file-reference-chip={reference.mode}
      data-file-reference-kind={reference.kind}
      data-file-reference-status={reference.status}
      title={reference.path}
      aria-label={`文件引用：${reference.name}${range === null ? '' : `，第 ${range} 行`}`}
    >
      <span className={css.fileReferenceLead} data-file-reference-lead={range === null ? 'icon' : 'lines'}>
        {range ?? (reference.kind === 'folder' ? <FolderIcon /> : <FileIcon />)}
      </span>
      <span className={css.fileReferenceName}>{reference.name}</span>
    </span>
  )
}
