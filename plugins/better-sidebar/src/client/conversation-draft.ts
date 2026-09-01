/**
 * Append text to the current session's composer draft through the
 * conversation service — the shared path behind legacy text insertion and
 * the viewer selection popup. The service is resolved lazily
 * through `ctx.get` (the inject-free read the app's own plugins use); a
 * missing service or scope degrades to a logged no-op, never a crash.
 */
import type { Context, SidebarConversation } from '../context-types.ts'

interface InlineFileReferenceBridge {
  (selection: {
    path: string
    displayName?: string
    kind?: 'file' | 'folder'
    startLine: number
    endLine: number
  }): void
}

/** Insert a file/folder path through dsh-file-edit's occurrence-backed inline
 * reference pipeline. Unlike appending `@path` text, this does not activate
 * dsh-at-file's separate attachment dock. */
export function insertInlineFileReference(path: string, displayName?: string, kind: 'file' | 'folder' = 'file'): boolean {
  try {
    const bridge = (window as typeof window & { __dshFileRef?: InlineFileReferenceBridge }).__dshFileRef
    if (typeof bridge !== 'function') {
      console.warn('[dsh-better-sidebar] inline file-reference bridge unavailable')
      return false
    }
    bridge({ path, displayName, kind, startLine: 0, endLine: 0 })
    return true
  } catch (error) {
    console.warn('[dsh-better-sidebar] inline file-reference insert failed:', error)
    return false
  }
}

/**
 * Append `text` to the session's composer draft (space-separated, like the
 * @-mentions). Returns false — and logs — when the conversation service or
 * the session scope is unavailable.
 */
export function appendToDraft(ctx: Context, sessionId: string, text: string): boolean {
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) return false
    const conversation = ctx.get('conversation') as SidebarConversation | undefined
    if (conversation === undefined) return false
    const input = conversation.input.for(actx)
    const draft = input.state.getSnapshot().draft
    input.setDraft(draft.trim() === '' ? text : `${draft} ${text}`)
    return true
  } catch (error) {
    console.warn('[dsh-better-sidebar] draft insert failed:', error)
    return false
  }
}
