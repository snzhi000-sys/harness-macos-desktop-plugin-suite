import { basicSetup } from 'codemirror'
import { EditorState, Compartment, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { sql } from '@codemirror/lang-sql'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { rust } from '@codemirror/lang-rust'
import { php } from '@codemirror/lang-php'
import { yaml } from '@codemirror/lang-yaml'
import { go } from '@codemirror/legacy-modes/mode/go'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { r as rLanguage } from '@codemirror/legacy-modes/mode/r'
import { browserReferenceTextMeasurer, referenceChipWidthEm } from './reference-width.js'
import {
  decodeFileReference, encodeFileReference, fileReferenceClipboardText, fileReferenceTag,
} from './reference-protocol.js'
import { closeProcessedTabState } from './file-tab-state.js'
import { clearDeletedTabState, markDeletedTabState } from './deleted-tab-state.js'

// dsh-file-edit — static client bundle (web plugin).
// Loaded by the client module system as a classic script; registers a factory
// via window.__ModuleLoader__.load. The factory body runs at materialization;
// require('react') resolves through the shell's static module table.
// RPC to the host plugin goes through fetch('/dsh-file-edit/api').
window.__ModuleLoader__.load({
  id: 'dsh-file-edit',
  factory: (require) => {
    const React = require('react')

    // v1.9.3: optional timeout — the instant-refresh watcher passes it so a
    // wedged long-poll fetch (one that never settles in this environment)
    // cannot freeze the wait loop forever; the abort turns the wedge into a
    // normal { ok:false } and the watcher backs off and retries.
    const call = async (method, args, timeoutMs) => {
      let abort = null
      try {
        const init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: method, args: args || {} }),
        }
        if (timeoutMs) {
          const ctl = new AbortController()
          init.signal = ctl.signal
          abort = setTimeout(() => { try { ctl.abort() } catch (e) {} }, timeoutMs)
        }
        const r = await fetch('/dsh-file-edit/api', init)
        const data = await r.json()
        return data && typeof data === 'object' ? data : { ok: true }
      } catch (e) {
        return { ok: false, error: e && e.message ? String(e.message) : String(e) }
      } finally {
        if (abort) clearTimeout(abort)
      }
    }

    return {
      inject: ['slots', 'timer', 'sessions', 'workspaces', 'conversation'],
      apply(ctx) {
        // Harness runtime serializes non-critical startup I/O after the first
        // paint. Older runtimes keep the previous immediate behavior.
        const startupTasks = ctx.get('startupTasks')
        const scheduleStartupTask = (task, signal) => {
          if (signal && signal.aborted) return Promise.resolve()
          return startupTasks && typeof startupTasks.schedule === 'function'
            ? startupTasks.schedule(task, signal)
            : Promise.resolve().then(task)
        }
        // Activate the Files view through ui-conversation's session-scoped
        // controller. This also works before an empty Session has rendered
        // header tabs, unlike the old DOM button scan.
        const activateFilesView = (sid) => {
          if (!sid) return false
          try {
            const scoped = ctx.sessions.scope(sid)
            const conversation = scoped && scoped.get('conversation')
            if (!conversation || typeof conversation.activateView !== 'function') return false
            conversation.activateView('dsh-file-edit')
            return true
          } catch (e) {}
          return false
        }
        // [文件引用] 注册 @ 引用 source：行级(@path:a-b) 与文件级(@path) 统一 codec。
        // Command+U 不走 @ 菜单（candidates/onPick 空实现），插入由 window.__dshFileRef 触发。
        const inputTriggers = ctx.get('inputTriggers')
        if (inputTriggers) {
          const fileRefCodec = {
            clipboardText(ref) { return fileReferenceClipboardText(ref) },
            serialize(ref, signal) {
              const decoded = decodeFileReference(ref)
              const p = decoded.path
              const a = decoded.start
              const b = decoded.end
              if (a > 0) {
                // 行级引用：host 读行内容，带行号注入给模型
                const sid = store.sessionId
                return call('readLines', { sessionId: sid, path: p, start: a, end: b }).then((r) => {
                  if (r && r.ok && typeof r.content === 'string') {
                    const actualStart = Number.isInteger(r.start) ? r.start : a
                    const actualEnd = Number.isInteger(r.end) ? r.end : b
                    const numbered = r.content.split('\n').map((ln, i) => (actualStart + i) + '| ' + ln).join('\n')
                    return fileReferenceTag(decoded, {
                      start: actualStart, end: actualEnd, numbered: numbered, status: 'ok',
                    })
                  }
                  const status = r && r.error === 'line-range-out-of-range'
                    ? 'line-range-out-of-range'
                    : 'read-error'
                  return fileReferenceTag(decoded, { status: status })
                }).catch(() => fileReferenceTag(decoded, { status: 'read-error' }))
              }
              return Promise.resolve(fileReferenceTag(decoded))
            },
          }
          ctx.effect(() => inputTriggers.registerSource({
            trigger: '@',
            name: 'dsh-file-edit-ref',
            codec: fileRefCodec,
            candidates: async () => [],
            onPick: () => undefined,
          }), 'dsh-file-edit: file-ref source')
        }
        // [文件引用] Command+U 钩子：DiffPane 选中行 → 构造引用并插入输入框。
        // 插入（块3）通过 slash/input-insert-reference bail 事件实现；此处先落骨架。
        const referenceFileName = (path) => String(path || '').split(/[\\/]/).pop() || String(path || '')
        const fileReferenceInsert = (ref, kind, displayName) => {
          const decoded = decodeFileReference(ref, kind)
          const path = decoded.path
          const start = decoded.start
          const end = decoded.end
          const rows = start > 0 ? (start === end ? String(start) : start + '-' + end) : ''
          const name = displayName ? String(displayName) : referenceFileName(path)
          const label = rows ? (rows + ' · ' + name) : ((decoded.kind === 'folder' ? '📁 ' : '📄 ') + name)
          const textarea = document.querySelector('textarea[data-phase]')
          const measureText = browserReferenceTextMeasurer(textarea)
          const composerFontSizePx = textarea ? Number.parseFloat(getComputedStyle(textarea).fontSize) : 16
          const chipWidthEm = referenceChipWidthEm({ name, line: rows, measureText, composerFontSizePx })
          const encodedRef = encodeFileReference(decoded, decoded.kind)
          return {
            source: 'dsh-file-edit-ref', ref: encodedRef, label: label, chipWidthEm: chipWidthEm,
            clipboardText: fileReferenceClipboardText(encodedRef),
          }
        }
        let pendingInlineCaret = null
        let getInlineSelection = () => null
        let refreshInlineEditor = () => {}
        const insertFileReference = (insert, selection) => {
          if (!insert || !insert.ref) return false
          const sid = store.sessionId
          if (!sid) return false
          const actx = ctx.sessions.scope(sid)
          if (!actx) return false
          const conversation = actx.get('conversation')
          if (!conversation || !conversation.input) return false
          const input = conversation.input.for(actx)
          if (!input || !input.state) return false
          // draftRev：span CAS 要求与当前 revision 一致
          let draftRev = 0
          try {
            const snap = input.state.getSnapshot()
            if (snap) draftRev = snap.draftRev
          } catch (e) {
            console.warn('[dsh-file-edit] 读 draftRev 失败:', e)
          }
          // 光标：composer textarea 的 selectionStart（失焦后仍保留上次位置）
          let cursor = 0
          let selectionEnd = 0
          try {
            const ta = document.querySelector('textarea[data-phase]')
            const inline = getInlineSelection()
            if (selection && Number.isInteger(selection.start) && Number.isInteger(selection.end)) {
              cursor = selection.start
              selectionEnd = selection.end
            } else if (inline) {
              cursor = inline.start
              selectionEnd = inline.end
            } else if (ta && ta.selectionStart != null) {
              cursor = ta.selectionStart || 0
              selectionEnd = ta.selectionEnd == null ? cursor : ta.selectionEnd
            }
          } catch (e) {}
          // A chip removal shortens the draft asynchronously.  Do not let a
          // cached pre-removal selection produce an out-of-bounds CAS span,
          // otherwise insertReference silently refuses every later Explorer
          // or Command+U insertion.
          let draftLength = 0
          try {
            const latest = input.state.getSnapshot()
            draftLength = latest && typeof latest.draft === 'string' ? latest.draft.length : 0
          } catch (e) {}
          cursor = Math.max(0, Math.min(cursor, draftLength))
          selectionEnd = Math.max(cursor, Math.min(selectionEnd, draftLength))
          const span = { start: cursor, end: selectionEnd, draftRev: draftRev }
          try {
            pendingInlineCaret = cursor + 2
            const applied = input.insertReference(insert, span)
            if (!applied) { pendingInlineCaret = null; return false }
            requestAnimationFrame(() => refreshInlineEditor())
            return true
          } catch (e) {
            console.warn('[dsh-file-edit] 插入引用失败:', e)
            return false
          }
        }
        if (typeof window !== 'undefined') {
          try {
            window.__dshFileRef = (sel) => {
              if (!sel || !sel.path) return
              const start = sel.startLine > 0 ? sel.startLine : 0
              const end = sel.endLine > 0 ? sel.endLine : start
              const ref = (start > 0 && end >= start) ? (sel.path + ':' + start + '-' + end) : sel.path
              const insert = fileReferenceInsert(ref, sel.kind, start === 0 ? sel.displayName : undefined)
              insertFileReference(insert)
            }
          } catch (e) {}
        }
        // [文件引用] 移除引用：setDraft 删除 occurrence 对应的 0xFFFC 占位符（及其后自动补的空格）
        const removeFileReference = (occurrenceId) => {
          if (occurrenceId == null) return false
          const sid = store.sessionId
          if (!sid) return false
          const actx = ctx.sessions.scope(sid)
          if (!actx) return false
          const conversation = actx.get('conversation')
          if (!conversation || !conversation.input) return false
          const input = conversation.input.for(actx)
          if (!input || !input.state) return false
          let snap = null
          try { snap = input.state.getSnapshot() } catch (e) { return false }
          if (!snap || !snap.occurrences) return false
          const occ = snap.occurrences.find((o) => String(o.occurrenceId) === String(occurrenceId) && o.source === 'dsh-file-edit-ref')
          if (!occ) return false
          const draft = snap.draft
          const start = occ.offset
          let end = occ.offset + 1
          if (draft[end] === ' ') end = end + 1
          const next = draft.slice(0, start) + draft.slice(end)
          try {
            // Multiple references are represented by the same U+FFFC byte.
            // A plain setDraft(next) makes the host's prefix/suffix diff see
            // deletion of the *last* identical placeholder.  Supplying the
            // exact old-draft edit range keeps occurrence identity aligned
            // with the chip the user actually removed.
            pendingInlineCaret = start
            input.setDraft(next, { start: start, end: end, insertedLength: 0 })
            return true
          } catch (e) {
            console.warn('[dsh-file-edit] 移除引用失败:', e)
            return false
          }
        }
        // ctx.effect() may run synchronously while it is registered.  Keep a
        // stable store object available before the chip effect reads it; the
        // remaining fields and methods are assigned immediately afterwards.
        const store = { sessionId: null }
        // [文件引用] 真正的行内编辑层：文字是文本节点，引用是独立的
        // contenteditable=false 节点。底层 draft 仍只保存一个 U+FFFC
        // occurrence，发送继续使用 DSH 原生 serialize 管道。
        //
        // The Harness composer now owns a single-editor occurrence backdrop:
        // the textarea remains the only editing surface while chips are paint
        // decorations over its U+FFFC cells. Prefer that architecture so
        // references do not switch the user into a second contenteditable
        // implementation with separate selection, IME, newline, undo and
        // scrolling state. Keep the legacy branch below as a temporary
        // compatibility fallback for older runtimes that lack the backdrop.
        const NATIVE_REFERENCE_COMPOSER = true
        ctx.effect(() => {
          if (NATIVE_REFERENCE_COMPOSER) {
            let restoreFrame = null
            let chipTimer = null
            let chipObserver = null
            const FILE_REF_CLIPBOARD_MIME = 'application/x-dsh-file-edit-references+json'
            const composerTextarea = () => document.querySelector('textarea[data-phase]')
            const nativeSessionInput = () => {
              const sid = store.sessionId
              if (!sid) return null
              try {
                const actx = ctx.sessions.scope(sid)
                const conversation = actx && actx.get('conversation')
                return conversation && conversation.input && conversation.input.for(actx)
              } catch (e) { return null }
            }
            const textareaSelection = () => {
              const ta = composerTextarea()
              if (!ta || ta.selectionStart == null) return null
              return {
                start: ta.selectionStart || 0,
                end: ta.selectionEnd == null ? (ta.selectionStart || 0) : ta.selectionEnd,
              }
            }
            getInlineSelection = textareaSelection
            refreshInlineEditor = () => {
              if (pendingInlineCaret == null) return
              const caret = pendingInlineCaret
              pendingInlineCaret = null
              if (restoreFrame != null) cancelAnimationFrame(restoreFrame)
              restoreFrame = requestAnimationFrame(() => {
                restoreFrame = null
                const ta = composerTextarea()
                if (!ta) return
                const at = Math.max(0, Math.min(caret, ta.value.length))
                ta.focus({ preventScroll: true })
                ta.setSelectionRange(at, at)
                // Programmatic selection does not make the shared composer
                // scrollport reveal the caret. Reference insertion normally
                // lands at the end; reveal that deterministic case here and
                // leave an inline insertion at its already-visible position.
                if (at === ta.value.length) {
                  const scroll = ta.closest('[data-input-scroll]')
                  if (scroll) scroll.scrollTop = scroll.scrollHeight
                }
              })
            }
            const structuredClipboard = (start, end, snap) => {
              const refs = new Map((snap.occurrences || [])
                .filter((o) => o.source === 'dsh-file-edit-ref')
                .map((o) => [o.offset, o]))
              const segments = []
              let text = ''
              const flushText = () => {
                if (!text) return
                segments.push({ type: 'text', value: text })
                text = ''
              }
              for (let i = start; i < end; i++) {
                const occ = refs.get(i)
                if (!occ) { text += snap.draft[i] || ''; continue }
                flushText()
                segments.push({
                  type: 'reference',
                  ref: occ.ref,
                  kind: String(occ.label || '').startsWith('📁 ') ? 'folder' : 'file',
                })
                if (i + 1 < end && snap.draft[i + 1] === ' ') i += 1
              }
              flushText()
              return segments.some((part) => part.type === 'reference')
                ? JSON.stringify({ version: 1, segments: segments })
                : null
            }
            const parseStructuredClipboard = (data) => {
              if (!data) return null
              try {
                const payload = JSON.parse(data)
                if (!payload || payload.version !== 1 || !Array.isArray(payload.segments)) return null
                const segments = payload.segments.filter((part) => part && (
                  (part.type === 'text' && typeof part.value === 'string') ||
                  (part.type === 'reference' && typeof part.ref === 'string' && part.ref
                    && (part.kind === undefined || part.kind === 'file' || part.kind === 'folder'))
                ))
                return segments.some((part) => part.type === 'reference') ? segments : null
              } catch (e) { return null }
            }
            const onNativeCopy = (ev) => {
              const ta = ev.target && ev.target.closest ? ev.target.closest('textarea[data-phase]') : null
              if (!ta || !ev.clipboardData) return
              const input = nativeSessionInput()
              const snap = input && input.state && input.state.getSnapshot()
              if (!snap) return
              const start = ta.selectionStart || 0
              const end = ta.selectionEnd == null ? start : ta.selectionEnd
              const structured = structuredClipboard(start, end, snap)
              if (structured) ev.clipboardData.setData(FILE_REF_CLIPBOARD_MIME, structured)
            }
            const onNativePaste = (ev) => {
              const ta = ev.target && ev.target.closest ? ev.target.closest('textarea[data-phase]') : null
              if (!ta || !ev.clipboardData) return
              const segments = parseStructuredClipboard(ev.clipboardData.getData(FILE_REF_CLIPBOARD_MIME))
              if (!segments) return
              const input = nativeSessionInput()
              if (!input || !input.state) return
              ev.preventDefault()
              ev.stopImmediatePropagation()
              let snap = input.state.getSnapshot()
              let cursor = ta.selectionStart || 0
              const end = ta.selectionEnd == null ? cursor : ta.selectionEnd
              input.setDraft(
                snap.draft.slice(0, cursor) + snap.draft.slice(end),
                { start: cursor, end: end, insertedLength: 0 },
              )
              for (const part of segments) {
                snap = input.state.getSnapshot()
                if (part.type === 'reference') {
                  const applied = input.insertReference(
                    fileReferenceInsert(part.ref, part.kind),
                    { start: cursor, end: cursor, draftRev: snap.draftRev },
                  )
                  if (!applied) break
                  cursor += 2
                } else if (part.value) {
                  input.setDraft(
                    snap.draft.slice(0, cursor) + part.value + snap.draft.slice(cursor),
                    { start: cursor, end: cursor, insertedLength: part.value.length },
                  )
                  cursor += part.value.length
                }
              }
              pendingInlineCaret = cursor
              refreshInlineEditor()
            }
            const referenceMeta = (occurrence) => {
              const rawLabel = String(occurrence.label || '')
              const folder = rawLabel.startsWith('📁 ')
              const decoded = decodeFileReference(occurrence.ref, folder ? 'folder' : 'file')
              return {
                name: referenceFileName(decoded.path),
                line: decoded.start > 0
                  ? (decoded.start === decoded.end ? String(decoded.start) : decoded.start + '-' + decoded.end)
                  : '',
                kind: decoded.kind,
              }
            }
            const iconSvg = (kind) => kind === 'folder'
              ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 4.25h4l1.2 1.5h7.3v6.5h-12.5zM1.75 4.25v-1.5h4l1.2 1.5"/></svg>'
              : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.75h6l4 4v8.5H3zM9 1.75v4h4"/></svg>'
            const renderInlineReferenceChips = () => {
              const ta = composerTextarea()
              const input = nativeSessionInput()
              const snap = input && input.state && input.state.getSnapshot()
              const refs = snap ? (snap.occurrences || []).filter((o) => o.source === 'dsh-file-edit-ref') : []
              if (!ta || refs.length === 0) return
              const byId = new Map(refs.map((occurrence) => [String(occurrence.occurrenceId), occurrence]))
              const chips = document.querySelectorAll('[data-input-backdrop] [data-decoration="chip"][data-occurrence]')
              for (const chip of chips) {
                const occurrence = byId.get(String(chip.getAttribute('data-occurrence')))
                if (!occurrence) continue
                const meta = referenceMeta(occurrence)
                const signature = [occurrence.ref, occurrence.label, occurrence.invalid === true].join('|')
                if (chip.getAttribute('data-file-ref-signature') === signature
                  && chip.querySelector('[data-file-ref-name]')
                  && chip.querySelector('[data-file-ref-rail-remove]')) continue
                chip.setAttribute('data-dsh-file-ref-inline', '')
                chip.setAttribute('data-file-ref-signature', signature)
                chip.title = meta.name
                const label = chip.lastElementChild
                if (!label) continue
                label.setAttribute('data-file-ref-inline-label', '')
                label.replaceChildren()
                const lead = document.createElement('span')
                lead.setAttribute(meta.line ? 'data-file-ref-lines' : 'data-file-ref-icon', '')
                if (meta.line) lead.textContent = meta.line
                else lead.innerHTML = iconSvg(meta.kind)
                const name = document.createElement('span')
                name.setAttribute('data-file-ref-name', '')
                name.textContent = meta.name
                const remove = document.createElement('button')
                remove.type = 'button'
                remove.tabIndex = -1
                remove.setAttribute('data-file-ref-rail-remove', '')
                remove.setAttribute('aria-label', '删除引用')
                remove.textContent = '×'
                remove.addEventListener('mousedown', (event) => event.preventDefault())
                remove.addEventListener('click', (event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  removeFileReference(occurrence.occurrenceId)
                  requestAnimationFrame(() => {
                    renderInlineReferenceChips()
                    refreshInlineEditor()
                  })
                })
                label.append(lead, name, remove)
                if (!chip.hasAttribute('data-file-ref-caret-handler')) {
                  chip.setAttribute('data-file-ref-caret-handler', '')
                  chip.addEventListener('mousedown', (event) => {
                    if (event.target && event.target.closest && event.target.closest('[data-file-ref-rail-remove]')) return
                    event.preventDefault()
                    const latest = nativeSessionInput()
                    const current = latest && latest.state && latest.state.getSnapshot()
                    const id = chip.getAttribute('data-occurrence')
                    const live = current && (current.occurrences || []).find((item) => String(item.occurrenceId) === String(id))
                    const textarea = composerTextarea()
                    if (!live || !textarea) return
                    const at = Math.min(textarea.value.length, live.offset + 1)
                    textarea.focus({ preventScroll: true })
                    textarea.setSelectionRange(at, at)
                  })
                }
              }
            }
            chipObserver = new MutationObserver(renderInlineReferenceChips)
            if (document.body) chipObserver.observe(document.body, { childList: true, subtree: true })
            chipTimer = window.setInterval(renderInlineReferenceChips, 250)
            queueMicrotask(renderInlineReferenceChips)
            window.addEventListener('copy', onNativeCopy, true)
            window.addEventListener('cut', onNativeCopy, true)
            window.addEventListener('paste', onNativePaste, true)
            return () => {
              if (restoreFrame != null) cancelAnimationFrame(restoreFrame)
              if (chipTimer != null) window.clearInterval(chipTimer)
              if (chipObserver) chipObserver.disconnect()
              window.removeEventListener('copy', onNativeCopy, true)
              window.removeEventListener('cut', onNativeCopy, true)
              window.removeEventListener('paste', onNativePaste, true)
              getInlineSelection = () => null
              refreshInlineEditor = () => {}
            }
          }
          let editor = null
          let grow = null
          let activeInput = null
          let activeTextarea = null
          let rendering = false
          let composing = false
          let pendingCompositionLineBreak = false
          let compositionReleaseTimer = null
          let compositionLineBreakTimer = null
          let caretRevealFrame = null
          let lastInlineSelection = null
          const sessionInput = () => {
            const sid = store.sessionId
            if (!sid) return null
            try {
              const actx = ctx.sessions.scope(sid)
              const conversation = actx && actx.get('conversation')
              return conversation && conversation.input && conversation.input.for(actx)
            } catch (e) { return null }
          }
          const linearText = (root) => {
            let out = ''
            const visit = (node) => {
              if (node.nodeType === 3) { out += node.nodeValue || ''; return }
              if (node.nodeType !== 1 && node.nodeType !== 11) return
              if (node.nodeType === 1 && node.hasAttribute('data-file-ref-node')) { out += '\uFFFC'; return }
              if (node.nodeType === 1 && node.tagName === 'BR') { out += '\n'; return }
              const block = node.nodeType === 1 && (node.tagName === 'DIV' || node.tagName === 'P')
              if (block && out && !out.endsWith('\n')) out += '\n'
              for (const child of node.childNodes) visit(child)
            }
            for (const child of root.childNodes) visit(child)
            return out
          }
          const offsetAt = (root, node, offset) => {
            try {
              const range = document.createRange()
              range.selectNodeContents(root)
              range.setEnd(node, offset)
              return linearText(range.cloneContents()).length
            } catch (e) { return 0 }
          }
          const selectionOf = () => {
            if (!editor) return null
            const sel = window.getSelection && window.getSelection()
            if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode) || !editor.contains(sel.focusNode)) return null
            const a = offsetAt(editor, sel.anchorNode, sel.anchorOffset)
            const b = offsetAt(editor, sel.focusNode, sel.focusOffset)
            const range = { start: Math.min(a, b), end: Math.max(a, b) }
            lastInlineSelection = range
            return range
          }
          getInlineSelection = () => selectionOf() || lastInlineSelection
          const pointAt = (root, wanted) => {
            let count = 0
            const walk = (node) => {
              if (node.nodeType === 3) {
                const len = (node.nodeValue || '').length
                if (wanted <= count + len) return { node: node, offset: Math.max(0, wanted - count) }
                count += len
                return null
              }
              if (node.nodeType === 1 && node.hasAttribute('data-file-ref-node')) {
                const parent = node.parentNode
                const index = Array.prototype.indexOf.call(parent.childNodes, node)
                if (wanted <= count) return { node: parent, offset: index }
                count += 1
                if (wanted <= count) return { node: parent, offset: index + 1 }
                return null
              }
              if (node.nodeType === 1 && node.tagName === 'BR') { count += 1; return null }
              for (const child of node.childNodes) { const found = walk(child); if (found) return found }
              return null
            }
            return walk(root) || { node: root, offset: root.childNodes.length }
          }
          const setCaret = (offset) => {
            if (!editor) return
            const point = pointAt(editor, offset)
            const range = document.createRange()
            range.setStart(point.node, point.offset)
            range.collapse(true)
            const sel = window.getSelection()
            sel.removeAllRanges()
            sel.addRange(range)
            lastInlineSelection = { start: offset, end: offset }
          }
          const revealCaret = () => {
            if (!editor || !grow) return
            const scroll = grow.closest('[data-input-scroll]')
            const sel = window.getSelection && window.getSelection()
            if (!scroll || !sel || !sel.rangeCount || !editor.contains(sel.focusNode)) return
            try {
              const caret = sel.getRangeAt(0).cloneRange()
              caret.collapse(false)
              const box = caret.getBoundingClientRect()
              const viewport = scroll.getBoundingClientRect()
              const padding = 6
              const focusOffset = offsetAt(editor, sel.focusNode, sel.focusOffset)
              const atDraftEnd = focusOffset >= linearText(editor).length
              // Chromium may return an empty rectangle for a collapsed range
              // immediately after a trailing newline. The draft-end fallback
              // is deterministic and covers the primary continuous-typing case.
              if ((box.width === 0 && box.height === 0) && atDraftEnd) {
                scroll.scrollTop = scroll.scrollHeight
              } else if (box.bottom > viewport.bottom - padding) {
                scroll.scrollTop += box.bottom - viewport.bottom + padding
              } else if (box.top < viewport.top + padding) {
                scroll.scrollTop -= viewport.top + padding - box.top
              }
            } catch (e) {}
          }
          const requestCaretReveal = () => {
            if (caretRevealFrame != null) cancelAnimationFrame(caretRevealFrame)
            caretRevealFrame = requestAnimationFrame(() => {
              caretRevealFrame = null
              revealCaret()
            })
          }
          const cleanup = () => {
            if (compositionReleaseTimer != null) window.clearTimeout(compositionReleaseTimer)
            if (compositionLineBreakTimer != null) window.clearTimeout(compositionLineBreakTimer)
            if (caretRevealFrame != null) cancelAnimationFrame(caretRevealFrame)
            if (grow) grow.removeAttribute('data-dsh-inline-ref-active')
            if (editor) editor.remove()
            editor = null
            grow = null
            activeInput = null
            activeTextarea = null
            composing = false
            pendingCompositionLineBreak = false
            compositionReleaseTimer = null
            compositionLineBreakTimer = null
            caretRevealFrame = null
            lastInlineSelection = null
          }
          const render = () => {
            // Composition text is browser-owned transient DOM. Replacing the
            // editor from the last committed draft here exposes raw pinyin or
            // commits the first letters before the IME has chosen a candidate.
            if (composing) return
            const input = sessionInput()
            const ta = document.querySelector('textarea[data-phase]')
            const snap = input && input.state && input.state.getSnapshot()
            if (!input || !ta || !snap) { cleanup(); return }
            const refs = (snap.occurrences || []).filter((o) => o.source === 'dsh-file-edit-ref')
            if (!refs.length) { cleanup(); return }
            let migrated = snap.draft
            for (const occ of refs.slice().sort((a, b) => b.offset - a.offset)) {
              let end = occ.offset + 1
              while (migrated[end] === '\u2002') end += 1
              if (end > occ.offset + 1) migrated = migrated.slice(0, occ.offset + 1) + migrated.slice(end)
            }
            if (migrated !== snap.draft) { input.setDraft(migrated); requestAnimationFrame(render); return }
            const nextGrow = ta.parentElement
            if (!nextGrow) return
            if (!editor || grow !== nextGrow) {
              cleanup()
              grow = nextGrow
              editor = document.createElement('div')
              editor.setAttribute('data-dsh-inline-ref-editor', '')
              editor.setAttribute('role', 'textbox')
              editor.setAttribute('aria-multiline', 'true')
              editor.spellcheck = true
              grow.insertBefore(editor, grow.firstChild)
              grow.setAttribute('data-dsh-inline-ref-active', '')
              bindEditor(editor)
            }
            activeInput = input
            activeTextarea = ta
            editor.contentEditable = ta.disabled || ta.readOnly ? 'false' : 'true'
            editor.setAttribute('data-placeholder', ta.placeholder || '')
            if (linearText(editor) === snap.draft && pendingInlineCaret == null) return
            rendering = true
            editor.replaceChildren()
            const byOffset = new Map(refs.map((o) => [o.offset, o]))
            let at = 0
            while (at < snap.draft.length) {
              const occ = byOffset.get(at)
              if (occ) {
                const chip = document.createElement('span')
                chip.setAttribute('data-file-ref-node', '')
                chip.setAttribute('data-occurrence', String(occ.occurrenceId))
                chip.setAttribute('contenteditable', 'false')
                chip.title = occ.ref
                const label = document.createElement('span')
                label.setAttribute('data-file-ref-label', '')
                label.textContent = occ.label
                const remove = document.createElement('button')
                remove.type = 'button'
                remove.tabIndex = -1
                remove.setAttribute('data-file-ref-remove', '')
                remove.setAttribute('aria-label', '删除引用')
                remove.textContent = '×'
                chip.append(label, remove)
                editor.appendChild(chip)
                at += 1
                continue
              }
              let end = at + 1
              while (end < snap.draft.length && !byOffset.has(end)) end += 1
              editor.appendChild(document.createTextNode(snap.draft.slice(at, end)))
              at = end
            }
            rendering = false
            if (pendingInlineCaret != null) {
              const caret = pendingInlineCaret
              pendingInlineCaret = null
              editor.focus()
              setCaret(caret)
              requestCaretReveal()
            }
          }
          const sync = () => {
            if (rendering || composing || !editor || !activeInput) return
            const next = linearText(editor)
            const snap = activeInput.state.getSnapshot()
            // `input` fires after the browser has advanced the contenteditable
            // caret. Persist that new point as part of the same interaction;
            // otherwise the next Explorer/Command+U reference reuses the
            // caret from the previous chip and all chips collect before the
            // newly typed description.
            const range = selectionOf()
            if (next !== snap.draft) {
              // SessionInput can notify subscribers synchronously from
              // setDraft. Publish the post-input caret *before* changing the
              // draft so an immediate render never rebuilds the editor and
              // leaves Chromium's selection at offset zero. This is most
              // visible when Backspace removes the final character.
              if (range && range.start === range.end) pendingInlineCaret = range.end
              activeInput.setDraft(next)
            }
            requestCaretReveal()
          }
          const projectClipboard = (start, end, snap) => {
            let out = ''
            const refs = new Map((snap.occurrences || []).map((o) => [o.offset, o]))
            for (let i = start; i < end; i++) {
              const occ = refs.get(i)
              if (occ) out += occ.clipboardText || ('@' + occ.ref)
              else out += snap.draft[i] || ''
            }
            return out
          }
          const FILE_REF_CLIPBOARD_MIME = 'application/x-dsh-file-edit-references+json'
          const structuredClipboard = (start, end, snap) => {
            const refs = new Map((snap.occurrences || [])
              .filter((o) => o.source === 'dsh-file-edit-ref')
              .map((o) => [o.offset, o]))
            const segments = []
            let text = ''
            const flushText = () => {
              if (!text) return
              segments.push({ type: 'text', value: text })
              text = ''
            }
            for (let i = start; i < end; i++) {
              const occ = refs.get(i)
              if (!occ) { text += snap.draft[i] || ''; continue }
              flushText()
              segments.push({ type: 'reference', ref: occ.ref })
              // insertReference always recreates its own single separator.
              // Do not also serialize that generated space into the custom
              // payload, otherwise every pasted chip gains a duplicate gap.
              if (i + 1 < end && snap.draft[i + 1] === ' ') i += 1
            }
            flushText()
            return segments.some((part) => part.type === 'reference')
              ? JSON.stringify({ version: 1, segments: segments })
              : null
          }
          const parseStructuredClipboard = (data) => {
            if (!data) return null
            try {
              const payload = JSON.parse(data)
              if (!payload || payload.version !== 1 || !Array.isArray(payload.segments)) return null
              const segments = payload.segments.filter((part) => part && (
                (part.type === 'text' && typeof part.value === 'string') ||
                (part.type === 'reference' && typeof part.ref === 'string' && part.ref)
              ))
              return segments.some((part) => part.type === 'reference') ? segments : null
            } catch (e) { return null }
          }
          const pasteStructuredClipboard = (segments, range, inputOverride) => {
            const targetInput = inputOverride || activeInput || sessionInput()
            if (!targetInput || !range) return false
            let snap = targetInput.state.getSnapshot()
            let cursor = range.start
            targetInput.setDraft(snap.draft.slice(0, range.start) + snap.draft.slice(range.end))
            for (const part of segments) {
              if (part.type === 'reference') {
                if (!insertFileReference(fileReferenceInsert(part.ref), { start: cursor, end: cursor })) return false
                cursor += 2
                continue
              }
              if (!part.value) continue
              snap = targetInput.state.getSnapshot()
              targetInput.setDraft(snap.draft.slice(0, cursor) + part.value + snap.draft.slice(cursor))
              cursor += part.value.length
            }
            pendingInlineCaret = cursor
            requestAnimationFrame(render)
            return true
          }
          const deleteReferenceFromKeyboard = (key) => {
            if (!activeInput || (key !== 'Backspace' && key !== 'Delete')) return false
            const range = selectionOf()
            if (!range) return false
            const snap = activeInput.state.getSnapshot()
            const draft = snap.draft || ''
            let start = range.start
            let end = range.end
            if (start !== end) {
              if (!draft.slice(start, end).includes('\uFFFC')) return false
            } else if (key === 'Backspace') {
              if (start > 0 && draft[start - 1] === '\uFFFC') {
                start -= 1
              } else if (start > 1 && draft[start - 1] === ' ' && draft[start - 2] === '\uFFFC') {
                start -= 2
              } else return false
              end = range.start
            } else {
              if (draft[start] !== '\uFFFC') return false
              end = start + 1
            }
            // Treat the separator generated by insertReference as part of the
            // atomic chip when deleting from a collapsed caret boundary.
            if (range.start === range.end && draft[end] === ' ') end += 1
            pendingInlineCaret = start
            activeInput.setDraft(
              draft.slice(0, start) + draft.slice(end),
              { start: start, end: end, insertedLength: 0 },
            )
            requestAnimationFrame(render)
            return true
          }
          const insertInlineLineBreak = (range) => {
            if (!activeInput || !range) return false
            const snap = activeInput.state.getSnapshot()
            // Must precede setDraft: SessionInput observers may render in the
            // same stack and otherwise reset the contenteditable caret.
            pendingInlineCaret = range.start + 1
            activeInput.setDraft(
              snap.draft.slice(0, range.start) + '\n' + snap.draft.slice(range.end),
              { start: range.start, end: range.end, insertedLength: 1 },
            )
            return true
          }
          const flushPendingCompositionLineBreak = () => {
            if (!pendingCompositionLineBreak || composing) return false
            pendingCompositionLineBreak = false
            sync()
            const range = selectionOf() || lastInlineSelection || { start: 0, end: 0 }
            const snap = activeInput && activeInput.state.getSnapshot()
            // Chromium may already have committed both the selected candidate
            // and a native break. Add one only when it is still absent.
            if (!snap || snap.draft[range.start - 1] === '\n') return true
            return insertInlineLineBreak(range)
          }
          const scheduleCompositionLineBreak = () => {
            if (compositionLineBreakTimer != null) window.clearTimeout(compositionLineBreakTimer)
            compositionLineBreakTimer = window.setTimeout(() => {
              compositionLineBreakTimer = null
              if (flushPendingCompositionLineBreak()) {
                requestAnimationFrame(render)
                requestCaretReveal()
              }
            }, 20)
          }
          const bindEditor = (el) => {
            el.addEventListener('input', sync)
            // Keep the draft-coordinate caret hot for gestures that do not
            // mutate text (mouse placement and arrow/Home/End navigation).
            // The document selectionchange listener below is the primary
            // path; these local events cover engines that coalesce it.
            el.addEventListener('mouseup', selectionOf)
            el.addEventListener('keyup', () => { selectionOf(); requestCaretReveal() })
            el.addEventListener('focus', () => { selectionOf(); requestCaretReveal() })
            el.addEventListener('compositionstart', () => {
              if (compositionReleaseTimer != null) window.clearTimeout(compositionReleaseTimer)
              compositionReleaseTimer = null
              composing = true
            })
            el.addEventListener('compositionend', () => {
              // Safari can deliver the final input/keydown immediately after
              // compositionend. Keep rendering frozen through that turn, then
              // commit the completed candidate exactly once.
              if (compositionReleaseTimer != null) window.clearTimeout(compositionReleaseTimer)
              compositionReleaseTimer = window.setTimeout(() => {
                compositionReleaseTimer = null
                composing = false
                sync()
                flushPendingCompositionLineBreak()
                requestAnimationFrame(render)
                requestCaretReveal()
              }, 10)
            })
            el.addEventListener('mousedown', (ev) => {
              if (ev.target && ev.target.closest && ev.target.closest('[data-file-ref-remove]')) ev.preventDefault()
            })
            el.addEventListener('click', (ev) => {
              const button = ev.target && ev.target.closest && ev.target.closest('[data-file-ref-remove]')
              if (!button) return
              const chip = button.closest('[data-file-ref-node]')
              if (chip) removeFileReference(chip.getAttribute('data-occurrence'))
              requestAnimationFrame(render)
            })
            el.addEventListener('keydown', (ev) => {
              if (!ev.metaKey && !ev.altKey && !ev.ctrlKey &&
                  (ev.key === 'Backspace' || ev.key === 'Delete') && deleteReferenceFromKeyboard(ev.key)) {
                ev.preventDefault()
                return
              }
              const imeKey = composing || ev.isComposing || ev.keyCode === 229
              // While references are present this contenteditable replaces
              // the native composer textarea. Own Shift+Enter here instead
              // of relying on the browser's contenteditable DOM mutation:
              // the shell's composer shortcut chain can otherwise consume
              // the event before a stable newline reaches the draft.
              const enterKey = ev.key === 'Enter' || ev.code === 'Enter' || ev.keyCode === 13
              if (enterKey && ev.shiftKey && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
                // Do not preventDefault while IME owns this key: doing so can
                // discard the selected candidate. Remember the intent and add
                // exactly one line break after compositionend commits it.
                if (imeKey) {
                  if (!ev.repeat) {
                    pendingCompositionLineBreak = true
                    // Some macOS IMEs fire compositionend before this keydown.
                    // Consume the intent after the final input event instead
                    // of waiting for an event that has already happened.
                    scheduleCompositionLineBreak()
                  }
                  ev.stopPropagation()
                  return
                }
                ev.preventDefault()
                ev.stopPropagation()
                if (ev.repeat) return
                const range = selectionOf() || { start: 0, end: 0 }
                if (!insertInlineLineBreak(range)) return
                requestAnimationFrame(render)
                requestCaretReveal()
                return
              }
              // Plain Enter while choosing an IME candidate must never be
              // forwarded to the hidden textarea as a submit gesture.
              if (enterKey && imeKey) {
                ev.stopPropagation()
                return
              }
              if (!enterKey || ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return
              ev.preventDefault()
              sync()
              const range = selectionOf() || { start: 0, end: 0 }
              if (!activeTextarea) return
              activeTextarea.focus()
              activeTextarea.setSelectionRange(range.start, range.end)
              activeTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
              requestAnimationFrame(render)
            })
            el.addEventListener('paste', (ev) => {
              if (!ev.clipboardData) return
              const structured = parseStructuredClipboard(ev.clipboardData.getData(FILE_REF_CLIPBOARD_MIME))
              if (structured) {
                ev.preventDefault()
                const range = selectionOf() || { start: 0, end: 0 }
                pasteStructuredClipboard(structured, range)
                return
              }
              const text = ev.clipboardData.getData('text/plain')
              const match = /^@(.+?:\d+(?:-\d+)?)$/.exec(text.trim())
              if (match) {
                ev.preventDefault()
                const range = selectionOf() || { start: 0, end: 0 }
                insertFileReference(fileReferenceInsert(match[1]), range)
                return
              }
              ev.preventDefault()
              document.execCommand('insertText', false, text)
            })
            const copyOrCut = (ev, cut) => {
              const range = selectionOf()
              if (!range || range.start === range.end || !activeInput || !ev.clipboardData) return
              const snap = activeInput.state.getSnapshot()
              ev.preventDefault()
              ev.clipboardData.setData('text/plain', projectClipboard(range.start, range.end, snap))
              const structured = structuredClipboard(range.start, range.end, snap)
              if (structured) ev.clipboardData.setData(FILE_REF_CLIPBOARD_MIME, structured)
              if (cut) {
                pendingInlineCaret = range.start
                activeInput.setDraft(
                  snap.draft.slice(0, range.start) + snap.draft.slice(range.end),
                  { start: range.start, end: range.end, insertedLength: 0 },
                )
                requestAnimationFrame(render)
              }
            }
            el.addEventListener('copy', (ev) => copyOrCut(ev, false))
            el.addEventListener('cut', (ev) => copyOrCut(ev, true))
          }
          const onNativePaste = (ev) => {
            const ta = ev.target && ev.target.closest ? ev.target.closest('textarea[data-phase]') : null
            if (!ta || !ev.clipboardData) return
            const structured = parseStructuredClipboard(ev.clipboardData.getData(FILE_REF_CLIPBOARD_MIME))
            if (structured) {
              ev.preventDefault()
              ev.stopImmediatePropagation()
              pasteStructuredClipboard(structured, {
                start: ta.selectionStart || 0,
                end: ta.selectionEnd == null ? (ta.selectionStart || 0) : ta.selectionEnd,
              }, sessionInput())
              return
            }
            const match = /^@(.+?:\d+(?:-\d+)?)$/.exec(ev.clipboardData.getData('text/plain').trim())
            if (!match) return
            ev.preventDefault()
            ev.stopImmediatePropagation()
            insertFileReference(fileReferenceInsert(match[1]), {
              start: ta.selectionStart || 0,
              end: ta.selectionEnd == null ? (ta.selectionStart || 0) : ta.selectionEnd,
            })
          }
          refreshInlineEditor = render
          const rememberInlineSelection = () => { selectionOf() }
          const rememberBeforeExternalPointer = (ev) => {
            // Explorer's @ button takes focus before it calls the bridge.
            // Snapshot the composer selection during capture, while the
            // browser selection still belongs to the inline editor.
            if (!editor || editor.contains(ev.target)) return
            selectionOf()
          }
          document.addEventListener('selectionchange', rememberInlineSelection)
          document.addEventListener('pointerdown', rememberBeforeExternalPointer, true)
          // Window capture runs before dsh-at-file's document-level paste
          // upgrader. A handled structured paste must never be processed a
          // second time as literal @path text by that legacy pipeline.
          window.addEventListener('paste', onNativePaste, true)
          const observer = new MutationObserver(() => render())
          if (document.body) observer.observe(document.body, { childList: true, subtree: true })
          const timer = window.setInterval(render, 250)
          queueMicrotask(render)
          return () => {
            observer.disconnect()
            window.clearInterval(timer)
            window.removeEventListener('paste', onNativePaste, true)
            document.removeEventListener('selectionchange', rememberInlineSelection)
            document.removeEventListener('pointerdown', rememberBeforeExternalPointer, true)
            getInlineSelection = () => null
            refreshInlineEditor = () => {}
            cleanup()
          }
        }, 'dsh-file-edit: inline-reference-editor')
        const sessionViews = new Map()
        const reviewLabels = new Map()
        Object.assign(store, {
          sessionId: null,
          tabs: [],
          active: null,
          modified: new Set(),
          deleted: new Set(),
          draftDirty: new Set(),
          treeStamp: 0,
          // Cross-view refresh signal: any component that changes review
          // state (hunk accept/reject, file accept/reject, inline edit)
          // bumps this so the modified bar and open file views refetch
          // immediately instead of waiting for their 6s poll.
          refreshTick: 0,
          // v1.8.1: measured heights of the sticky tabs bar and toolbar
          // (px). Used for sticky offsets (CSS vars) and jump scroll math.
          tabH: 32,
          toolH: 35,
          rev: 0,
          subs: new Set(),
          setSessionId(id) {
            if (!id || id === this.sessionId) return
            if (this.sessionId) {
              sessionViews.set(this.sessionId, { tabs: this.tabs.slice(), active: this.active, deleted: new Set(this.deleted) })
            }
            const next = sessionViews.get(id)
            this.sessionId = id
            this.tabs = next ? next.tabs.slice() : []
            this.active = next ? next.active : null
            this.deleted = next ? new Set(next.deleted || []) : new Set()
            this.draftDirty = new Set()
            this.emit()
          },
          openFile(path, sessionId, displayPath) {
            if (!path) return
            if (sessionId) this.setSessionId(String(sessionId))
            if (displayPath) reviewLabels.set(path, displayPath)
            // Activate before publishing the tab so the newly mounted view
            // observes the target file on its first render. The old order
            // could spend the first click only switching views.
            activateFilesView(this.sessionId)
            if (this.tabs.indexOf(path) < 0) this.tabs.push(path)
            this.active = path
            this.emit()
          },
          closeTab(path) {
            const i = this.tabs.indexOf(path)
            if (i < 0) return
            this.tabs.splice(i, 1)
            this.draftDirty.delete(path)
            this.deleted.delete(path)
            if (this.active === path) this.active = this.tabs.length ? this.tabs[this.tabs.length - 1] : null
            this.emit()
          },
          closeAll() {
            if (this.tabs.length === 0) return
            this.tabs = []
            this.active = null
            this.draftDirty = new Set()
            this.deleted = new Set()
            this.emit()
          },
          closeProcessed(pendingPaths) {
            const result = closeProcessedTabState(this.tabs, this.active, pendingPaths, this.draftDirty)
            if (result.closed.length === 0) return 0
            this.tabs = result.tabs
            this.active = result.active
            for (const path of result.closed) { this.draftDirty.delete(path); this.deleted.delete(path) }
            this.emit()
            return result.closed.length
          },
          activate(path) { if (this.active !== path) { this.active = path; this.emit() } },
          renamePath(from, to) {
            if (!from || !to || from === to) return
            const remap = (path) => path === from || path.startsWith(from + '/') || path.startsWith(from + '\\')
              ? to + path.slice(from.length)
              : path
            const nextTabs = this.tabs.map(remap)
            const nextActive = this.active ? remap(this.active) : this.active
            const nextModified = new Set(Array.from(this.modified).map(remap))
            const nextDraftDirty = new Set(Array.from(this.draftDirty).map(remap))
            const nextDeleted = new Set(Array.from(this.deleted).map(remap))
            const changed = nextTabs.some((path, index) => path !== this.tabs[index]) || nextActive !== this.active
              || Array.from(nextModified).some(path => !this.modified.has(path))
              || Array.from(nextDraftDirty).some(path => !this.draftDirty.has(path))
              || Array.from(nextDeleted).some(path => !this.deleted.has(path))
            if (!changed) return
            this.tabs = nextTabs
            this.active = nextActive
            this.modified = nextModified
            this.draftDirty = nextDraftDirty
            this.deleted = nextDeleted
            this.emit()
          },
          removePath(path) {
            if (!path) return
            const inside = (value) => value === path || value.startsWith(path + '/') || value.startsWith(path + '\\')
            const nextTabs = this.tabs.filter(value => !inside(value))
            const nextModified = new Set(Array.from(this.modified).filter(value => !inside(value)))
            const nextDraftDirty = new Set(Array.from(this.draftDirty).filter(value => !inside(value)))
            const nextDeleted = new Set(Array.from(this.deleted).filter(value => !inside(value)))
            const nextActive = this.active && inside(this.active)
              ? (nextTabs.length ? nextTabs[nextTabs.length - 1] : null)
              : this.active
            if (nextTabs.length === this.tabs.length && nextModified.size === this.modified.size
              && nextDraftDirty.size === this.draftDirty.size && nextDeleted.size === this.deleted.size && nextActive === this.active) return
            this.tabs = nextTabs
            this.modified = nextModified
            this.draftDirty = nextDraftDirty
            this.deleted = nextDeleted
            this.active = nextActive
            this.emit()
          },
          moveTab(from, to) { if (from === to || from < 0 || to < 0 || from >= this.tabs.length || to >= this.tabs.length) return; const t = this.tabs.splice(from, 1)[0]; this.tabs.splice(to, 0, t); this.emit() },
          setModified(paths) {
            const next = new Set(paths || [])
            if (next.size === this.modified.size) {
              let same = true
              for (const p of next) if (!this.modified.has(p)) { same = false; break }
              if (same) return
            }
            this.modified = next
            this.emit()
          },
          markDeleted(path) {
            if (!path) return
            const next = markDeletedTabState(this.deleted, this.tabs, path)
            if (next.size === this.deleted.size) return
            this.deleted = next
            this.emit()
          },
          clearDeleted(path) {
            if (!path || !this.deleted.has(path)) return
            this.deleted = clearDeletedTabState(this.deleted, path)
            this.emit()
          },
          setDraftDirty(path, dirty) {
            if (!path) return
            const has = this.draftDirty.has(path)
            if (!!dirty === has) return
            if (dirty) this.draftDirty.add(path)
            else this.draftDirty.delete(path)
            this.emit()
          },
          setTreeStamp(n) {
            const v = Number(n) || 0
            if (v !== this.treeStamp) { this.treeStamp = v; this.emit() }
          },
          // v1.12: the modified bar floats over the file view's bottom edge
          // ONLY while the file editor is the active conversation view; the
          // chat and trajectory views keep the classic in-flow layout.
          // dockH = measured height of the floating bar (px), published to
          // FileView as --dsh-fe-dock-h so the diff scroll areas reserve
          // clearance for the panel.
          fileViewActive: false,
          setFileViewActive(v) { if (!!v !== this.fileViewActive) { this.fileViewActive = !!v; this.emit() } },
          // v1.12.1: dockH publishes on its OWN channel (dockSubs), not the
          // global store emit. A global emit would re-render DiffPane's
          // thousand-line tree (and every sidebar node) on each bar resize —
          // the CPU spike fixed here. Only the FileView CSS-var writer
          // subscribes.
          dockH: 0,
          dockSubs: new Set(),
          setDockH(n) {
            const v = Math.round(Number(n) || 0)
            if (v === this.dockH) return
            this.dockH = v
            const subs = Array.from(this.dockSubs)
            for (const f of subs) { try { f() } catch (e) {} }
          },
          onDockH(f) { this.dockSubs.add(f); return () => { this.dockSubs.delete(f) } },
          requestRefresh() { this.refreshTick++; this.emit() },
          emit() { this.rev++; const subs = Array.from(this.subs); for (const f of subs) { try { f() } catch (e) {} } },
          subscribe(f) { this.subs.add(f); return () => { this.subs.delete(f) } },
        })
        const range = (a, b) => { const r = []; for (let i = a; i < b; i++) r.push(i); return r }
        const useStore = () => {
          const [, force] = React.useState(0)
          React.useEffect(() => store.subscribe(() => force((n) => n + 1)), [])
        }
        // v1.9.3: the poll cadence is DYNAMIC. While the agent is mid-turn
        // (session `running`), tick every 1.5s so edits/adds/deletes surface
        // within ~1.5s of the tool result — the RELIABLE backbone of the
        // instant-refresh path (the long-poll watcher above is best-effort;
        // this environment has shown it can silently die). Idle sessions
        // drop back to the 30s low-frequency failsafe.
        const externalPath = (request) => {
          if (!request || typeof request !== 'object') return ''
          const path = String(request.path || '')
          const absolute = String(request.absolutePath || '')
          const cwd = String(request.cwd || '').replace(/[\\/]+$/, '')
          if (path && (!cwd || (path !== cwd && !path.startsWith(cwd + '/') && !path.startsWith(cwd + '\\')))) return path
          if (absolute && cwd) {
            if (absolute === cwd) return ''
            if (absolute.startsWith(cwd + '/') || absolute.startsWith(cwd + '\\')) return absolute.slice(cwd.length + 1)
          }
          return path || absolute
        }
        // [集成] 暴露全局打开方法：Explorer 必须携带目标 Session 和
        // 已解析 cwd；先切换会话状态，再打开相对工作区路径。
        if (typeof window !== 'undefined') {
          try {
            window.__dshFileEdit = {
              open: async (request) => {
                if (!request || typeof request !== 'object' || !request.sessionId) return false
                const result = await call('resolveOpenTarget', request)
                if (!result || !result.ok || !result.id || result.kind === 'binary') return false
                store.setSessionId(String(request.sessionId))
                if (result.deleted) store.markDeleted(String(result.id))
                store.openFile(String(result.id), undefined, String(result.path || result.id))
                return true
              },
              rename: (from, to) => { store.renamePath(from, to) },
              remove: (path) => { store.removePath(path) },
              markDeleted: (path) => { store.markDeleted(path) },
            }
          } catch (e) {}
        }
        const pollDelayFor = (sid) => {
          try {
            const snap = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null
            if (snap && sid && snap.byId && snap.byId[sid] && snap.byId[sid].running) return 1500
          } catch (e) {}
          return 30000
        }
        const usePoll = (fn, delayOf) => {
          const ref = React.useState({ fn: fn, delayOf: delayOf })[0]
          ref.fn = fn
          ref.delayOf = delayOf
          React.useEffect(() => {
            let disposed = false
            let running = false
            let handle = null
            const arm = () => {
              if (disposed) return
              handle = ctx.timeout(() => { handle = null; tick() }, ref.delayOf())
            }
            const tick = () => {
              if (disposed || running) return
              running = true
              Promise.resolve().then(() => ref.fn()).catch(() => {}).then(() => {
                running = false
                arm()
              })
            }
            // The moment the session flips to running (user sent a message,
            // agent started working), cancel the slow idle timer and tick NOW
            // — otherwise the first edit of the turn could wait out a whole
            // 30s idle arm before the fast cadence kicks in.
            let wasFast = ref.delayOf() <= 2000
            let off = null
            try {
              if (ctx.sessions && ctx.sessions.list && typeof ctx.sessions.list.subscribe === 'function') {
                off = ctx.sessions.list.subscribe(() => {
                  if (disposed) return
                  const fast = ref.delayOf() <= 2000
                  if (fast && !wasFast) {
                    if (handle) { handle(); handle = null }
                    tick()
                  }
                  wasFast = fast
                })
              }
            } catch (e) {}
            // No immediate first tick: initial loads are explicit effects in
            // the consumers (ModifiedBar/DiffPane refetch on sid/path).
            arm()
            return () => { disposed = true; if (handle) handle(); if (off) off() }
          }, [])
        }

        // -------- instant refresh watcher (long-poll against host `wait`) --------
        // The host resolves `wait` the instant an agent mutation (write/edit/
        // shell/pwsh tool result) marks the session dirty, so the modified bar
        // and open diff panes refresh right away instead of waiting for the
        // poll. requestRefresh() makes both the ModifiedBar and every open
        // DiffPane refetch, so a single wake-up covers all surfaces.
        //
        // v1.9.3 hardening (this environment has shown it can silently kill
        // apply-time loops, so the watcher must be unable to die or wedge):
        //  * started lazily from the session-change signal (no apply-time
        //    "no session yet" sleep that could strand the first iteration);
        //  * every iteration is fault-contained (an unexpected throw backs
        //    off and re-runs instead of killing the loop);
        //  * the `wait` fetch carries a 20s abort timeout, so a wedged
        //    request cannot freeze the loop forever;
        //  * a token invalidates an in-flight iteration when the session
        //    changes, so a new session starts its own loop immediately.
        // Best-effort accelerator only: the adaptive poll (fast while the
        // agent is running) is the reliable backbone; this makes it sub-second.
        let watcherDisposed = false
        let watcherToken = 0
        let watcherSid = null
        let watcherTimer = null
        const watcherLoop = async (token) => {
          const sid = store.sessionId
          if (!sid || token !== watcherToken) return
          try {
            const r = await call('wait', { sessionId: sid }, 20000)
            if (watcherDisposed || token !== watcherToken) return
            if (r && r.ok && r.changed) {
              // Several mutations in one agent turn wake us repeatedly:
              // debounce so one refresh covers the burst.
              if (watcherTimer) clearTimeout(watcherTimer)
              watcherTimer = setTimeout(() => { watcherTimer = null; store.requestRefresh() }, 250)
            } else if (!r || !r.ok) {
              // Carrier trouble (fetch failure, aborted wedge, server busy):
              // give the regular poll room before reconnecting.
              await new Promise((res) => setTimeout(res, 6000))
              if (watcherDisposed || token !== watcherToken) return
            }
          } catch (e) {
            await new Promise((res) => setTimeout(res, 6000))
            if (watcherDisposed || token !== watcherToken) return
          }
          void watcherLoop(token)
        }
        const ensureWatcher = () => {
          if (watcherDisposed) return
          const sid = store.sessionId
          if (!sid || sid === watcherSid) return
          watcherSid = sid
          watcherToken++
          void watcherLoop(watcherToken)
        }
        const offWatcherSub = store.subscribe(ensureWatcher)
        ensureWatcher()
        ctx.effect(() => {
          watcherDisposed = true
          if (watcherTimer) { clearTimeout(watcherTimer); watcherTimer = null }
          offWatcherSub()
        }, 'dsh-file-edit: instant refresh watcher')

        // ---------- new-session guard ----------
        // Every New Session entry point in the shell (sidebar top button,
        // wordmark, workspace rows, agent-preset flows) funnels into
        // ctx.workspaces.startSession — the shell closures read the method
        // LIVE at click time, so shadowing the instance method here guards
        // the native button AND this plugin's own 会话历史「新建会话」
        // button with one seam. When the current session still has
        // unreviewed revisions, toast and swallow the action; otherwise —
        // and on any check failure (fail-open) — hand off to the original.
        let toastEl = null
        let toastTimer = null
        const showToast = (message) => {
          if (!toastEl) {
            toastEl = document.createElement('div')
            toastEl.setAttribute('data-plugin', 'dsh-file-edit')
            toastEl.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 16px;font-size:13px;line-height:1.5;max-width:min(440px,calc(100vw - 40px));box-shadow:0 8px 28px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);'
            document.body.append(toastEl)
          }
          toastEl.textContent = message
          toastEl.style.display = 'block'
          if (toastTimer) clearTimeout(toastTimer)
          toastTimer = setTimeout(() => { if (toastEl) toastEl.style.display = 'none' }, 6000)
        }
        const origStartSession = ctx.workspaces && typeof ctx.workspaces.startSession === 'function'
          ? ctx.workspaces.startSession
          : null
        const wsInstance = ctx.workspaces || null
        const currentSessionId = () => {
          try {
            const snap = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null
            if (snap && snap.current) return snap.current
          } catch (e) {}
          return store.sessionId || null
        }
        const checkThen = (sid, allow) => {
          void call('getModified', { sessionId: sid }).then((r) => {
            if (r && r.ok && Array.isArray(r.files) && r.files.length > 0) {
              if (typeof console !== 'undefined' && console.info) {
                console.info('[dsh-file-edit] new session blocked: ' + r.files.length + ' pending file(s), session ' + sid)
              }
              showToast('当前会话还有 ' + r.files.length + ' 个文件的修订未处理，请先接受或拒绝后再新建会话。')
              return
            }
            allow()
          }).catch(allow)
        }
        // Guarded entry used by the plugin's own 新建会话 button directly,
        // and installed over the service method when the instance accepts it.
        const guardedStartSession = function () {
          const args = arguments
          const allow = () => {
            if (origStartSession && wsInstance) { origStartSession.apply(wsInstance, args); return }
            // Late-bound fallback (service arrived after apply): live lookup.
            const live = ctx.workspaces
            if (live && typeof live.startSession === 'function') live.startSession.apply(live, args)
          }
          const sid = currentSessionId()
          if (!sid || !origStartSession) { allow(); return }
          checkThen(sid, allow)
        }
        // Mechanism 1 — method shadow (covers every service-level entry
        // point that calls ctx.workspaces.startSession). The service is
        // delivered through Cordis's traceable proxy, so a raw identity
        // compare always fails (method reads return shadow proxies) — verify
        // through a marker on the wrapped function instead.
        let wrapOk = false
        if (origStartSession) {
          try {
            guardedStartSession.__wrapped = origStartSession
            wsInstance.startSession = guardedStartSession
            if (wsInstance.startSession && wsInstance.startSession.__wrapped === origStartSession) wrapOk = true
          } catch (e) {}
        }
        // Mechanism 2 — DOM capture interception for the native sidebar
        // buttons, ALWAYS installed: it does not depend on the service
        // instance at all, so it covers the observed case where the native
        // button bypasses the shadowed method. Alongside a working shadow it
        // is harmless: a blocked click never reaches the wrapper; an allowed
        // click is forwarded and at most re-checked once by the wrapper.
        let forwarding = false
        let diagCount = 0
        const dispatchForward = (btn, original) => {
          forwarding = true
          try {
            const ev2 = new MouseEvent('click', {
              bubbles: true, cancelable: true, view: window,
              clientX: original ? original.clientX : 0, clientY: original ? original.clientY : 0,
            })
            ev2.__dshFbHandled = 'forwarded'
            btn.dispatchEvent(ev2)
          } finally { forwarding = false }
        }
        const isNativeNewSessionButton = (btn) => {
          if (!btn || btn.disabled) return false
          if (btn.getAttribute('data-dsh-fe-guarded')) return false
          const aria = (btn.getAttribute('aria-label') || '').trim()
          const text = (btn.textContent || '').trim()
          return /新建会话|新会话|New Session|New session/i.test(aria + ' ' + text)
        }
        // Find the clicked button across event retargeting (shadow DOM,
        // portals, re-rendered targets): composedPath sees the full path.
        const buttonFromEvent = (ev) => {
          try {
            if (ev.composedPath) {
              const path = ev.composedPath()
              for (let i = 0; i < path.length; i++) {
                const el = path[i]
                if (el && el.tagName === 'BUTTON') return el
              }
            }
          } catch (e) {}
          if (ev.target && typeof ev.target.closest === 'function') return ev.target.closest('button')
          return null
        }
        // Installed at BOTH window and document capture (window runs first
        // and survives any document-level stopImmediatePropagation); the
        // __dshFbHandled mark makes the second registration a no-op.
        const diagLog = (kind, ev, btn, extra) => {
          if (diagCount >= 100) return
          diagCount++
          console.info('[dsh-file-edit] guard-diag: ' + kind + ' #' + diagCount
            + ' target=' + (ev.target && ev.target.tagName ? ev.target.tagName : '?')
            + ' btn=' + (btn ? ((btn.getAttribute('aria-label') || '').trim() || (btn.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 24) : 'NONE')
            + (extra ? ' ' + extra : ''))
        }
        const onDocClick = (ev) => {
          if (ev.__dshFbHandled) return
          ev.__dshFbHandled = true
          if (forwarding) return
          const btn = buttonFromEvent(ev)
          diagLog('click', ev, btn)
          if (!btn || !isNativeNewSessionButton(btn)) return
          ev.preventDefault()
          ev.stopPropagation()
          ev.stopImmediatePropagation()
          const sid = currentSessionId()
          diagLog('click', ev, btn, 'MATCHED sid=' + sid)
          if (!sid) { showToast('dsh-file-edit 诊断：捕获原生新会话点击（无当前会话，放行）'); dispatchForward(btn, ev); return }
          checkThen(sid, () => { showToast('dsh-file-edit 诊断：原生新会话点击已放行'); dispatchForward(btn, ev) })
        }
        // pointerdown fires before click and cannot be suppressed by a
        // re-render between press and release: pure diagnostic channel.
        const onDocPointerDown = (ev) => {
          diagLog('pointerdown', ev, buttonFromEvent(ev))
        }
        document.addEventListener('click', onDocClick, true)
        try { window.addEventListener('click', onDocClick, true) } catch (e) {}
        document.addEventListener('pointerdown', onDocPointerDown, true)
        try { window.addEventListener('pointerdown', onDocPointerDown, true) } catch (e) {}
        // Direct per-button attachment: property handlers live on the
        // elements themselves and ride the SAME event React uses, so they
        // fire even when addEventListener/capture delivery is broken in this
        // page. stopPropagation at target prevents React's root listener.
        let attachRuns = 0
        let attachToastShown = false
        const attachDirect = () => {
          if (guardDisposed) return
          attachRuns++
          try {
            let n = 0
            document.querySelectorAll('button').forEach((b) => {
              if (b.__dshFbDirect || !isNativeNewSessionButton(b)) return
              b.__dshFbDirect = true
              n++
              const allowStartSession = () => {
                try {
                  const live = ctx.workspaces
                  if (live && typeof live.startSession === 'function') live.startSession(undefined)
                } catch (e) {}
              }
              b.onclick = function (ev) {
                if (ev.__dshFbHandled) return
                ev.__dshFbHandled = true
                ev.preventDefault()
                ev.stopPropagation()
                const sid = currentSessionId()
                diagLog('click', ev, b, 'DIRECT sid=' + sid)
                if (!sid) { showToast('dsh-file-edit 诊断：捕获原生新会话点击（无当前会话，放行）'); allowStartSession(); return }
                checkThen(sid, () => { showToast('dsh-file-edit 诊断：原生新会话点击已放行'); allowStartSession() })
              }
            })
            if (n > 0 && typeof console !== 'undefined' && console.info) {
              console.info('[dsh-file-edit] guard-diag: direct-attach run=' + attachRuns + ' attached=' + n)
            }
            if (typeof console !== 'undefined' && console.info) {
              console.info('[dsh-file-edit] guard-diag: attach run=' + attachRuns + ' n=' + n + ' totalButtons=' + document.querySelectorAll('button').length)
            }
            // Visible confirmation through the toast channel (console output
            // has proven unreliable in this environment).
            if (n > 0 && !attachToastShown) {
              attachToastShown = true
              showToast('dsh-file-edit 诊断：已接管 ' + n + ' 个原生新会话按钮')
            }
          } catch (e) {}
        }
        // Self-rescheduling setTimeout loop: this environment has proven
        // setTimeout works (inventory/probe/toast all run) while setInterval
        // results never materialized — never trust setInterval here.
        let guardDisposed = false
        const attachLoop = () => {
          if (guardDisposed) return
          attachDirect()
          if (attachRuns < 30) setTimeout(attachLoop, 2000)
        }
        attachLoop()
        // Verify the listener plumbing once shortly after boot: dispatch a
        // probe event through our own listeners and report whether it fired.
        setTimeout(() => {
          let fired = 0
          const probe = () => { fired++ }
          try {
            document.addEventListener('dshfb-probe', probe)
            window.addEventListener('dshfb-probe', probe)
            document.dispatchEvent(new Event('dshfb-probe', { bubbles: true }))
            document.removeEventListener('dshfb-probe', probe)
            window.removeEventListener('dshfb-probe', probe)
          } catch (e) {}
          if (typeof console !== 'undefined' && console.info) {
            console.info('[dsh-file-edit] guard-diag: listener probe fired=' + fired)
          }
        }, 1000)
        if (typeof console !== 'undefined' && console.info) {
          console.info('[dsh-file-edit] guard v1.12.6: wrapOk=' + wrapOk + ', sid=' + currentSessionId() + ', listeners installed (window+document, click+pointerdown) + direct button attach (setTimeout loop)')
        }
        // One-shot inventory of session-labelled buttons after the app
        // renders (diagnostic; removed once the native path is confirmed).
        const diagInventory = () => {
          try {
            const list = []
            document.querySelectorAll('button').forEach((b) => {
              const aria = (b.getAttribute('aria-label') || '').trim()
              const text = (b.textContent || '').replace(/\s+/g, ' ').trim()
              if (/会话|Session|New/i.test(aria + ' ' + text)) {
                list.push({ a: aria.slice(0, 40), t: text.slice(0, 40), guarded: !!b.getAttribute('data-dsh-fe-guarded') })
              }
            })
            console.info('[dsh-file-edit] guard-diag: buttons=' + JSON.stringify(list))
            // This timer path is PROVEN to run in this environment — attach
            // from here too (idempotent) in case the dedicated loop is broken.
            attachDirect()
          } catch (e) {}
        }
        setTimeout(() => { diagInventory() }, 1500)
        setTimeout(() => { diagInventory() }, 4000)
        ctx.effect(() => {
          guardDisposed = true
          document.removeEventListener('click', onDocClick, true)
          try { window.removeEventListener('click', onDocClick, true) } catch (e) {}
          document.removeEventListener('pointerdown', onDocPointerDown, true)
          try { window.removeEventListener('pointerdown', onDocPointerDown, true) } catch (e) {}
          try {
            document.querySelectorAll('button').forEach((b) => { if (b.__dshFbDirect) { b.onclick = null; b.__dshFbDirect = false } })
          } catch (e) {}
          // Restore only when our wrapper is really the one installed (the
          // proxy wraps method reads, so compare via the marker, not identity).
          if (origStartSession && wsInstance && wsInstance.startSession && wsInstance.startSession.__wrapped === origStartSession) {
            wsInstance.startSession = origStartSession
          }
          if (toastTimer) clearTimeout(toastTimer)
          if (toastEl) { toastEl.remove(); toastEl = null }
        }, 'dsh-file-edit: new-session guard')

        // Package-owned stylesheet (manual lifecycle — no styles builtin in
        // static client plugins). All colors come from DSH theme tokens.
        let styleEl = null
        const EXTRA_CSS = [
          '.dsh-fe-secbtn { border:none; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; padding:0; border-radius:4px; display:inline-flex; width:18px; height:18px; align-items:center; justify-content:center; flex:none; }',
          '.dsh-fe-secbtn:hover { color:var(--dsw-alias-label-primary); background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); }',
          // Session search: left edge aligned with the session rows' text
          // (they indent 40px via .dsh-fe-sess padding).
          '.dsh-fe-search { background:transparent; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; color:inherit; font-size:12px; padding:2px 8px; width:calc(100% - 40px); box-sizing:border-box; margin:2px 0 5px 40px; }',
          '.dsh-fe-search:focus { outline:1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 40%, transparent); }',
          '.dsh-fe-tab-dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-left:2px; background:var(--dsw-alias-state-warn-primary); vertical-align:middle; }',
          '.dsh-fe-tab-name-deleted { color:var(--dsw-alias-state-error-primary); text-decoration-line:line-through; text-decoration-thickness:1.5px; }',
          '.dsh-fe-deleted-hint { flex:none; border-bottom:1px solid var(--dsw-alias-border-l1); }',
          '.dsh-fe-deleted-document { min-height:0; }',
          '.dsh-fe-tab-drag { opacity:.5; }',
          '.dsh-fe-filetabs { overflow:visible; }',
          '.dsh-fe-filetabs-scroll { display:flex; align-items:center; gap:4px; min-width:0; flex:1; overflow-x:auto; scrollbar-width:none; }',
          '.dsh-fe-filetabs-scroll::-webkit-scrollbar { display:none; }',
          '.dsh-fe-filetabs-scroll .dsh-fe-filetab { flex:none; }',
          '.dsh-fe-tab-actions { position:relative; flex:none; display:flex; align-items:center; margin-left:2px; }',
          '.dsh-fe-tab-more[aria-expanded="true"] { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-tab-menu { position:absolute; top:calc(100% + 6px); right:0; z-index:20; min-width:148px; padding:4px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-2); box-shadow:var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.16)); }',
          '.dsh-fe-tab-menuitem { width:100%; display:flex; align-items:center; padding:6px 9px; border:none; border-radius:6px; background:transparent; color:var(--dsw-alias-label-primary); font-size:12px; text-align:left; white-space:nowrap; cursor:pointer; }',
          '.dsh-fe-tab-menuitem:hover, .dsh-fe-tab-menuitem:focus-visible { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); outline:none; }',
          '.dsh-fe-tab-menuitem:disabled { color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); opacity:.55; cursor:default; background:transparent; }',
          '.dsh-fe-tab-menuerror { max-width:220px; padding:5px 9px; color:var(--dsw-alias-state-error-primary); font-size:11px; line-height:1.35; }',
          // Modified bar matches the composer card width (token shared with
          // InputBar), centered in the full-width dock row.
          '.dsh-fe-bar { width:100%; max-width:var(--dsh-composer-card-max-width); margin:0 auto; box-sizing:border-box; }',
          // Inline line editor: context + hunk-new lines are editable; hunk
          // old (deleted) lines are read-only but selectable for copy.
          '.dsh-fe-tx-edit { cursor:text; outline:none; min-height:1.35em; border-radius:2px; }',
          '.dsh-fe-line .dsh-fe-tx-edit:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 8%, transparent); }',
          '.dsh-fe-tx-edit:focus { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent); box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-label-secondary) 40%, transparent); }',
          '.dsh-fe-tx-ro { user-select:text; opacity:.85; }',
          // ---- v1.4 UI pass: decision glyphs + workbench detailing ----
          // Square icon buttons: the accept/reject gesture language.
          '.dsh-fe-iconbtn { width:22px; height:22px; display:inline-flex; align-items:center; justify-content:center; padding:0; border:none; background:transparent; border-radius:5px; color:var(--dsw-alias-label-secondary); cursor:pointer; flex:none; transition:background .12s ease,color .12s ease; }',
          '.dsh-fe-iconbtn:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-iconbtn-ok { color:var(--dsw-alias-state-success-primary); }',
          '.dsh-fe-iconbtn-ok:hover { background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); color:var(--dsw-alias-state-success-primary); }',
          '.dsh-fe-iconbtn-no { color:var(--dsw-alias-state-error-primary); }',
          '.dsh-fe-iconbtn-no:hover { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); color:var(--dsw-alias-state-error-primary); }',
          '.dsh-fe-iconbtn-sm { width:18px; height:18px; border-radius:4px; }',
          '.dsh-fe-iconbtn:disabled { opacity:.48; cursor:wait; pointer-events:none; }',
          '.dsh-fe-iconbtn[aria-busy="true"] { animation:dsh-fe-review-pulse .65s ease-in-out infinite alternate; }',
          '.dsh-fe-hunk-pending { opacity:.68; transition:opacity .1s ease; }',
          '@keyframes dsh-fe-review-pulse { from { opacity:.38; } to { opacity:.9; } }',
          '.dsh-fe-iconbtn:focus-visible, .dsh-fe-btn:focus-visible, .dsh-fe-secbtn:focus-visible, .dsh-fe-newbtn:focus-visible { outline:2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent); outline-offset:1px; }',
          // Paired gesture buttons (accept/reject): the second button pulls
          // closer so the pair reads as one control group.
          '.dsh-fe-pair { margin-left:-4px; }',
          // Added/removed line counters carry the decision colors.
          '.dsh-fe-stat-add { color:var(--dsw-alias-state-success-primary); }',
          '.dsh-fe-stat-del { color:var(--dsw-alias-state-error-primary); }',
          // The lower/back check of the accept-all glyph (left check, faded).
          '.dsh-fe-ic-sub { opacity:.42; }',
          // Chevron slot: svg icon, rotates when its row is open.
          '.dsh-fe-chev { width:12px; display:inline-flex; justify-content:center; color:var(--dsw-alias-label-secondary); transition:transform .12s ease; }',
          '.dsh-fe-open .dsh-fe-chev { transform:rotate(90deg); }',
          // Fixed-width glyph slot (folder/file/section icons).
          '.dsh-fe-ic { width:15px; flex:none; display:inline-flex; justify-content:center; color:var(--dsw-alias-label-secondary); }',
          // Diff tint sits on the WHOLE row (full width, gutter column keeps
          // its own surface via .dsh-fe-ln's solid background) — v1.8.1.
          '.dsh-fe-line.dsh-fe-old { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); }',
          '.dsh-fe-line.dsh-fe-new { background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }',
          '.dsh-fe-line.dsh-fe-old .dsh-fe-tx, .dsh-fe-line.dsh-fe-new .dsh-fe-tx { background:none; }',
          '.dsh-fe-ln { position:sticky; left:0; background:var(--dsw-alias-bg-layer-1); border-right:1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); }',
          '.dsh-fe-hunk:hover { border-radius:4px; outline-offset:-1px; }',
          '.dsh-fe-hunk-head { border-radius:4px; }',
          // Text buttons carry a leading glyph (＋ 添加 / ＋ 新建会话).
          '.dsh-fe-btn { display:inline-flex; align-items:center; gap:4px; transition:background .12s ease; }',
          '.dsh-fe-newbtn { display:inline-flex; align-items:center; gap:4px; transition:background .12s ease,color .12s ease; }',
          '.dsh-fe-stats { font-family:ui-monospace,Consolas,monospace; }',
          '.dsh-fe-chip-external { color:var(--dsw-alias-state-warn-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 60%, transparent); }',
          '.dsh-fe-bar-head { color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-bar-title { display:inline-flex; align-items:center; gap:6px; }',
          '.dsh-fe-bar-count { color:var(--dsw-alias-label-secondary); font-weight:500; font-size:11.5px; font-family:ui-monospace,Consolas,monospace; }',
          // Tabs: file glyph slot; active tab gets a firmer border.
          '.dsh-fe-filetab { transition:color .12s ease; }',
          '.dsh-fe-filetab-on { border-color:color-mix(in srgb, var(--dsw-alias-label-secondary) 30%, transparent); }',
          '.dsh-fe-tab-ic { display:inline-flex; color:var(--dsw-alias-label-secondary); }',
          '.dsh-fe-filetab-on .dsh-fe-tab-ic { color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-tab-x { color:var(--dsw-alias-label-secondary); }',
          '.dsh-fe-tab-x:hover { color:var(--dsw-alias-label-primary); }',
          // Tree / sidebar rhythm: guide lines, hover easing, current markers.
          '.dsh-fe-children { margin-left:11px; padding-left:5px; border-left:1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent); }',
          '.dsh-fe-row { border-radius:5px; transition:background .12s ease; }',
          '.dsh-fe-ws-row { transition:background .12s ease; }',
          '.dsh-fe-ws-row-cur .dsh-fe-ws-name { color:var(--dsw-alias-label-primary); font-weight:600; }',
          '.dsh-fe-sec { transition:background .12s ease; }',
          '.dsh-fe-sess { transition:background .12s ease; }',
          '.dsh-fe-sess-cur { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 8%, transparent); }',
          '.dsh-fe-railbtn { color:var(--dsw-alias-label-secondary); transition:background .12s ease,color .12s ease; }',
          '.dsh-fe-railbtn:hover { color:var(--dsw-alias-label-primary); }',
          '@media (prefers-reduced-motion: reduce) { .dsh-fe-iconbtn,.dsh-fe-btn,.dsh-fe-chev,.dsh-fe-secbtn,.dsh-fe-row,.dsh-fe-sess,.dsh-fe-sec,.dsh-fe-ws-row,.dsh-fe-file-row,.dsh-fe-filetab,.dsh-fe-newbtn,.dsh-fe-railbtn { transition:none; } }',
          // Reject-undo toast row inside the modified-files bar.
          '.dsh-fe-undo { display:flex; align-items:center; gap:8px; padding:0 2px; font-size:12px; color:var(--dsw-alias-label-secondary); }',
          '.dsh-fe-undo .dsh-fe-btn { padding:1px 8px; }',
          // ---- v1.7.1: composer shadow directly on the bar; the collapse
          // toggle is an icon in the bar head row (no separate handle) ----
          '.dsh-fe-bar { box-shadow:var(--dsw-shadow-lv2, 0 4px 12px 0 rgba(0,0,0,.03), 0 2px 8px 0 rgba(0,0,0,.05)); }',
          // ---- v1.8.3: modified-bar animations ----
          // Bar mount: subtle fade + rise. Body: grid-rows 1fr↔0fr transition
          // for expand/collapse. The bar is capped in every conversation
          // view; only its body scrolls, so the header and collapse action
          // remain reachable when a task modifies many files. Rows:
          // enter/leave.
          '.dsh-fe-bar { max-height:40vh; animation:dsh-fe-bar-in .18s ease-out; }',
          '.dsh-fe-bar-head { flex:none; }',
          '.dsh-fe-body { display:grid; flex:0 1 auto; min-height:0; grid-template-rows:1fr; transition:grid-template-rows .26s ease, opacity .2s ease; }',
          '.dsh-fe-bar-collapsed .dsh-fe-body { grid-template-rows:0fr; opacity:0; }',
          '.dsh-fe-body-inner { overflow-x:hidden; overflow-y:auto; min-height:0; overscroll-behavior:contain; }',
          '.dsh-fe-row-enter { animation:dsh-fe-row-in .18s ease-out; }',
          '.dsh-fe-row-leave { animation:dsh-fe-row-out .2s ease-in forwards; }',
          '@keyframes dsh-fe-bar-in { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }',
          '@keyframes dsh-fe-row-in { from { opacity:0; transform:translateY(-5px); } to { opacity:1; transform:none; } }',
          '@keyframes dsh-fe-row-out { from { opacity:1; transform:none; } to { opacity:0; transform:translateY(-5px); } }',
          '@media (prefers-reduced-motion: reduce) { .dsh-fe-bar, .dsh-fe-row-enter, .dsh-fe-row-leave { animation:none; } .dsh-fe-body { transition:none; } }',
          // ---- v1.7: diff pane scroll architecture + jump controls ----
          '.dsh-fe-pane { display:flex; flex-direction:column; flex:1; min-height:0; }',
          '.dsh-fe-pane > .dsh-fe-diff, .dsh-fe-diffwrap .dsh-fe-diff { flex:1; min-height:0; }',
          '.dsh-fe-diffwrap { position:relative; flex:1; min-height:0; display:flex; flex-direction:column; }',
          // v1.8.1: the tabs bar and toolbar stay pinned while the page (or
          // the diff viewport) scrolls; heights are measured at runtime and
          // published as CSS vars by FileView/DiffPane effects.
          '.dsh-fe-filetabs { position:sticky; top:0; z-index:6; background:var(--dsw-alias-bg-layer-1); border-radius:10px 10px 0 0; }',
          '.dsh-fe-toolbar { position:sticky; top:var(--dsh-fe-tabs-h, 32px); z-index:5; background:var(--dsw-alias-bg-layer-1); }',
          // Zero-height sticky strip: the jump pill rides it, staying just
          // below the sticky header stack for the whole diff (near the
          // scrollbar side). Absent entirely when there are no hunks.
          // align-items:flex-start — the default stretch would collapse the
          // pill to the strip's 0 height and its text would overflow.
          '.dsh-fe-jumprow { position:sticky; top:calc(var(--dsh-fe-tabs-h, 32px) + var(--dsh-fe-toolbar-h, 35px)); z-index:4; display:flex; justify-content:flex-end; align-items:flex-start; height:0; }',
          '.dsh-fe-jump { display:flex; flex:none; align-items:center; gap:2px; padding:4px 4px 4px 9px; margin:8px 12px 0 8px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-2); box-shadow:var(--dsw-shadow-lv1, 0 2px 4px 0 rgba(0,0,0,.05)); font-size:11.5px; font-family:ui-monospace,Consolas,monospace; color:var(--dsw-alias-label-secondary); }',
          '.dsh-fe-jump-count { padding:0 5px; white-space:nowrap; line-height:1; }',
          '.dsh-fe-jump-btn { display:inline-flex; align-items:center; gap:3px; padding:2px 6px; border:none; background:transparent; border-radius:6px; color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1; cursor:pointer; }',
          '.dsh-fe-jump-btn:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-hunk-cur { outline:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)) 55%, transparent); outline-offset:-1px; border-radius:4px; }',
          // ---- v1.7: syntax highlighting ----
          // Editable lines render a transparent caret layer ABOVE a
          // pointer-events:none highlight layer with identical text, so the
          // contentEditable inline editor keeps working untouched.
          '.dsh-fe-txwrap { position:relative; flex:1; min-width:0; padding-right:16px; }',
          '.dsh-fe-txwrap .dsh-fe-tx { display:inline-block; min-height:1.35em; white-space:pre; padding-right:0; }',
          '.dsh-fe-hl { position:absolute; top:0; left:0; white-space:pre; pointer-events:none; user-select:none; color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-txwrap .dsh-fe-tx-edit { color:transparent; caret-color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-txwrap .dsh-fe-tx-edit::selection { background:color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)) 32%, transparent); }',
          // Token palette: all hues derive from theme tokens (light/dark
          // safe, no hard-coded colors).
          '.dsh-fe-tk { color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-tk-kw { color:color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #bd78ff 66%); font-weight:600; }',
          '.dsh-fe-tk-builtin { color:color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #28c8d7 66%); }',
          '.dsh-fe-tk-fn { color:color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #4f8cff 66%); }',
          '.dsh-fe-tk-cls { color:color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #e6a83f 66%); font-weight:600; }',
          '.dsh-fe-tk-const { color:color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #f28c45 66%); font-weight:600; }',
          '.dsh-fe-tk-str { color:color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #55c878 66%); }',
          '.dsh-fe-tk-num { color:color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #f28c45 66%); }',
          '.dsh-fe-tk-com { color:color-mix(in srgb, var(--dsw-alias-label-secondary) 78%, var(--dsw-alias-label-primary)); font-style:italic; }',
          '.dsh-fe-tk-op { color:color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #28c8d7 66%); }',
          '.dsh-fe-tk-var { color:color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #89a8ff 66%); }',
          '.dsh-fe-tk-tag { color:color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #ef5d78 66%); font-weight:600; }',
          '.dsh-fe-tk-attr { color:color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #e6a83f 66%); }',
          '.dsh-fe-tk-key { color:color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #4f8cff 66%); }',
          '.dsh-fe-tk-pp { color:color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #ef5d78 66%); font-weight:600; }',
          '.dsh-fe-tk-code { color:color-mix(in srgb, var(--dsw-alias-label-primary) 46%, #28c8d7 54%); }',
          '.dsh-fe-tk-codei { color:color-mix(in srgb, var(--dsw-alias-label-primary) 46%, #28c8d7 54%); background:color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent); border-radius:3px; padding:0 2px; }',
          // ---- v1.9: rendered markdown document ----
          '.dsh-fe-mdwrap { flex:1; min-height:0; overflow:auto; padding:10px 18px 48px; }',
          '.dsh-fe-md { max-width:86ch; margin:0 auto; font-size:14px; line-height:1.7; color:var(--dsw-alias-label-primary); overflow-wrap:break-word; }',
          '.dsh-fe-md > :first-child { margin-top:0; }',
          '.dsh-fe-md h1, .dsh-fe-md h2, .dsh-fe-md h3, .dsh-fe-md h4, .dsh-fe-md h5, .dsh-fe-md h6 { margin:1.1em 0 .5em; line-height:1.3; font-weight:650; color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-md h1 { font-size:1.65em; padding-bottom:.25em; border-bottom:1px solid var(--dsw-alias-border-l1); }',
          '.dsh-fe-md h2 { font-size:1.35em; padding-bottom:.2em; border-bottom:1px solid var(--dsw-alias-border-l1); }',
          '.dsh-fe-md h3 { font-size:1.15em; }',
          '.dsh-fe-md h4 { font-size:1.02em; }',
          '.dsh-fe-md p { margin:.65em 0; }',
          '.dsh-fe-md a { color:var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary)); text-decoration:none; }',
          '.dsh-fe-md a:hover { text-decoration:underline; }',
          '.dsh-fe-md ul, .dsh-fe-md ol { margin:.6em 0; padding-left:1.7em; }',
          '.dsh-fe-md li { margin:.18em 0; }',
          '.dsh-fe-md li > p { margin:.2em 0; }',
          '.dsh-fe-md blockquote { margin:.8em 0; padding:.15em 1em; border-left:3px solid var(--dsw-alias-border-l1); border-radius:0 6px 6px 0; background:color-mix(in srgb, var(--dsw-alias-label-secondary) 5%, transparent); color:var(--dsw-alias-label-secondary); }',
          '.dsh-fe-md code { font-family:ui-monospace,Consolas,monospace; font-size:.9em; background:color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); border-radius:4px; padding:.1em .35em; }',
          '.dsh-fe-md pre { margin:.8em 0; padding:10px 14px; overflow:auto; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; line-height:1.5; }',
          '.dsh-fe-md pre code { background:none; padding:0; font-size:12.5px; }',
          '.dsh-fe-md table { border-collapse:collapse; margin:.8em 0; max-width:100%; overflow:auto; display:block; font-size:13px; }',
          '.dsh-fe-md th, .dsh-fe-md td { border:1px solid var(--dsw-alias-border-l1); padding:5px 11px; }',
          '.dsh-fe-md th { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 8%, transparent); font-weight:600; }',
          '.dsh-fe-md tr:nth-child(2n) td { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 3%, transparent); }',
          '.dsh-fe-md hr { border:none; border-top:1px solid var(--dsw-alias-border-l1); margin:1.3em 0; }',
          '.dsh-fe-md img { max-width:100%; border-radius:6px; }',
          // ---- v1.11: sidebar vertical rhythm (taller rows + gaps) and
          // session recency labels ----
          // The workspace column was too dense: rows grow a couple of px and
          // gain a small vertical gap so the tree breathes (workspace blocks,
          // section headers, session rows and file rows alike).
          '.dsh-fe-wslist { padding:6px 0; }',
          '.dsh-fe-ws-item { margin-bottom:2px; }',
          '.dsh-fe-ws-item:last-child { margin-bottom:0; }',
          '.dsh-fe-ws-row { padding:6px 8px; }',
          '.dsh-fe-sec { padding:5px 8px 5px 22px; margin:2px 0; }',
          '.dsh-fe-sess { padding:5px 8px 5px 40px; margin:1px 0; }',
          '.dsh-fe-row { padding:4px 8px; margin:1px 0; }',
          '.dsh-fe-newbtn { margin:3px 8px 3px 40px; padding:3px 10px; }',
          '.dsh-fe-search { margin:4px 0 8px 40px; padding:3px 8px; }',
          // Session time labels sit at the right edge of each history row
          // (the name span's flex:1 already pushes them there). v1.11.1: font
          // matches the WebUI body stack (--dsw-font-family, declared on
          // :root by the shell's theme base.css) instead of a code/mono font —
          // Latin glyphs render in the same system UI face as the
          // conversation text (Segoe UI etc.), CJK falls back to the stack's
          // PingFang SC / Microsoft YaHei entries.
          '.dsh-fe-sess-time { flex:none; margin-left:6px; font-size:11px; color:var(--dsw-alias-label-secondary); font-family:var(--dsw-font-family); white-space:nowrap; }',
          // ---- v1.11.1: unified hover transitions ----
          // Every hover highlight now fades on the same .12s ease curve
          // (matching the icon buttons) instead of snapping on. Covers the
          // modified-files bar rows plus the remaining plugin controls that
          // highlighted instantly: tree refresh, tab close, diff jump,
          // inline-edit line hover/focus and the hunk hover outline.
          '.dsh-fe-file-row { transition:background .12s ease; }',
          '.dsh-fe-delete-batch { border-radius:6px; }',
          '.dsh-fe-delete-batch-label { display:flex; align-items:center; gap:2px; flex:1; min-width:0; cursor:pointer; }',
          '.dsh-fe-delete-batch-label .dsh-fe-path { flex:0 1 auto; min-width:0; }',
          '.dsh-fe-delete-batch-toggle { margin-left:1px; }',
          '.dsh-fe-delete-batch-toggle svg { transition:transform .12s ease; }',
          '.dsh-fe-delete-batch-toggle.dsh-fe-delete-batch-open svg { transform:rotate(90deg); }',
          '.dsh-fe-delete-batch-children { margin:1px 6px 4px 28px; padding-left:8px; border-left:1px solid var(--dsw-alias-border-l1); }',
          '.dsh-fe-delete-batch-child { display:flex; align-items:center; gap:8px; min-width:0; padding:3px 6px; border-radius:5px; color:var(--dsw-alias-label-secondary); font-size:12px; }',
          '.dsh-fe-delete-batch-child:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 8%, transparent); }',
          '.dsh-fe-delete-batch-child .dsh-fe-path { color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-secbtn { transition:background .12s ease,color .12s ease; }',
          '.dsh-fe-tab-x { transition:background .12s ease,color .12s ease; }',
          '.dsh-fe-jump-btn { transition:background .12s ease,color .12s ease; }',
          '.dsh-fe-tx-edit { transition:background .12s ease,box-shadow .12s ease; }',
          // Hunk outline: transparent at rest, fades to the hover tint. The
          // current-hunk marker needs a two-class selector to win over the
          // rest-state transparent outline (same-specificity single-class
          // rules would let the later base rule erase it).
          '.dsh-fe-hunk { outline:1px solid transparent; transition:outline-color .12s ease; }',
          '.dsh-fe-hunk:hover { outline-color:color-mix(in srgb, var(--dsw-alias-label-secondary) 40%, transparent); }',
          '.dsh-fe-hunk.dsh-fe-hunk-cur { outline-color:color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)) 55%, transparent); }',
          '@media (prefers-reduced-motion: reduce) { .dsh-fe-tab-x,.dsh-fe-jump-btn,.dsh-fe-tx-edit,.dsh-fe-hunk { transition:none; } }',
          // ---- v1.12: floating modified bar over the file view ----
          // With the file editor active, the bar overlays the editor's bottom
          // edge (absolute inside the sticky composer seat; the bottom offset
          // is measured at runtime against the zero-height dock anchor) so
          // toggling it never reflows the view area: the seat keeps the
          // input-card height and the shell's 36px fade band stays pinned
          // above the InputBar. Chat/trajectory views never get this class
          // and keep the classic in-flow layout.
          '.dsh-fe-dock-anchor { display:block; height:0; }',
          '.dsh-fe-bar-overlay { position:absolute; left:0; right:0; margin:0 auto; z-index:8; }',
          // The editor's scroll areas reserve the floating bar's height so
          // the last lines scroll clear of the panel. dockH is published as
          // --dsh-fe-dock-h by FileView (debounced to settle after the
          // collapse animation) and is 0 outside the file view.
          '.dsh-fe-diff { padding-bottom:var(--dsh-fe-dock-h, 0px); }',
          '.dsh-fe-mdwrap { padding-bottom:calc(48px + var(--dsh-fe-dock-h, 0px)); }',
          // ---- v1.12.1: cheap editor reflows ----
          // Offscreen code lines and markdown block children skip layout &
          // paint entirely: the bar's clearance updates (dockH) then only
          // relayout the ~visible lines instead of the whole file — the other
          // half of the toggle CPU spike. 19px matches the 12.5px/1.5 code
          // line box; the estimates keep the scrollbar stable for content
          // that has never rendered.
          '.dsh-fe-line { content-visibility:auto; contain-intrinsic-size:auto 19px; }',
          '.dsh-fe-md > * { content-visibility:auto; contain-intrinsic-size:auto 24px; }',
          // ---- v1.12.3: shell StateDot "ongoing" chase, replicated ----
          // Same color token, keyframe steps and per-cell delays as
          // ui-primitives/StateDot.module.css (blue --dsw-static-deepseek-450).
          '.dsh-fe-run-matrix { flex:none; color:var(--dsw-static-deepseek-450, var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary))); }',
          '.dsh-fe-run-cell { fill:currentColor; opacity:.15; animation:dsh-fe-run-chase 1s infinite; }',
          '@keyframes dsh-fe-run-chase { 0%,12.4% { opacity:1 } 12.5%,24.9% { opacity:.6 } 25%,37.4% { opacity:.35 } 37.5%,100% { opacity:.15 } }',
          '@media (prefers-reduced-motion: reduce) { .dsh-fe-run-cell { animation:none; opacity:.6 } }',
          // ---- [折行增强 v1] 自动折行（word wrap）----
          // 长行超出容器宽度时折行显示：折行部分不占新行号（.dsh-fe-ln 是独立
          // flex 项，align-items:flex-start 让它只占第一视觉行）；diff 红绿背景
          // 在 .dsh-fe-line 上，折行后自动覆盖整个折行区域。
          '.dsh-fe-code { min-width:0 !important; }',
          '.dsh-fe-line { align-items:flex-start; }',
          '.dsh-fe-tx { white-space:pre-wrap !important; overflow-wrap:anywhere; }',
          '.dsh-fe-txwrap .dsh-fe-tx { display:block; white-space:pre-wrap !important; overflow-wrap:anywhere; }',
          '.dsh-fe-hl { right:16px; white-space:pre-wrap !important; overflow-wrap:anywhere; }',
          // ---- Route A: one CodeMirror document per clean file ----
          '.dsh-fe-document-wrap { flex:1; min-height:0; overflow:hidden; }',
          '.dsh-fe-document-editor { height:100%; min-height:0; }',
          '.dsh-fe-document-editor .cm-editor { height:100%; }',
          '.dsh-fe-document-editor .cm-scroller { padding-bottom:var(--dsh-fe-dock-h, 0px); }',
          '.dsh-fe-document-editor .cm-line { overflow-wrap:anywhere; }',
          '.dsh-fe-document-editor .cm-gutterElement { padding-left:8px; padding-right:8px; }',
          '.dsh-fe-document-editor .cm-search { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border-top:1px solid var(--dsw-alias-border-l1); }',
          '.dsh-fe-toolbar .dsh-fe-btn:disabled { opacity:.55; cursor:default; }',
          // ---- 文件引用：单 textarea + 可变宽原生行内 occurrence ----
          // Harness reserves one width-specific private-use character per
          // occurrence. The native textarea, backdrop and mirror therefore
          // wrap at identical advances while this plugin only decorates the
          // backdrop chip's overlaid label.
          '[data-input-backdrop] { z-index:2; }',
          '[data-input-scroll] textarea[data-phase] { z-index:1; }',
          '[data-input-backdrop] [data-decoration="chip"][data-dsh-file-ref-inline] { pointer-events:auto; border-radius:6px; background:rgba(97,135,216,.22); }',
          '[data-file-ref-inline-label] { position:absolute !important; inset:auto 0 auto 0 !important; top:50% !important; width:100% !important; height:24px; box-sizing:border-box; display:flex !important; align-items:center; justify-content:flex-start !important; gap:5px; padding:0 8px; overflow:hidden; color:var(--dsw-alias-label-primary); font-size:12px; line-height:24px; white-space:nowrap; transform:translateY(-50%) !important; }',
          '[data-file-ref-icon] { display:inline-flex; width:14px; height:14px; flex:none; color:var(--dsw-alias-label-secondary); }',
          '[data-file-ref-icon] svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:1.35; stroke-linecap:round; stroke-linejoin:round; }',
          '[data-file-ref-lines] { flex:none; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }',
          '[data-file-ref-name] { flex:1 1 auto; min-width:1em; max-width:20em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
          '[data-file-ref-rail-remove] { position:absolute; z-index:1; top:4px; right:5px; display:flex; align-items:center; justify-content:center; width:16px; height:16px; padding:0; border:0; border-radius:50%; background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 94%, transparent); color:var(--dsw-alias-label-secondary); font:700 12px/16px var(--dsw-font-family); cursor:pointer; opacity:0; pointer-events:none; transition:opacity .12s ease, background .12s ease; }',
          '[data-decoration="chip"][data-dsh-file-ref-inline]:hover [data-file-ref-rail-remove], [data-file-ref-rail-remove]:focus-visible { opacity:1; pointer-events:auto; }',
          '[data-file-ref-rail-remove]:hover { background:var(--dsw-alias-state-error-primary, #d86161); color:#fff; }',
          // Legacy fallback styles stay dormant while NATIVE_REFERENCE_COMPOSER is true.
          '[data-dsh-inline-ref-active] > [data-input-backdrop], [data-dsh-inline-ref-active] > textarea[data-phase], [data-dsh-inline-ref-active] > [data-input-mirror] { display:none !important; }',
          '[data-dsh-inline-ref-editor] { box-sizing:border-box; width:100%; min-height:28px; padding:4px 12px 0 16px; color:var(--dsw-alias-label-primary); caret-color:var(--dsw-alias-state-business-primary); font-family:var(--dsw-font-family); font-size:inherit; line-height:inherit; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; outline:none; }',
          '[data-dsh-inline-ref-editor]:empty::before { content:attr(data-placeholder); color:var(--dsw-alias-label-caption); pointer-events:none; }',
          '[data-file-ref-node] { display:inline-flex; align-items:center; max-width:min(14em, 80%); height:22px; margin:0 2px; padding:0 5px 0 8px; vertical-align:middle; border-radius:6px; background:rgba(97,135,216,.22); color:var(--dsw-alias-label-primary); font-size:12px; line-height:22px; white-space:nowrap; user-select:all; }',
          '[data-file-ref-label] { overflow:hidden; text-overflow:ellipsis; }',
          '[data-file-ref-remove] { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; margin-left:4px; padding:0; border:0; border-radius:50%; background:transparent; color:var(--dsw-alias-label-secondary); font:700 12px/16px var(--dsw-font-family); cursor:pointer; opacity:0; transition:opacity .12s ease, background .12s ease; }',
          '[data-file-ref-node]:hover [data-file-ref-remove], [data-file-ref-remove]:focus-visible { opacity:1; }',
          '[data-file-ref-remove]:hover { background:var(--dsw-alias-state-error-primary, #d86161); color:#fff; }',
        ].join('\n')
        const ensureStyle = () => {
          if (styleEl) return
          styleEl = document.createElement('style')
          styleEl.setAttribute('data-plugin', 'dsh-file-edit')
          styleEl.textContent = `\n.dsh-fe-btn { border:1px solid var(--dsw-alias-border-l1); background:transparent; border-radius:6px; padding:2px 8px; font-size:12px; cursor:pointer; color:inherit; }\n.dsh-fe-btn:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); }\n.dsh-fe-btn-ok { color:var(--dsw-alias-state-success-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent); }\n.dsh-fe-btn-ok:hover { background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }\n.dsh-fe-btn-no { color:var(--dsw-alias-state-error-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); }\n.dsh-fe-btn-no:hover { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }\n.dsh-fe-bar { display:flex; flex-direction:column; gap:4px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-2); }\n.dsh-fe-bar-head { display:flex; align-items:center; gap:8px; font-weight:600; font-size:13px; flex-wrap:wrap; }\n.dsh-fe-spacer { flex:1; }\n.dsh-fe-file-row { display:flex; align-items:center; gap:8px; padding:3px 6px; border-radius:6px; font-size:12.5px; }\n.dsh-fe-file-row:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent); }\n.dsh-fe-path { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; font-family:ui-monospace,Consolas,monospace; }\n.dsh-fe-chip { font-size:11px; padding:1px 6px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); white-space:nowrap; }\n.dsh-fe-chip-add { color:var(--dsw-alias-state-success-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent); }\n.dsh-fe-chip-del { color:var(--dsw-alias-state-error-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); }\n.dsh-fe-stats { color:var(--dsw-alias-label-secondary); font-size:11.5px; white-space:nowrap; }\n.dsh-fe-viewer { display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); height:100%; }\n.dsh-fe-filetabs { display:flex; align-items:center; gap:4px; padding:4px 6px; border-bottom:1px solid var(--dsw-alias-border-l1); overflow-x:auto; flex:none; }\n.dsh-fe-filetab { display:flex; align-items:center; gap:5px; padding:3px 8px; border:1px solid var(--dsw-alias-border-l1); border-radius:7px; font-size:12px; color:var(--dsw-alias-label-secondary); white-space:nowrap; cursor:pointer; }\n.dsh-fe-filetab:hover { color:var(--dsw-alias-label-primary); }\n.dsh-fe-filetab-on { background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }\n.dsh-fe-tab-x { border:none; background:transparent; cursor:pointer; color:var(--dsw-alias-label-secondary); border-radius:4px; padding:0 4px; font-size:11px; }\n.dsh-fe-tab-x:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 18%, transparent); color:var(--dsw-alias-label-primary); }\n.dsh-fe-diff { overflow:auto; flex:1; font-family:ui-monospace,'Cascadia Code',Consolas,monospace; font-size:12.5px; line-height:1.5; }\n.dsh-fe-toolbar { display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); font-size:12.5px; flex-wrap:wrap; }\n.dsh-fe-code { display:flex; flex-direction:column; min-width:max-content; }\n.dsh-fe-line { display:flex; }\n.dsh-fe-ln { width:4ch; flex:none; text-align:right; padding-right:8px; color:var(--dsw-alias-label-secondary); user-select:text; background:color-mix(in srgb, var(--dsw-alias-label-secondary) 6%, transparent); }\n.dsh-fe-tx { white-space:pre; padding-right:16px; }\n.dsh-fe-old { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); }\n.dsh-fe-new { background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); }\n.dsh-fe-hunk { position:relative; margin:2px 0; border-radius:4px; }\n.dsh-fe-hunk:hover { outline:1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 40%, transparent); }\n.dsh-fe-hunk-head { position:sticky; left:0; display:flex; align-items:center; gap:6px; padding:2px 8px; font-size:11.5px; color:var(--dsw-alias-label-secondary); background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent); }\n.dsh-fe-msg { padding:10px; color:var(--dsw-alias-label-secondary); font-size:12.5px; }\n.dsh-fe-err { padding:4px 10px; color:var(--dsw-alias-state-error-primary); font-size:12px; }\n.dsh-fe-wsroot { display:flex; flex-direction:column; height:100%; overflow:hidden; background:var(--dsw-specific-sidebar-fill); }\n.dsh-fe-wshead { display:flex; align-items:center; gap:8px; padding:6px 10px; font-weight:600; font-size:13px; border-bottom:1px solid var(--dsw-alias-border-l1); }\n.dsh-fe-wslist { flex:1; overflow:auto; padding:4px 0; }\n.dsh-fe-ws-item { padding:3px 4px; border-radius:6px; }\n.dsh-fe-ws-row { display:flex; align-items:center; gap:5px; padding:4px 8px; cursor:pointer; border-radius:6px; font-size:13px; white-space:nowrap; }\n.dsh-fe-ws-row:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent); }\n.dsh-fe-ws-row-open { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); }\n.dsh-fe-chev { width:14px; flex:none; text-align:center; color:var(--dsw-alias-label-secondary); }\n.dsh-fe-ws-name { flex:1; overflow:hidden; text-overflow:ellipsis; }\n.dsh-fe-sec { display:flex; align-items:center; gap:5px; padding:3px 8px 3px 22px; cursor:pointer; font-size:12.5px; color:var(--dsw-alias-label-secondary); border-radius:6px; white-space:nowrap; }\n.dsh-fe-sec:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent); }\n.dsh-fe-sec-open { color:var(--dsw-alias-label-primary); font-weight:600; }\n.dsh-fe-sess { display:flex; align-items:center; gap:6px; padding:3px 8px 3px 40px; cursor:pointer; font-size:12.5px; border-radius:6px; white-space:nowrap; }\n.dsh-fe-sess:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent); }\n.dsh-fe-sess-cur { font-weight:600; }\n.dsh-fe-sess-name { flex:1; overflow:hidden; text-overflow:ellipsis; }\n.dsh-fe-dot { width:7px; height:7px; border-radius:50%; flex:none; background:transparent; }\n.dsh-fe-dot-run { background:var(--dsw-alias-state-warn-primary); }\n.dsh-fe-dot-done { background:var(--dsw-alias-state-success-primary); }\n.dsh-fe-newbtn { border:1px dashed var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-secondary); border-radius:6px; margin:2px 8px 2px 40px; padding:2px 8px; font-size:12px; cursor:pointer; }\n.dsh-fe-newbtn:hover { color:var(--dsw-alias-label-primary); background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent); }\n.dsh-fe-children { margin-left:14px; }\n.dsh-fe-row { display:flex; align-items:center; gap:4px; padding:2px 8px; cursor:pointer; white-space:nowrap; font-size:12.5px; }\n.dsh-fe-row:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent); }\n.dsh-fe-dir { font-weight:600; }\n.dsh-fe-name { overflow:hidden; text-overflow:ellipsis; }\n.dsh-fe-rail { display:flex; flex-direction:column; align-items:center; gap:6px; padding:8px 0; background:var(--dsw-specific-sidebar-fill); }\n.dsh-fe-railbtn { width:34px; height:34px; display:flex; align-items:center; justify-content:center; font-size:17px; border:none; background:transparent; border-radius:8px; cursor:pointer; }\n.dsh-fe-railbtn:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); }\n`
          document.head.append(styleEl)
          styleEl.textContent += EXTRA_CSS
        }
        const removeStyle = () => { if (styleEl) { styleEl.remove(); styleEl = null } }

        // ---------- icon glyphs (inline svg, currentColor strokes) ----------
        const svgBase = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
        const I = (size, vb, children, extra) => React.createElement('svg', { ...svgBase, ...(extra || {}), width: size, height: size, viewBox: vb }, children)
        const P = (d, extra) => React.createElement('path', { d: d, ...(extra || {}) })
        // Decision glyphs share one drawing basis (14-height band, optically
        // centered) so check/cross/accept-all/reject-all sit on one line
        // wherever they render. Stroke 1.8, round caps.
        const CHECK_D = 'M3.1 7.5 L5.9 10.1 L10.9 3.9'
        const IconCheck = () => I(14, '0 0 14 14', [P(CHECK_D)], { strokeWidth: 1.8 })
        const IconCross = () => I(14, '0 0 14 14', [P('M4.3 4.3 L9.7 9.7'), P('M9.7 4.3 L4.3 9.7')], { strokeWidth: 1.8 })
        // Accept-all: the SAME check shape twice, tightly nested but with a
        // touch more air than v1.4.6 — the right check overlaps the left
        // box slightly so the pair reads as one gesture, while a small gap
        // between the legs keeps both ticks distinguishable. Left one fades
        // back (.dsh-fe-ic-sub).
        const IconDoubleCheck = () => I(22, '0 0 22 14', [
          P(CHECK_D, { className: 'dsh-fe-ic-sub' }),
          P('M8.4 7.5 L11.2 10.1 L15.8 4.1'),
        ], { strokeWidth: 1.8 })
        // Reject-all: one cross with a WIDE, round-capped gap across the
        // bottom-left → top-right diagonal (the gap spans the middle third
        // and then some), so the top-left → bottom-right stroke clearly reads
        // as woven over it.
        const IconRejectAll = () => I(14, '0 0 14 14', [
          P('M4.3 9.7 L5.1 8.9'),
          P('M8.9 5.1 L9.7 4.3'),
          P('M4.3 4.3 L9.7 9.7'),
        ], { strokeWidth: 1.8 })
        const IconRefresh = () => I(14, '0 0 14 14', [
          P('M12.5 7 a5.5 5.5 0 1 1 -5.5 -5.5 c1.6 0 3.1 .7 4.1 1.9 L12.5 4.9'),
          P('M12.5 1.5 v3.4 h-3.4'),
        ])
        const IconFolder = () => I(14, '0 0 14 14', [P('M2 4.3 a1 1 0 0 1 1 -1 h2.6 L7 4.7 h4 a1 1 0 0 1 1 1 V10 a1 1 0 0 1 -1 1 H3 a1 1 0 0 1 -1 -1 Z')])
        const IconFile = () => I(14, '0 0 14 14', [P('M4.5 2.5 h4 L11 5 v6 a1 1 0 0 1 -1 1 h-5.5 a1 1 0 0 1 -1 -1 v-7.5 a1 1 0 0 1 1 -1 Z'), P('M8.5 2.5 V5 H11')])
        const IconChevron = () => I(12, '0 0 14 14', [P('M5.5 3.5 L9 7 L5.5 10.5')])
        // v1.8.1: wide, slightly taller chevrons for the collapse toggle
        // (the old 11px glyphs read too small/narrow).
        const IconChevUp = () => React.createElement('svg', { ...svgBase, width: 16, height: 12, viewBox: '0 0 16 12', strokeWidth: 2 }, [P('M2.5 8.5 L8 3 L13.5 8.5')])
        const IconChevDown = () => React.createElement('svg', { ...svgBase, width: 16, height: 12, viewBox: '0 0 16 12', strokeWidth: 2 }, [P('M2.5 3.5 L8 9 L13.5 3.5')])
        const IconClock = () => I(14, '0 0 14 14', [React.createElement('circle', { cx: 7, cy: 7, r: 5.3 }), P('M7 4.2 V7 L9.2 8.4')])
        // v1.12.3: the shell's own running indicator — StateDot state="ongoing"
        // (packages/client/ui-primitives/src/StateDot.tsx + StateDot.module.css):
        // a 3x3 pixel matrix whose 8 outer cells chase clockwise with a stepped
        // brightness trail. Static client bundles cannot import shell packages,
        // so this is a faithful replica: same 10x10 viewBox, crispEdges, cell
        // geometry, keyframe steps and per-rect negative delays
        // ((index - 8) * 125ms), blue via the same --dsw-static-deepseek-450.
        const IconRunning = () => React.createElement('svg', {
          width: 10, height: 10, viewBox: '0 0 10 10',
          shapeRendering: 'crispEdges', 'aria-hidden': true,
          className: 'dsh-fe-run-matrix',
        }, [[0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4]].map((c, index) =>
          React.createElement('rect', {
            key: c[0] + '-' + c[1],
            className: 'dsh-fe-run-cell',
            x: c[0], y: c[1], width: 2, height: 2,
            style: { animationDelay: ((index - 8) * 125) + 'ms' },
          })))
        const IconPencil = () => I(14, '0 0 14 14', [P('M12 3.6 L10.4 2 a1.1 1.1 0 0 0 -1.6 0 L3.4 7.4 V10.6 H6.6 L12 5.2 a1.1 1.1 0 0 0 0 -1.6 Z'), P('M8.6 2.8 L11.2 5.4')])
        const IconPlus = () => I(12, '0 0 14 14', [P('M7 2.5 V11.5'), P('M2.5 7 H11.5')])
        const IconClose = () => I(11, '0 0 14 14', [P('M4 4 L10 10'), P('M10 4 L4 10')])
        const IconMore = () => React.createElement('svg', { ...svgBase, width: 14, height: 14, viewBox: '0 0 14 14', fill: 'currentColor', stroke: 'none' }, [
          React.createElement('circle', { key: 'a', cx: 3, cy: 7, r: 1 }),
          React.createElement('circle', { key: 'b', cx: 7, cy: 7, r: 1 }),
          React.createElement('circle', { key: 'c', cx: 11, cy: 7, r: 1 }),
        ])
        const IconBtn = (props) => React.createElement('button', {
          type: 'button',
          title: props.title,
          disabled: !!props.disabled,
          'aria-busy': props.busy ? 'true' : undefined,
          className: 'dsh-fe-iconbtn' + (props.tone === 'ok' ? ' dsh-fe-iconbtn-ok' : props.tone === 'no' ? ' dsh-fe-iconbtn-no' : '') + (props.small ? ' dsh-fe-iconbtn-sm' : '') + (props.className ? ' ' + props.className : ''),
          onClick: props.onClick,
        }, props.icon ? props.icon() : null)

        // ---------- file tree node ----------
        function TreeNode(props) {
          const node = props.node
          const depth = props.depth || 0
          const [open, setOpen] = React.useState(depth < 1)
          if (node.type === 'directory') {
            const kids = node.children || []
            return React.createElement('div', null,
              React.createElement('div', { className: 'dsh-fe-row dsh-fe-dir' + (open ? ' dsh-fe-open' : ''), onClick: () => setOpen(!open) },
                React.createElement('span', { className: 'dsh-fe-chev' }, IconChevron()),
                React.createElement('span', { className: 'dsh-fe-ic' }, IconFolder()),
                React.createElement('span', { className: 'dsh-fe-name' }, node.name),
              ),
              open ? React.createElement('div', { className: 'dsh-fe-children' },
                kids.map((c) => React.createElement(TreeNode, { key: c.name, node: c, depth: depth + 1, onOpen: props.onOpen }))) : null,
            )
          }
          return React.createElement('div', {
            className: 'dsh-fe-row dsh-fe-file',
            title: node.path,
            onClick: () => props.onOpen(node.path),
            onDoubleClick: () => props.onOpen(node.path),
          },
            React.createElement('span', { className: 'dsh-fe-chev' }, null),
            React.createElement('span', { className: 'dsh-fe-ic' }, IconFile()),
            React.createElement('span', { className: 'dsh-fe-name' }, node.name),
          )
        }

        // v1.11: compact relative-age label for session rows ("2 min",
        // "1 hr", "1 day" — bucket style matching the user's requested
        // format; no plural suffixes by design).
        const timeAgo = (ts, now) => {
          const t = Number(ts)
          if (!t) return ''
          const MIN = 60000, HOUR = 3600000, DAY = 86400000
          const diff = Math.max(0, now - t)
          if (diff < MIN) return 'now'
          if (diff < HOUR) return Math.floor(diff / MIN) + ' min'
          if (diff < DAY) return Math.floor(diff / HOUR) + ' hr'
          if (diff < 30 * DAY) return Math.floor(diff / DAY) + ' day'
          if (diff < 365 * DAY) return Math.floor(diff / (30 * DAY)) + ' mo'
          return Math.floor(diff / (365 * DAY)) + ' yr'
        }

        // ---------- sidebar workspace tree ----------
        function WorkspaceNode(props) {
          const ws = props.ws
          const byId = props.byId
          const currentId = props.currentId
          const sid = store.sessionId
          const [open, setOpen] = React.useState(false)
          // v1.8.3: the two sections collapse/expand INDEPENDENTLY (the old
          // single `section` state made them mutually exclusive).
          const [secHistory, setSecHistory] = React.useState(false)
          const [secFiles, setSecFiles] = React.useState(false)
          const [tree, setTree] = React.useState(null)
          const [treeError, setTreeError] = React.useState(null)
          const [treeLoading, setTreeLoading] = React.useState(false)
          const [query, setQuery] = React.useState('')
          const loadFiles = async (force) => {
            if (!force && (tree || treeError)) return
            if (!sid) { setTreeError('打开会话后可用'); return }
            setTreeLoading(true)
            const r = await call('listTree', { sessionId: sid, root: ws.path })
            if (r.ok) { setTree(r.tree); setTreeError(null) }
            else setTreeError(r.error || '加载失败')
            setTreeLoading(false)
          }
          // v1.11: history ordered by recency — newest session on top (the
          // host's sessionIds order reflects creation/attachment, not
          // activity). Equal timestamps keep the host order (stable sort).
          const sessions = (ws.sessionIds || [])
            .map(id => byId[id])
            .filter(s => s !== undefined)
            .filter(s => !query || (s.displayTitle || '').toLowerCase().indexOf(query.toLowerCase()) >= 0 || s.id.toLowerCase().indexOf(query.toLowerCase()) >= 0)
            .sort((a, b) => ((Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)) || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)))
          const toggleFiles = () => {
            const next = !secFiles
            setSecFiles(next)
            if (next) void loadFiles(false)
          }
          // Auto-refresh: the host bumps a per-session treeStamp whenever the
          // file SET changes (create/delete — including agent tool calls and
          // reject-deletions). The ModifiedBar poll publishes it into the
          // store; each open workspace reloads its tree once per new stamp.
          useStore()
          const stampRef = React.useState({ seen: 0, open: false, filesOpen: false, loading: false })[0]
          stampRef.open = open
          stampRef.filesOpen = secFiles
          stampRef.loading = treeLoading
          React.useEffect(() => {
            const stamp = store.treeStamp
            if (stamp !== undefined && stamp !== null && stamp !== stampRef.seen) {
              stampRef.seen = stamp
              if (stampRef.open && stampRef.filesOpen && !stampRef.loading) void loadFiles(true)
            }
          })
          const isCurrentWs = (ws.sessionIds || []).indexOf(currentId) >= 0
          return React.createElement('div', { className: 'dsh-fe-ws-item' },
            React.createElement('div', {
              className: 'dsh-fe-ws-row' + (open ? ' dsh-fe-ws-row-open dsh-fe-open' : '') + (isCurrentWs ? ' dsh-fe-ws-row-cur' : ''),
              onClick: () => setOpen(!open),
              title: ws.path,
            },
              React.createElement('span', { className: 'dsh-fe-chev' }, IconChevron()),
              React.createElement('span', { className: 'dsh-fe-ic' }, IconFolder()),
              React.createElement('span', { className: 'dsh-fe-ws-name' }, ws.title),
            ),
            open ? React.createElement('div', null,
              React.createElement('div', {
                className: 'dsh-fe-sec' + (secHistory ? ' dsh-fe-sec-open dsh-fe-open' : ''),
                onClick: () => setSecHistory(!secHistory),
              },
                React.createElement('span', { className: 'dsh-fe-chev' }, IconChevron()),
                React.createElement('span', { className: 'dsh-fe-ic' }, IconClock()),
                React.createElement('span', null, '会话历史'),
                React.createElement('span', { className: 'dsh-fe-stats' }, '(' + sessions.length + ')'),
              ),
              secHistory ? React.createElement('div', null,
                React.createElement('input', {
                  className: 'dsh-fe-search',
                  placeholder: '搜索会话…',
                  value: query,
                  onChange: (ev) => setQuery(ev.target.value),
                }),
                sessions.map(s => React.createElement('div', {
                  key: s.id,
                  className: 'dsh-fe-sess' + (s.id === currentId ? ' dsh-fe-sess-cur' : ''),
                  onClick: () => ctx.sessions.open(s.id),
                  title: s.id + (s.updatedAt ? '\n' + new Date(s.updatedAt).toLocaleString() : ''),
                },
                  s.running
                    ? IconRunning()
                    : React.createElement('span', { className: 'dsh-fe-dot' + (s.completed ? ' dsh-fe-dot-done' : '') }),
                  React.createElement('span', { className: 'dsh-fe-sess-name' }, s.displayTitle),
                  React.createElement('span', { className: 'dsh-fe-sess-time' }, timeAgo(s.updatedAt, Date.now())),
                )),
                React.createElement('button', { className: 'dsh-fe-newbtn', 'data-dsh-fe-guarded': '1', onClick: () => guardedStartSession(ws.workspaceId) }, IconPlus(), '新建会话'),
              ) : null,
              React.createElement('div', {
                className: 'dsh-fe-sec' + (secFiles ? ' dsh-fe-sec-open dsh-fe-open' : ''),
                onClick: () => toggleFiles(),
              },
                React.createElement('span', { className: 'dsh-fe-chev' }, IconChevron()),
                React.createElement('span', { className: 'dsh-fe-ic' }, IconFolder()),
                React.createElement('span', null, '项目文件'),
                React.createElement('span', { className: 'dsh-fe-spacer' }, null),
                React.createElement('button', {
                  className: 'dsh-fe-secbtn',
                  title: '刷新文件树',
                  onClick: (ev) => { ev.stopPropagation(); void loadFiles(true) },
                }, treeLoading ? '…' : IconRefresh()),
              ),
              secFiles ? React.createElement('div', null,
                treeError ? React.createElement('div', { className: 'dsh-fe-msg' }, String(treeError)) : null,
                tree ? React.createElement('div', { className: 'dsh-fe-children' },
                  React.createElement(TreeNode, { node: tree, depth: 0, onOpen: (p) => store.openFile(p) })) : null,
              ) : null,
            ) : null,
          )
        }

        function WorkspaceSidebar(props) {
          const wide = !!(props && props.wide)
          const expandSidebar = props && props.expandSidebar
          const wsState = props.useWorkspaces ? props.useWorkspaces(s => s) : null
          const sesState = props.useSessions ? props.useSessions(s => s) : null
          const [error, setError] = React.useState(null)
          const items = wsState ? wsState.items : []
          const addWorkspace = async () => {
            try {
              const path = await ctx.workspaces.pickDirectory()
              if (path) await ctx.workspaces.create({ path: path })
              setError(null)
            } catch (e) {
              setError(e && e.message ? String(e.message) : String(e))
            }
          }
          if (!wide) {
            return React.createElement('div', { className: 'dsh-fe-rail' },
              React.createElement('button', { className: 'dsh-fe-railbtn', title: '添加工作区', onClick: () => addWorkspace() }, IconPlus()),
              items.map(ws => React.createElement('button', {
                key: ws.workspaceId,
                className: 'dsh-fe-railbtn',
                title: ws.title,
                onClick: () => { if (expandSidebar) expandSidebar() },
              }, IconFolder())),
            )
          }
          const byId = sesState ? sesState.byId : {}
          const currentId = sesState ? sesState.current : undefined
          return React.createElement('div', { className: 'dsh-fe-wsroot' },
            React.createElement('div', { className: 'dsh-fe-wshead' },
              React.createElement('span', null, '工作区'),
              React.createElement('span', { className: 'dsh-fe-spacer' }, null),
              React.createElement('button', { className: 'dsh-fe-btn', onClick: () => addWorkspace() }, IconPlus(), '添加'),
            ),
            error ? React.createElement('div', { className: 'dsh-fe-err' }, String(error)) : null,
            React.createElement('div', { className: 'dsh-fe-wslist' },
              items.map(ws => React.createElement(WorkspaceNode, {
                key: ws.workspaceId,
                ws: ws,
                byId: byId,
                currentId: currentId,
              })),
              items.length === 0 ? React.createElement('div', { className: 'dsh-fe-msg' }, '暂无工作区，点击右上角 ＋ 添加') : null,
            ),
          )
        }

        // ---------- modified files bar ----------
        function FileRow(props) {
          const item = props.item
          const reviewId = item.id || item.path
          const [acting, setActing] = React.useState(null)
          const chip = item.createdThenDeleted
            ? React.createElement('span', { className: 'dsh-fe-chip dsh-fe-chip-del' }, '新建后删除')
            : item.status === 'added'
            ? React.createElement('span', { className: 'dsh-fe-chip dsh-fe-chip-add' }, '新增')
            : item.status === 'deleted'
              ? React.createElement('span', { className: 'dsh-fe-chip dsh-fe-chip-del' }, '删除')
              : React.createElement('span', { className: 'dsh-fe-chip' }, '修改')
          const stats = item.createdThenDeleted
            ? React.createElement('span', { className: 'dsh-fe-stats' }, '本会话新建后删除')
            : item.note
            ? React.createElement('span', { className: 'dsh-fe-stats' }, item.note === 'binary' ? '二进制' : (item.note === 'shell-unknown' ? '脚本修改' : (item.note === 'write-before-unknown' ? '修改前内容未知' : '过大')))
            : React.createElement('span', { className: 'dsh-fe-stats' },
              React.createElement('span', { className: 'dsh-fe-stat-add' }, '+' + item.added),
              ' ',
              React.createElement('span', { className: 'dsh-fe-stat-del' }, '−' + item.removed),
              item.pending > 1 ? ' · ' + item.pending + ' 处' : '')
          const go = async (method) => {
            if (acting) return
            setActing(method)
            try {
              const r = await call(method, { sessionId: props.sid, path: reviewId })
              if (!r.ok && props.onError) props.onError(r.error || r.message || '操作失败')
              await props.onDone()
              store.requestRefresh()
            } finally {
              setActing(null)
            }
          }
          return React.createElement('div', { className: 'dsh-fe-file-row' },
            React.createElement('span', { className: 'dsh-fe-ic' }, IconFile()),
            React.createElement('span', { className: 'dsh-fe-path', title: item.path, onClick: () => store.openFile(reviewId, props.sid, item.path) }, item.path),
            item.external ? React.createElement('span', { className: 'dsh-fe-chip dsh-fe-chip-external', title: '此文件位于当前工作区之外' }, '工作区外') : null,
            chip,
            stats,
            React.createElement(IconBtn, { tone: 'ok', title: acting ? '处理中…' : (item.createdThenDeleted ? '确认文件保持删除并结束整条变化' : '接受此文件的修改'), disabled: !!acting, busy: acting === 'acceptFile', onClick: () => go('acceptFile'), icon: IconCheck }),
            React.createElement(IconBtn, { tone: 'no', className: 'dsh-fe-pair', title: item.restorable === false ? '修改前内容不可恢复，只能接受或手动处理' : (acting ? '处理中…' : (item.createdThenDeleted ? '恢复文件并继续保留新增审核' : '拒绝此文件的修改')), disabled: !!acting || item.restorable === false, busy: acting === 'rejectFile', onClick: () => go('rejectFile'), icon: IconCross }),
          )
        }

        function reviewRows(files) {
          const groups = new Map()
          for (const item of files || []) {
            if (!item.deletionBatchId || item.deletionRootKind !== 'directory' || !Number.isInteger(item.deletionFileCount)) continue
            let group = groups.get(item.deletionBatchId)
            if (!group) {
              group = { items: [], root: item.deletionRoot, fileCount: item.deletionFileCount }
              groups.set(item.deletionBatchId, group)
            }
            group.items.push(item)
          }
          const complete = new Map([...groups].filter(([, group]) => group.items.length === group.fileCount && group.items.every((item) => item.deletionRoot === group.root)))
          const emitted = new Set()
          const rows = []
          for (const item of files || []) {
            const group = complete.get(item.deletionBatchId)
            if (!group) { rows.push(item); continue }
            if (emitted.has(item.deletionBatchId)) continue
            emitted.add(item.deletionBatchId)
            rows.push({
              kind: 'deletion-batch',
              id: 'deletion-batch:' + item.deletionBatchId,
              path: group.root,
              deletionBatchId: item.deletionBatchId,
              external: group.items.every((child) => child.external === true),
              children: group.items,
            })
          }
          return rows
        }

        function DeletionBatchRow(props) {
          const item = props.item
          const [open, setOpen] = React.useState(false)
          const [acting, setActing] = React.useState(null)
          const go = async (method) => {
            if (acting) return
            setActing(method)
            try {
              const r = await call(method, { sessionId: props.sid, deletionBatchId: item.deletionBatchId })
              if (!r.ok && props.onError) props.onError(r.error || r.message || '操作失败')
              await props.onDone()
              store.requestRefresh()
            } finally {
              setActing(null)
            }
          }
          return React.createElement('div', { className: 'dsh-fe-delete-batch' },
            React.createElement('div', { className: 'dsh-fe-file-row' },
              React.createElement('span', { className: 'dsh-fe-ic' }, IconFolder()),
              React.createElement('span', { className: 'dsh-fe-delete-batch-label', onClick: () => setOpen(!open) },
                React.createElement('span', { className: 'dsh-fe-path', title: item.path }, item.path),
                React.createElement(IconBtn, {
                  small: true,
                  className: 'dsh-fe-delete-batch-toggle' + (open ? ' dsh-fe-delete-batch-open' : ''),
                  title: open ? '收起目录内文件' : '展开查看目录内文件',
                  onClick: (event) => { event.stopPropagation(); setOpen(!open) },
                  icon: IconChevron,
                }),
              ),
              item.external ? React.createElement('span', { className: 'dsh-fe-chip dsh-fe-chip-external', title: '此目录位于当前工作区之外' }, '工作区外') : null,
              React.createElement('span', { className: 'dsh-fe-chip dsh-fe-chip-del' }, '删除'),
              React.createElement('span', { className: 'dsh-fe-stats' }, item.children.length + ' 个文件'),
              React.createElement(IconBtn, { tone: 'ok', title: acting ? '处理中…' : '接受整个删除批次', disabled: !!acting, busy: acting === 'acceptDeletionBatch', onClick: () => go('acceptDeletionBatch'), icon: IconCheck }),
              React.createElement(IconBtn, { tone: 'no', className: 'dsh-fe-pair', title: acting ? '处理中…' : '拒绝并恢复整个目录', disabled: !!acting, busy: acting === 'rejectDeletionBatch', onClick: () => go('rejectDeletionBatch'), icon: IconCross }),
            ),
            open ? React.createElement('div', { className: 'dsh-fe-delete-batch-children' },
              item.children.map((child) => React.createElement('div', { key: child.id || child.path, className: 'dsh-fe-delete-batch-child' },
                React.createElement('span', { className: 'dsh-fe-ic' }, IconFile()),
                React.createElement('span', {
                  className: 'dsh-fe-path',
                  title: child.path,
                  onClick: () => store.openFile(child.id || child.path, props.sid, child.path),
                }, child.deletionRelativePath && child.deletionRelativePath !== '.' ? child.deletionRelativePath : child.path),
              ))) : null,
          )
        }

        function ModifiedBar(props) {
          const sid = props && props.sessionId
          React.useEffect(() => { if (sid) store.setSessionId(sid) }, [sid])
          const [files, setFiles] = React.useState(null)
          const [error, setError] = React.useState(null)
          const [undo, setUndo] = React.useState(null)
          const [dismissed, setDismissed] = React.useState(null)
          // v1.7: the bar collapses to its one-line header; the chevron
          // handle sits centered above the bar and toggles it back.
          const [collapsed, setCollapsed] = React.useState(false)
          // v1.8.3: animation layer. `files` stays the logical list; `rowSet`
          // mirrors it with per-row flags so entering rows animate in and
          // removed rows animate out before unmounting.
          const [rowSet, setRowSet] = React.useState([])
          const animRef = React.useState({ t: null })[0]
          React.useEffect(() => () => { if (animRef.t) clearTimeout(animRef.t) }, [])
          // v1.12: overlay posture plumbing. The anchor is a zero-height
          // in-flow span that keeps the dock row measurable; the bar root
          // gets position:absolute (class) + a measured `bottom` offset so it
          // floats above the InputBar without occupying seat flow space.
          const barRef = React.useState({ node: null })[0]
          const anchorRef = React.useState({ node: null })[0]
          const [overlayBottom, setOverlayBottom] = React.useState(null)
          const loadRef = React.useState({ token: 0 })[0]
          // v1.11.2: background refreshes are SILENT — no busy state, no
          // flickering "…" next to the file count. The old busy span toggled
          // on every poll tick (every 1.5s while the agent runs), and its
          // insert/remove shifted the flex layout so the centered collapse
          // button visibly jumped in sync.
          const applyModified = (r, token) => {
            if (token !== loadRef.token) return false
            if (r.ok) {
              const next = r.files || []
              const rows = reviewRows(next)
              setFiles(next)
              setError(null)
              for (const item of next) reviewLabels.set(item.id || item.path, item.path)
              store.setModified(next.map(f => f.id || f.path))
              for (const item of next) if (item.status === 'deleted') store.markDeleted(item.id || item.path)
              store.setTreeStamp(r.treeStamp ?? 0)
              setUndo(r.undo ?? null)
              setRowSet((prev) => {
                const prevMap = new Map((prev || []).map((p) => [p.path, p]))
                const merged = rows.map((item) => ({ path: item.id || item.path, item: item, leaving: false, enter: !prevMap.has(item.id || item.path) }))
                const nextSet = new Set(rows.map((f) => f.id || f.path))
                const leaving = (prev || []).filter((p) => !nextSet.has(p.path)).map((p) => ({ path: p.path, item: p.item, leaving: true, enter: false }))
                return merged.concat(leaving)
              })
              if (animRef.t) clearTimeout(animRef.t)
              animRef.t = setTimeout(() => {
                animRef.t = null
                setRowSet((prev) => (prev || []).filter((p) => !p.leaving))
              }, 260)
              return true
            } else {
              setError(r.error || '加载失败')
              store.setModified([])
              setUndo(null)
              return false
            }
          }
          const refresh = async () => {
            if (!sid) return false
            const token = ++loadRef.token
            const r = await call('getModified', { sessionId: sid })
            return applyModified(r, token)
          }
          // Paint persisted pending reviews first, without waiting for any
          // workspace traversal. Then hydrate only the durable review targets.
          // A token prevents a late response from a previous session from
          // replacing the current conversation's review bar.
          React.useEffect(() => {
            if (!sid) return
            const token = ++loadRef.token
            const controller = new AbortController()
            let disposed = false
            let snapshotApplied = false
            void call('getModifiedSnapshot', { sessionId: sid }).then((snapshot) => {
              if (disposed || token !== loadRef.token) return
              snapshotApplied = applyModified(snapshot, token)
              return scheduleStartupTask(
                () => call('getModified', { sessionId: sid }),
                controller.signal,
              )
            }).then((full) => {
              if (disposed || !full || token !== loadRef.token) return
              // A transient scan/reconciliation failure must not erase the
              // durable snapshot we just restored. The normal poll retries.
              if (full.ok || !snapshotApplied) applyModified(full, token)
            }).catch(() => {})
            return () => {
              disposed = true
              controller.abort()
              if (token === loadRef.token) loadRef.token++
            }
          }, [sid])
          usePoll(refresh, () => pollDelayFor(sid))
          // Immediate refresh when the file view changes review state (hunk
          // or file accept/reject, inline edits): refetch now instead of
          // waiting for the next poll.
          useStore()
          const refreshTick = store.refreshTick
          React.useEffect(() => { if (refreshTick) void refresh() }, [refreshTick])
          const doUndo = async () => {
            if (!sid) return
            setError(null)
            const r = await call('undoReject', { sessionId: sid })
            if (!r.ok) setError(r.error || r.message || '撤销失败')
            else if (r.skipped && r.skipped.length > 0) setError('部分文件未撤销：已被再次修改（' + r.skipped.length + ' 个）')
            await refresh()
          }
          const actAll = async (method) => {
            if (!sid) return
            const r = await call(method, { sessionId: sid })
            if (!r.ok) setError(r.error || r.message || '操作失败')
            await refresh()
            store.requestRefresh()
          }
          const list = files || []
          const undoFresh = undo && undo.opId !== dismissed && Date.now() - undo.ts < 30000
          // The bar stays mounted while leaving rows animate out (rowSet may
          // still hold them when the logical list is already empty).
          const visible = !!(sid && (rowSet.length > 0 || undoFresh))
          const overlay = store.fileViewActive
          // v1.12: overlay measurement. The bar's bottom offset = seat bottom
          // − anchor bottom (the anchor rides the zero-height dock row right
          // above the InputBar). The dock height publication is DEBOUNCED:
          // the collapse animation resizes the bar every frame; publishing
          // per frame would animate the editor's bottom padding (a layout
          // pass) in lockstep — the exact jank this design removes. Publish
          // once after the size settles. useLayoutEffect so the offset lands
          // before paint (no in-flow flash on the first overlay frame).
          React.useLayoutEffect(() => {
            if (!overlay || !visible) { setOverlayBottom(null); store.setDockH(0); return }
            const bar = barRef.node
            const anchor = anchorRef.node
            const seat = bar ? bar.offsetParent : null
            if (!bar || !anchor || !seat) return
            const measure = () => {
              const seatRect = seat.getBoundingClientRect()
              const anchorRect = anchor.getBoundingClientRect()
              setOverlayBottom(Math.max(0, Math.round(seatRect.bottom - anchorRect.bottom)))
            }
            let dockTimer = null
            let ro = null
            if (typeof ResizeObserver === 'function') {
              ro = new ResizeObserver((entries) => {
                // The bottom offset depends only on the SEAT (input card)
                // height; bar resizes (the collapse animation) only refresh
                // the dock clearance after the size settles. Filtering skips
                // per-frame measuring during the animation entirely.
                for (let k = 0; k < entries.length; k++) {
                  if (entries[k].target === seat) { measure(); break }
                }
                if (dockTimer) clearTimeout(dockTimer)
                dockTimer = setTimeout(() => {
                  dockTimer = null
                  store.setDockH(Math.round(bar.getBoundingClientRect().height))
                }, 150)
              })
              ro.observe(seat)
              ro.observe(bar)
            }
            measure()
            store.setDockH(Math.round(bar.getBoundingClientRect().height))
            window.addEventListener('resize', measure)
            return () => {
              if (dockTimer) clearTimeout(dockTimer)
              if (ro) ro.disconnect()
              window.removeEventListener('resize', measure)
              store.setDockH(0)
            }
          }, [overlay, visible])
          if (!visible) return null
          const head = React.createElement('div', { className: 'dsh-fe-bar-head' },
            React.createElement('span', { className: 'dsh-fe-bar-title' }, IconPencil(), '修改的文件'),
            React.createElement('span', { className: 'dsh-fe-bar-count' }, String(list.length)),
            React.createElement('span', { className: 'dsh-fe-spacer' }, null),
            // v1.8.1: centered between the left group and the action buttons;
            // the glyph shows what CLICKING will do (expanded → collapse down,
            // collapsed → expand up), not the current state.
            React.createElement(IconBtn, { title: collapsed ? '展开修改文件列表' : '收起修改文件列表（折叠为一行）', onClick: () => setCollapsed(!collapsed), icon: collapsed ? IconChevUp : IconChevDown }),
            React.createElement('span', { className: 'dsh-fe-spacer' }, null),
            React.createElement(IconBtn, { tone: 'ok', title: '全部接受', onClick: () => actAll('acceptAll'), icon: IconDoubleCheck }),
            React.createElement(IconBtn, { tone: 'no', className: 'dsh-fe-pair', title: '全部拒绝', onClick: () => actAll('rejectAll'), icon: IconRejectAll }),
            React.createElement(IconBtn, { title: '刷新', onClick: () => refresh(), icon: IconRefresh }),
          )
          // v1.8.3: the body stays mounted; collapse/expand animates via the
          // grid-rows transition (.dsh-fe-body / .dsh-fe-bar-collapsed).
          const bodyInner = [
            undoFresh ? React.createElement('div', { key: 'undo', className: 'dsh-fe-undo' },
              React.createElement('span', null, '已拒绝 ' + undo.count + ' 个文件'),
              React.createElement('button', { className: 'dsh-fe-btn', title: '撤销上次拒绝（恢复拒绝前的内容）', onClick: () => doUndo() }, '撤销'),
              React.createElement('span', { className: 'dsh-fe-spacer' }, null),
              React.createElement(IconBtn, { small: true, title: '关闭提示', onClick: () => setDismissed(undo.opId), icon: IconClose }),
            ) : null,
            error ? React.createElement('div', { key: 'err', className: 'dsh-fe-err' }, String(error)) : null,
            React.createElement('div', { key: 'rows' },
              rowSet.map((r) => React.createElement('div', {
                key: r.path,
                className: 'dsh-fe-anim' + (r.leaving ? ' dsh-fe-row-leave' : (r.enter ? ' dsh-fe-row-enter' : '')),
              }, r.item.kind === 'deletion-batch'
                ? React.createElement(DeletionBatchRow, { item: r.item, sid: sid, onDone: refresh, onError: setError })
                : React.createElement(FileRow, { item: r.item, sid: sid, onDone: refresh, onError: setError })))),
          ]
          const barStyle = overlay && overlayBottom !== null ? { bottom: overlayBottom + 'px' } : null
          return React.createElement(React.Fragment, null,
            React.createElement('span', { ref: (node) => { anchorRef.node = node }, className: 'dsh-fe-dock-anchor' }),
            React.createElement('div', {
              ref: (node) => { barRef.node = node },
              className: 'dsh-fe-bar' + (collapsed ? ' dsh-fe-bar-collapsed' : '') + (overlay ? ' dsh-fe-bar-overlay' : ''),
              style: barStyle,
            },
              head,
              React.createElement('div', { className: 'dsh-fe-body' },
                React.createElement('div', { className: 'dsh-fe-body-inner' }, bodyInner)),
            ),
          )
        }

        // ---------- syntax highlighting (v1.7) ----------
        // A lightweight per-line tokenizer for 24 languages. It is a
        // highlighter, not a compiler: strings, comments, numbers, operators,
        // keywords, built-ins, constants and declaration-driven function/
        // class names are colored; genuinely ambiguous corners (regex
        // literals, nested interpolations) degrade to plain text instead of
        // mis-coloring. Keyword sets follow the official references
        // (cpython, ECMA-262, JLS, C11, C++23, C# spec, Go spec, Rust
        // reference, PHP, Ruby, Swift, Kotlin, R, Bash, PowerShell, SQL,
        // WHATWG HTML, CSS Syntax, JSON, YAML 1.2, TOML 1.0, XML,
        // CommonMark).
        const S = (words) => {
          const o = Object.create(null)
          const parts = words.split(' ')
          for (let i = 0; i < parts.length; i++) if (parts[i]) o[parts[i]] = 1
          return o
        }
        const Q = (pairs) => pairs
        const OP_DEFAULT = ['>>>=', '===', '!==', '**=', '<<=', '>>=', '>>>', '**', '...', '<=>', '->', '=>', '::', '++', '--', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '~=', '?.']
        const DEF_BLOCK = ['/*', '*/']
        const DEF_LINE = ['//']
        const CC_QUOTES = [['"', '"'], ["'", "'"]]

        const tokenize = (text, cfg, state) => {
          const out = []
          const n = text.length
          const plain = (s, c) => { if (s) out.push({ t: s, c: c || null }) }
          const push = (t, c) => out.push({ t: t, c: c })
          state.mode = state.mode || null
          let prevSig = state.prevSig || ''
          let i = 0
          if (state.mode === 'block') {
            const end = text.indexOf(cfg.block[1])
            if (end < 0) { push(text, 'com'); return out }
            push(text.slice(0, end + cfg.block[1].length), 'com')
            i = end + cfg.block[1].length
            state.mode = null
            prevSig = ''
          } else if (state.mode === 'mlstr') {
            const q = state.mlq
            const end = text.indexOf(q)
            if (end < 0) { push(text, 'str'); return out }
            push(text.slice(0, end + q.length), 'str')
            i = end + q.length
            state.mode = null
            state.mlq = null
          }
          // Preprocessor line (C/C++): #include/#define/... — the directive
          // head gets its own color, the rest of the line tokenizes normally.
          // (Runs once per line: tokenize is called once per rendered line.)
          if (cfg.pre) {
            const lead = text.match(/^\s*/)[0]
            if (text[lead.length] === '#') {
              const dm = /^#\s*([A-Za-z_]\w*)/.exec(text.slice(lead.length))
              if (dm) {
                plain(lead)
                push(text.slice(lead.length, lead.length + dm[0].length), 'pp')
                i = lead.length + dm[0].length
                prevSig = 'pp'
              }
            }
          }
          while (i < n) {
            const ch = text[i]
            // Block comment.
            if (cfg.block && text.startsWith(cfg.block[0], i)) {
              const end = text.indexOf(cfg.block[1], i + cfg.block[0].length)
              if (end < 0) { push(text.slice(i), 'com'); state.mode = 'block'; return out }
              push(text.slice(i, end + cfg.block[1].length), 'com')
              i = end + cfg.block[1].length
              prevSig = 'com'
              continue
            }
            // Line comments. A '#'-style comment optionally only counts when
            // it starts a word (bash / PowerShell): foo#bar is not a comment.
            let hitLine = false
            const lc = cfg.line || []
            for (let li = 0; li < lc.length; li++) {
              const c = lc[li]
              if (!text.startsWith(c, i)) continue
              if (c === '#' && cfg.hashWord && i > 0 && !/\s/.test(text[i - 1])) continue
              push(text.slice(i), 'com')
              i = n
              hitLine = true
              break
            }
            if (hitLine) break
            // Strings (longest delimiters first).
            let hitStr = false
            const quotes = cfg.quotes || []
            for (let qi = 0; qi < quotes.length; qi++) {
              const q = quotes[qi]
              const o = q[0]
              if (!text.startsWith(o, i)) continue
              // Rust lifetime: 'ident with no closing quote on the line.
              if (cfg.lifetimes && o === "'" && /^'[A-Za-z_]\w*/.test(text.slice(i)) && text.indexOf("'", i + 1) < 0) break
              const multiline = o.length >= 3 || cfg.ml === true
              let end = -1
              if (o.length === 1) {
                let k = i + 1
                while (k < n) {
                  if (cfg.quoteDoubleEscape && text[k] === q[1] && text[k + 1] === q[1]) { k += 2; continue }
                  if (cfg.esc && text[k] === cfg.esc) { k += 2; continue }
                  if (text[k] === q[1]) { end = k; break }
                  k++
                }
              } else {
                end = text.indexOf(q[1], i + o.length)
              }
              if (end < 0) {
                push(text.slice(i), 'str')
                if (multiline) { state.mode = 'mlstr'; state.mlq = q[1] }
                i = n
                hitStr = true
                break
              }
              let cls = 'str'
              if (cfg.keyStrings) {
                let k = end + q[1].length
                while (k < n && /\s/.test(text[k])) k++
                if (text[k] === ':') cls = 'key'
              }
              push(text.slice(i, end + q[1].length), cls)
              i = end + q[1].length
              hitStr = true
              break
            }
            if (hitStr) { prevSig = 'str'; continue }
            // Numbers.
            const nm = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
            if (nm) {
              let end = i + nm[0].length
              if (cfg.numSuffix) {
                const sm = cfg.numSuffix.exec(text.slice(end))
                if (sm && (end + sm[0].length >= n || !/[\w]/.test(text[end + sm[0].length]))) end += sm[0].length
              }
              push(text.slice(i, end), 'num')
              i = end
              prevSig = 'num'
              continue
            }
            // Identifiers (with optional prefix chars such as $ or @).
            if (/[A-Za-z_]/.test(ch) || (cfg.idPrefix && cfg.idPrefix.indexOf(ch) >= 0)) {
              let j = i
              if (cfg.idPrefix && cfg.idPrefix.indexOf(ch) >= 0) {
                j++
                while (j < n && /[\w]/.test(text[j])) j++
              } else if (cfg.cmdlet) {
                // PowerShell cmdlets contain hyphens (Verb-Noun).
                while (j < n && /[\w-]/.test(text[j])) j++
              } else {
                while (j < n && /[\w]/.test(text[j])) j++
              }
              const word = text.slice(i, j)
              const lower = word.toLowerCase()
              // Strip the leading id-prefix ($ / @) for dictionary lookups so
              // PHP's $_SERVER matches the 'builtin' list entry _SERVER.
              const baseWord = (cfg.idPrefix && cfg.idPrefix.indexOf(word[0]) >= 0) ? word.slice(1) : word
              // PowerShell cmdlet heuristic: Verb-Noun casing (word boundary,
              // not line-end — the identifier was already isolated above).
              if (cfg.cmdlet && /^[A-Z][a-z]+(-[A-Za-z][\w-]*)+(?![A-Za-z0-9_-])/.test(word)) {
                push(word, 'fn')
                i = j
                prevSig = 'fn'
                continue
              }
              const kwCls = cfg.kwExact ? cfg.kw[word] : (cfg.kw[lower] || cfg.kw[baseWord.toLowerCase()])
              if (kwCls) {
                push(word, 'kw')
                prevSig = cfg.decl[lower] ? 'decl' : 'kw'
                i = j
                continue
              }
              // Case-insensitive languages get pre-computed lowercase
              // dictionaries once per config (their keys may be mixed case).
              if (cfg.caseInsensitive && !cfg._lc) {
                const c = Object.create(null)
                const bl = Object.create(null)
                for (const k of Object.keys(cfg.const)) c[k.toLowerCase()] = 1
                for (const k of Object.keys(cfg.builtin)) bl[k.toLowerCase()] = 1
                cfg._lc = { c: c, b: bl }
              }
              const lookLower = cfg.caseInsensitive ? baseWord.toLowerCase() : null
              const cnCls = cfg.caseInsensitive ? cfg._lc.c[lookLower] : (cfg.const[word] || cfg.const[baseWord])
              if (cnCls) { push(word, 'const'); prevSig = 'const'; i = j; continue }
              const bnCls = cfg.caseInsensitive ? cfg._lc.b[lookLower] : (cfg.builtin[word] || cfg.builtin[baseWord])
              if (bnCls) { push(word, 'builtin'); prevSig = 'builtin'; i = j; continue }
              // A prefixed identifier that matched nothing (Ruby @ivar,
              // PHP $local) reads as a variable.
              if (baseWord !== word) { push(word, 'var'); prevSig = 'var'; i = j; continue }
              if (prevSig === 'decl') {
                push(word, /^[A-Z]/.test(word) ? 'cls' : 'fn')
                prevSig = 'fn'
                i = j
                continue
              }
              // Call position (ident + '(') beats the capitalized-type rule:
              // PascalCase method calls read as functions, while type
              // references (Foo<T>, Foo.Bar, `Foo x`) stay class names.
              let k = j
              while (k < n && /\s/.test(text[k])) k++
              if (text[k] === '(') { push(word, 'fn'); prevSig = 'fn'; i = j; continue }
              if (cfg.capitalClass && /^[A-Z]/.test(word)) { push(word, 'cls'); prevSig = 'cls'; i = j; continue }
              push(word, null)
              prevSig = 'plain'
              i = j
              continue
            }
            // Variables: $x, ${x}, $1, $?, $# ... (bash / PowerShell / PHP).
            if (ch === '$') {
              let j = i + 1
              if (text[j] === '{') {
                const end = text.indexOf('}', j)
                j = end < 0 ? n : end + 1
              } else if (/[A-Za-z_]/.test(text[j] || '')) {
                while (j < n && /[\w]/.test(text[j])) j++
              } else if (text[j] !== undefined && !/\s/.test(text[j])) {
                j++
              }
              const word = text.slice(i, j)
              const base = word.slice(1)
              push(word, (cfg.const[word] || cfg.const[base]) ? 'const' : 'var')
              i = j
              prevSig = 'var'
              continue
            }
            // Ruby symbol: :sym
            if (cfg.symbol && ch === ':' && /[A-Za-z_]/.test(text[i + 1] || '')) {
              let j = i + 1
              while (j < n && /[\w!?=]/.test(text[j])) j++
              push(text.slice(i, j), 'const')
              i = j
              prevSig = 'const'
              continue
            }
            // Operators (longest first).
            let hitOp = false
            const opl = cfg.opList || OP_DEFAULT
            for (let oi = 0; oi < opl.length; oi++) {
              const op = opl[oi]
              if (text.startsWith(op, i)) { push(op, 'op'); i += op.length; hitOp = true; break }
            }
            if (hitOp) { prevSig = 'op'; continue }
            if ('+-*/%=<>!&|^~?.,;'.indexOf(ch) >= 0) { push(ch, 'op'); i++; prevSig = 'op'; continue }
            if (/\s/.test(ch)) {
              let j = i
              while (j < n && /\s/.test(text[j])) j++
              plain(text.slice(i, j))
              i = j
              continue
            }
            plain(ch)
            i++
            prevSig = 'other'
          }
          state.prevSig = prevSig
          return out
        }

        // ---------- per-language configs ----------
        const HL_LANGS = {}

        HL_LANGS.python = {
          line: ['#'], block: null,
          quotes: [['"""', '"""'], ["'''", "'''"], ['"', '"'], ["'", "'"]],
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false,
          kw: S('and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield'),
          const: S('True False None NotImplemented Ellipsis'),
          builtin: S('abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__'),
          decl: S('def class'),
        }
        HL_LANGS.java = {
          line: DEF_LINE, block: DEF_BLOCK, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false,
          numSuffix: /^[lLfFdD]/,
          kw: S('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield'),
          const: S('true false null'),
          builtin: S('System out err println print printf String StringBuilder Math Integer Long Double Float Boolean Character Arrays List Map Set HashMap ArrayList Collections Optional Stream Thread Runnable Exception RuntimeException'),
          decl: S('class interface enum record'),
        }
        HL_LANGS.javascript = {
          line: DEF_LINE, block: DEF_BLOCK,
          quotes: [['"', '"'], ["'", "'"], ['`', '`']],
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false, ml: true,
          numSuffix: /^n/,
          kw: S('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await'),
          const: S('true false null undefined NaN Infinity'),
          builtin: S('console document window globalThis Object Array String Number Boolean Symbol BigInt Math JSON Date RegExp Map Set WeakMap WeakSet Promise Proxy Reflect Error TypeError RangeError parseInt parseFloat isNaN isFinite decodeURIComponent encodeURIComponent decodeURI encodeURI structuredClone fetch setTimeout setInterval clearTimeout clearInterval queueMicrotask ArrayBuffer DataView Uint8Array Int32Array Float64Array require module exports process Buffer'),
          decl: S('function class'),
        }
        HL_LANGS.typescript = {
          line: DEF_LINE, block: DEF_BLOCK,
          quotes: [['"', '"'], ["'", "'"], ['`', '`']],
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false, ml: true,
          numSuffix: /^n/,
          kw: S('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await type interface namespace module declare abstract implements private protected public readonly enum keyof infer is as satisfies unknown never any string number boolean symbol object bigint void override unique assert asserts using accessor'),
          const: S('true false null undefined NaN Infinity'),
          builtin: S('console log warn error info debug dir table document window globalThis Object Array String Number Boolean Symbol BigInt Math JSON Date RegExp Map Set WeakMap WeakSet Promise Proxy Reflect Error TypeError RangeError parseInt parseFloat isNaN isFinite structuredClone fetch setTimeout setInterval clearTimeout clearInterval Record Partial Required Readonly Pick Omit Exclude Extract NonNullable ReturnType Parameters InstanceType Awaited PromiseLike'),
          decl: S('function class interface type enum namespace'),
        }
        HL_LANGS.c = {
          line: DEF_LINE, block: DEF_BLOCK, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: true,
          numSuffix: /^[uUlL]{1,3}/,
          kw: S('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local'),
          const: S('NULL true false'),
          builtin: S('printf scanf fprintf sprintf snprintf malloc calloc realloc free memcpy memset memcmp strcmp strlen strcpy strcat fopen fclose fread fwrite getchar putchar puts exit atoi atof abs labs qsort bsearch assert errno stdin stdout stderr FILE size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t'),
          decl: S('struct union enum typedef'),
        }
        HL_LANGS.cpp = {
          line: DEF_LINE, block: DEF_BLOCK, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: true,
          numSuffix: /^[uUlLfF]{1,3}/,
          kw: S('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local alignas alignof and and_eq asm bitand bitor bool catch char8_t char16_t char32_t class compl concept consteval constexpr constinit const_cast co_await co_return co_yield decltype delete dynamic_cast explicit export false friend mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public reinterpret_cast requires static_assert static_cast template this thread_local throw true try typeid typename using virtual wchar_t xor xor_eq'),
          const: S('nullptr NULL true false'),
          builtin: S('printf scanf fprintf sprintf snprintf malloc calloc realloc free memcpy memset memcmp strcmp strlen strcpy strcat fopen fclose fread fwrite getchar putchar puts exit atoi atof abs labs qsort bsearch assert errno stdin stdout stderr FILE size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t cout cin cerr endl string vector map set unordered_map unordered_set pair tuple unique_ptr shared_ptr weak_ptr make_unique make_shared move forward optional variant std begin end size push_back emplace_back find sort'),
          decl: S('class struct enum union template typename using'),
        }
        HL_LANGS.csharp = {
          line: DEF_LINE, block: DEF_BLOCK, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false, kwExact: true,
          numSuffix: /^[uUlLfFdDmM]/,
          kw: S('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while add alias and ascending async await by descending dynamic equals file from get global group init into join let managed nameof nint not notnull nuint on or orderby partial record remove required scoped select set unmanaged value var when where with yield'),
          const: S('true false null'),
          // No builtin list: C# types and members are both PascalCase, so the
          // capitalized-type rule colors type references and the call rule
          // colors method invocations (Console.WriteLine → cls + fn).
          builtin: S(''),
          decl: S('class struct interface enum record delegate'),
        }
        HL_LANGS.go = {
          line: DEF_LINE, block: DEF_BLOCK,
          quotes: [['"', '"'], ['`', '`'], ["'", "'"]],
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false, ml: true,
          kw: S('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'),
          const: S('true false nil iota'),
          builtin: S('append cap clear close complex copy delete imag len make max min new panic print println real recover bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any comparable fmt os io strings strconv errors time context sync math sort bytes bufio net http json log regexp path filepath runtime reflect'),
          decl: S('func type var const struct interface'),
        }
        HL_LANGS.rust = {
          line: DEF_LINE, block: DEF_BLOCK, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false, lifetimes: true,
          numSuffix: /^(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64)/,
          kw: S('as break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await macro'),
          const: S('true false'),
          builtin: S('Some None Ok Err println print format panic assert assert_eq assert_ne vec env args i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str'),
          decl: S('fn struct enum trait impl mod type const static use'),
        }
        HL_LANGS.php = {
          line: ['//', '#'], block: DEF_BLOCK, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: true, capitalClass: true, pre: false, idPrefix: '$',
          kw: S('abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield'),
          const: S('true false null'),
          builtin: S('echo print printf sprintf strlen str_replace substr explode implode count array_push array_pop in_array isset empty die exit header json_encode json_decode array_map array_filter array_reduce intval floatval strval boolval is_array is_string is_int is_float is_null is_numeric is_bool define defined class_exists function_exists method_exists property_exists get_class gettype settype var_dump print_r _GET _POST _REQUEST _SERVER _SESSION _COOKIE _FILES _ENV GLOBALS this self parent static __construct __destruct __call __get __set __isset __unset __toString __invoke __clone __CLASS__ __METHOD__ __FUNCTION__ __NAMESPACE__ __DIR__ __FILE__ __LINE__ __TRAIT__'),
          decl: S('function class interface trait enum'),
        }
        HL_LANGS.ruby = {
          line: ['#'], block: null, quotes: [['"', '"'], ["'", "'"], ['`', '`']],
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false, symbol: true, idPrefix: '@',
          kw: S('BEGIN END alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'),
          const: S('true false nil'),
          builtin: S('puts print p pp gets require require_relative raise fail loop attr_accessor attr_reader attr_writer include extend prepend private protected public module_function lambda proc map each select reject reduce inject collect find filter flatten uniq sort join split gsub sub match scan length size empty nil hash keys values fetch merge to_s to_i to_f to_a to_h is_a kind_of respond_to class superclass ancestors freeze dup clone instance_variable_get instance_variable_set'),
          decl: S('def class module'),
        }
        HL_LANGS.swift = {
          line: DEF_LINE, block: DEF_BLOCK,
          quotes: [['"""', '"""'], ['"', '"'], ["'", "'"]],
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false,
          kw: S('associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return throw switch where while as Any await false is nil self Self super throws true try actor async borrowing consuming distributed macro nonisolated package isolated some any'),
          const: S('true false nil'),
          builtin: S('print dump fatalError assert precondition String Int Double Float Bool Array Dictionary Set Optional Result Range ClosedRange stride map filter reduce compactMap flatMap first last count isEmpty append insert remove contains sorted joined split enumerated zip forEach AnyObject Never Void Character Substring'),
          decl: S('class struct enum protocol extension func var let typealias actor'),
        }
        HL_LANGS.kotlin = {
          line: DEF_LINE, block: DEF_BLOCK,
          quotes: [['"""', '"""'], ['"', '"'], ["'", "'"]],
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false,
          numSuffix: /^[uUlLfF]/,
          kw: S('as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg value'),
          const: S('true false null'),
          builtin: S('println print readLine listOf mutableListOf setOf mutableSetOf mapOf mutableMapOf arrayOf intArrayOf arrayListOf sequenceOf emptyList emptySet emptyMap require check error TODO run let apply also with use lazy repeat rangeTo until downTo step first last filter map flatMap forEach groupBy associateBy any all none count sum sortedBy distinct joinToString split toInt toDouble toString'),
          decl: S('class interface object enum fun val var typealias'),
        }
        HL_LANGS.r = {
          line: ['#'], block: null, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: false, capitalClass: false, pre: false,
          opList: ['%>%', '<-', '->', '<<-', ':::', '::', '==', '!=', '<=', '>=', '&&', '||', '&', '|', '!', '~', '+', '-', '*', '/', '^', '%%', '%/%', '**', '$', '@'],
          kw: S('if else repeat while function for in next break'),
          const: S('TRUE FALSE NULL Inf NaN NA NA_integer_ NA_real_ NA_complex_ NA_character_'),
          builtin: S('c list matrix array data.frame factor as.numeric as.character as.integer as.logical as.factor as.data.frame length names nrow ncol dim sum mean median sd var min max range seq rep paste paste0 print cat library require install.packages setwd getwd read.csv read.table write.csv write.table str summary head tail table sort order unique duplicated which match grep sub gsub substr nchar toupper tolower lapply sapply apply tapply mapply do.call source assign get exists rm ls class typeof attributes attr'),
          decl: S('function'),
        }
        HL_LANGS.bash = {
          line: ['#'], block: null, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: false, capitalClass: false, pre: false, hashWord: true,
          opList: ['&&', '||', ';;', ';&', ';;&', '<<<', '<<', '>>', '==', '!=', '<=', '>=', '+=', '-=', '2>', '2>&1', '|&', '|', '&', '>', '<', ';', '!'],
          kw: S('if then else elif fi case esac for while until do done in function select time coproc'),
          const: S(''),
          builtin: S('echo printf cd pwd export readonly unset shift getopts source alias unalias hash type ulimit umask return break continue eval exec exit trap wait kill jobs bg fg disown test let declare typeset local read readarray mapfile set shopt help pushd popd dirs builtin command enable true false'),
          decl: S('function'),
        }
        HL_LANGS.powershell = {
          line: ['#'], block: ['<#', '#>'], quotes: CC_QUOTES,
          esc: '`', caseInsensitive: true, capitalClass: true, pre: false, hashWord: true, cmdlet: true,
          kw: S('begin break catch class continue data define do dynamicparam else elseif end enum exit filter finally for foreach from function hidden if in param process return static switch throw trap try until using var while workflow'),
          const: S('true false null'),
          builtin: S('Write-Output Write-Host Write-Error Write-Warning Write-Verbose Write-Debug Read-Host Get-Content Set-Content Add-Content Out-File Get-ChildItem Get-Item Remove-Item New-Item Copy-Item Move-Item Rename-Item Set-Item Get-Location Set-Location Push-Location Pop-Location Get-Process Start-Process Stop-Process Get-Service Start-Service Stop-Service Get-Command Get-Help Get-Member Where-Object ForEach-Object Select-Object Sort-Object Group-Object Measure-Object Format-Table Format-List Export-Csv Import-Csv ConvertTo-Json ConvertFrom-Json Invoke-WebRequest Invoke-RestMethod Test-Path Join-Path Split-Path Resolve-Path New-Object Set-Variable Get-Variable Clear-Variable Remove-Variable Start-Sleep Get-Date Set-Date Add-Type'),
          decl: S('function class enum param'),
        }
        HL_LANGS.sql = {
          line: ['--'], block: DEF_BLOCK, quotes: [["'", "'"], ['"', '"'], ['`', '`']],
          esc: '\\', quoteDoubleEscape: true, caseInsensitive: true, capitalClass: false, pre: false,
          kw: S('select from where insert update delete create alter drop table index view join inner left right full outer cross on as and or not null is in exists between like group by order having limit offset union all distinct case when then else end primary key foreign references unique constraint default values into set add column begin commit rollback transaction with over partition desc asc check if return function procedure trigger execute grant revoke truncate merge explain use database schema intersect except'),
          const: S('true false null'),
          builtin: S('coalesce nullif cast count sum avg min max abs round floor ceil lower upper length substr substring trim ltrim rtrim concat replace now current_date current_timestamp dateadd datediff datepart row_number rank dense_rank lead lag first_value last_value ntile'),
          decl: S(''),
        }
        // JSON rides the generic scanner: strings followed by ':' become keys.
        HL_LANGS.json = {
          line: [], block: null, quotes: [['"', '"']],
          esc: '\\', caseInsensitive: false, capitalClass: false, pre: false, keyStrings: true,
          kw: S(''), const: S('true false null'), builtin: S(''), decl: S(''),
        }

        // ---------- markup / data / prose scanners ----------
        const scanHtml = (text, state) => {
          const out = []
          const n = text.length
          const plain = (s, c) => { if (s) out.push({ t: s, c: c || null }) }
          let i = 0
          state.mode = state.mode || null
          if (state.mode === 'comment') {
            const end = text.indexOf('-->')
            if (end < 0) { out.push({ t: text, c: 'com' }); return out }
            out.push({ t: text.slice(0, end + 3), c: 'com' })
            i = end + 3
            state.mode = null
          }
          // Text runs: split out &entities; for a distinct color.
          const plainText = (s) => {
            if (!s) return
            const parts = s.split(/(&[A-Za-z][A-Za-z0-9]*;|&#\d+;|&#x[0-9a-fA-F]+;)/)
            for (const p of parts) {
              if (!p) continue
              if (/^&/.test(p)) out.push({ t: p, c: 'const' })
              else out.push({ t: p, c: null })
            }
          }
          while (i < n) {
            const lt = text.indexOf('<', i)
            if (lt < 0) { plainText(text.slice(i)); i = n; break }
            plainText(text.slice(i, lt))
            if (text.startsWith('<!--', lt)) {
              const end = text.indexOf('-->', lt + 4)
              if (end < 0) { out.push({ t: text.slice(lt), c: 'com' }); state.mode = 'comment'; return out }
              out.push({ t: text.slice(lt, end + 3), c: 'com' })
              i = end + 3
              continue
            }
            let j = lt + 1
            let close = false
            if (text[j] === '/') { close = true; j++ }
            const m = /^[A-Za-z][\w:-]*/.exec(text.slice(j))
            if (m) {
              if (close) out.push({ t: text.slice(lt, j), c: 'tag' })
              out.push({ t: m[0], c: 'tag' })
              j += m[0].length
            } else {
              // <!DOCTYPE ...>, <?xml ...?>
              const m2 = /^[!?][A-Za-z][\w:-]*/.exec(text.slice(j))
              if (m2) {
                out.push({ t: text.slice(lt, j) + m2[0], c: 'pp' })
                j += m2[0].length
              } else {
                plain(text[lt])
                i = lt + 1
                continue
              }
            }
            let expectValue = false
            while (j < n) {
              const ch = text[j]
              if (ch === '>') { plain('>'); j++; break }
              if (ch === '/' && text[j + 1] === '>') { plain('/>'); j += 2; break }
              if (/\s/.test(ch)) { plain(ch); j++; continue }
              if (ch === '=') { out.push({ t: '=', c: 'op' }); j++; expectValue = true; continue }
              if (expectValue) {
                const q = (ch === '"' || ch === "'") ? ch : ''
                if (q) {
                  const end = text.indexOf(q, j + 1)
                  if (end < 0) { out.push({ t: text.slice(j), c: 'str' }); j = n; break }
                  out.push({ t: text.slice(j, end + 1), c: 'str' })
                  j = end + 1
                } else {
                  const vm = /^[^\s>]+/.exec(text.slice(j))
                  if (vm) { out.push({ t: vm[0], c: 'str' }); j += vm[0].length }
                  else { plain(ch); j++ }
                }
                expectValue = false
                continue
              }
              const am = /^[^\s=/>]+/.exec(text.slice(j))
              if (am) { out.push({ t: am[0], c: 'attr' }); j += am[0].length; continue }
              plain(ch); j++
            }
            i = j
          }
          return out
        }

        const scanCss = (text, state) => {
          const out = []
          const n = text.length
          const plain = (s, c) => { if (s) out.push({ t: s, c: c || null }) }
          let i = 0
          state.depth = state.depth || 0
          state.mode = state.mode || null
          if (state.mode === 'block') {
            const end = text.indexOf('*/')
            if (end < 0) { out.push({ t: text, c: 'com' }); return out }
            out.push({ t: text.slice(0, end + 2), c: 'com' })
            i = end + 2
            state.mode = null
          }
          while (i < n) {
            const ch = text[i]
            if (ch === '/' && text[i + 1] === '*') {
              const end = text.indexOf('*/', i + 2)
              if (end < 0) { out.push({ t: text.slice(i), c: 'com' }); state.mode = 'block'; return out }
              out.push({ t: text.slice(i, end + 2), c: 'com' })
              i = end + 2
              continue
            }
            if (ch === '"' || ch === "'") {
              const end = text.indexOf(ch, i + 1)
              if (end < 0) { out.push({ t: text.slice(i), c: 'str' }); i = n; break }
              out.push({ t: text.slice(i, end + 1), c: 'str' })
              i = end + 1
              continue
            }
            if (ch === '@') {
              const m = /^@[\w-]+/.exec(text.slice(i))
              if (m) { out.push({ t: m[0], c: 'kw' }); i += m[0].length; continue }
            }
            if (ch === '#' && /[0-9a-fA-F]/.test(text[i + 1] || '')) {
              const m = /^#[0-9a-fA-F]{3,8}\b/.exec(text.slice(i))
              if (m) { out.push({ t: m[0], c: 'const' }); i += m[0].length; continue }
            }
            if (/[0-9]/.test(ch)) {
              const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|rad|turn|fr|ch|ex|pt|pc|cm|mm|in|dpi|dppx|Hz|kHz)?/.exec(text.slice(i))
              if (m) { out.push({ t: m[0], c: 'num' }); i += m[0].length; continue }
            }
            if (ch === '{') { plain('{'); i++; state.depth++; continue }
            if (ch === '}') { plain('}'); i++; state.depth = Math.max(0, state.depth - 1); continue }
            // property name inside a declaration block: ident/--custom : value
            if (state.depth > 0 && (i === 0 || /[\s{;]/.test(text[i - 1]))) {
              const pm = /^(?:--[\w-]+|-?[A-Za-z_][\w-]*)\s*:(?=\s|[^\w-]|$)/.exec(text.slice(i))
              if (pm) {
                out.push({ t: pm[0].slice(0, pm[0].lastIndexOf(':')), c: 'attr' })
                out.push({ t: ':', c: 'op' })
                i += pm[0].length
                continue
              }
            }
            // function call name: var( calc( url( ...
            const fm = /^(-?[A-Za-z_][\w-]*)\s*\(/.exec(text.slice(i))
            if (fm) { out.push({ t: fm[1], c: 'fn' }); plain('('); i += fm[0].length; continue }
            // pseudo-classes / pseudo-elements: :hover ::before :root
            if (ch === ':') {
              const sm = /^::?[A-Za-z_-][\w-]*/.exec(text.slice(i))
              if (sm) { out.push({ t: sm[0], c: 'cls' }); i += sm[0].length; continue }
            }
            // class / id selectors
            if (ch === '.' || ch === '#') {
              const sm2 = /^[.#][A-Za-z_-][\w-]*/.exec(text.slice(i))
              if (sm2) { out.push({ t: sm2[0], c: 'cls' }); i += sm2[0].length; continue }
            }
            if (/[A-Za-z_-]/.test(ch)) {
              const wm = /^[A-Za-z_-][\w-]*/.exec(text.slice(i))
              if (wm) {
                const w = wm[0].toLowerCase()
                const c = (w === 'important' || w === 'inherit' || w === 'initial' || w === 'unset' || w === 'revert' || w === 'auto' || w === 'none') ? 'kw' : null
                out.push({ t: wm[0], c: c })
                i += wm[0].length
                continue
              }
            }
            if ('{},;:()>+~*='.indexOf(ch) >= 0) { out.push({ t: ch, c: 'op' }); i++; continue }
            if (/\s/.test(ch)) { let j = i; while (j < n && /\s/.test(text[j])) j++; plain(text.slice(i, j)); i = j; continue }
            plain(ch); i++
          }
          return out
        }

        const scanYaml = (text, state) => {
          const out = []
          const n = text.length
          const plain = (s, c) => { if (s) out.push({ t: s, c: c || null }) }
          let i = 0
          const dm = /^(---|\.\.\.)(?:\s|$)/.exec(text)
          if (dm) { out.push({ t: dm[1], c: 'kw' }); i = dm[1].length }
          while (i < n) {
            const ch = text[i]
            if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) { out.push({ t: text.slice(i), c: 'com' }); i = n; break }
            if (ch === '"' || ch === "'") {
              const end = text.indexOf(ch, i + 1)
              if (end < 0) { out.push({ t: text.slice(i), c: 'str' }); i = n; break }
              let cls = 'str'
              if (/^\s*:(\s|$)/.test(text.slice(end + 1))) cls = 'key'
              out.push({ t: text.slice(i, end + 1), c: cls })
              i = end + 1
              continue
            }
            if (ch === '&' || ch === '*') {
              const m = /^[&*][A-Za-z0-9_-]+/.exec(text.slice(i))
              if (m) { out.push({ t: m[0], c: 'const' }); i += m[0].length; continue }
            }
            if ((ch === '|' || ch === '>') && /^[|>][+-]?\d*[+-]?(?:\s|$)/.test(text.slice(i))) {
              out.push({ t: text[i], c: 'op' }); i++; continue
            }
            if (/[A-Za-z_]/.test(ch)) {
              const km = /^[A-Za-z_][\w-]*(?:\s+[A-Za-z_][\w-]*)*\s*:/.exec(text.slice(i))
              if (km) {
                const colonAt = km[0].lastIndexOf(':')
                const pre = km[0].slice(0, colonAt)
                const sm = /^(.*?)(\s*)$/.exec(pre)
                out.push({ t: sm[1], c: 'key' })
                if (sm[2]) plain(sm[2])
                out.push({ t: ':', c: 'op' })
                i += km[0].length
                continue
              }
            }
            const sm = /^(true|false|null|~|yes|no|on|off)(?=\s|$)/.exec(text.slice(i))
            if (sm) { out.push({ t: sm[0], c: 'const' }); i += sm[0].length; continue }
            const nm = /^-?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i))
            if (nm) { out.push({ t: nm[0], c: 'num' }); i += nm[0].length; continue }
            if (ch === '-') {
              if (/^-\s/.test(text.slice(i))) { out.push({ t: '-', c: 'op' }); i++; continue }
              // negative number fallback
            }
            if (ch === ':') { out.push({ t: ':', c: 'op' }); i++; continue }
            if ('{}[],'.indexOf(ch) >= 0) { out.push({ t: ch, c: 'op' }); i++; continue }
            if (/\s/.test(ch)) { let j = i; while (j < n && /\s/.test(text[j])) j++; plain(text.slice(i, j)); i = j; continue }
            // tag prefix !tag
            if (ch === '!') {
              const m = /^![\w-]*/.exec(text.slice(i))
              if (m) { out.push({ t: m[0], c: 'op' }); i += m[0].length; continue }
            }
            plain(ch); i++
          }
          return out
        }

        const scanToml = (text, state) => {
          const out = []
          const n = text.length
          const plain = (s, c) => { if (s) out.push({ t: s, c: c || null }) }
          let i = 0
          state.mode = state.mode || null
          if (state.mode === 'str3') {
            const end = text.indexOf(state.delim)
            if (end < 0) { out.push({ t: text, c: 'str' }); return out }
            out.push({ t: text.slice(0, end + state.delim.length), c: 'str' })
            i = end + state.delim.length
            state.mode = null
            state.delim = null
          }
          while (i < n) {
            const ch = text[i]
            if (ch === '#') { out.push({ t: text.slice(i), c: 'com' }); i = n; break }
            if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
              const delim = text.slice(i, i + 3)
              const end = text.indexOf(delim, i + 3)
              if (end < 0) { out.push({ t: text.slice(i), c: 'str' }); state.mode = 'str3'; state.delim = delim; return out }
              out.push({ t: text.slice(i, end + 3), c: 'str' })
              i = end + 3
              continue
            }
            if (ch === '"' || ch === "'") {
              const end = text.indexOf(ch, i + 1)
              let cls = 'str'
              if (end >= 0 && /^\s*=/.test(text.slice(end + 1))) cls = 'key'
              if (end < 0) { out.push({ t: text.slice(i), c: cls }); i = n; break }
              out.push({ t: text.slice(i, end + 1), c: cls })
              i = end + 1
              continue
            }
            if (ch === '[') {
              const m = /^\[\[?[A-Za-z0-9_.\-\s]+\]?\]/.exec(text.slice(i))
              if (m) { out.push({ t: m[0], c: 'key' }); i += m[0].length; continue }
              out.push({ t: '[', c: 'op' }); i++; continue
            }
            if (/[A-Za-z_]/.test(ch)) {
              const km = /^[A-Za-z_][\w-]*(\s*\.\s*[A-Za-z_][\w-]*)*\s*=/.exec(text.slice(i))
              if (km) {
                const eq = km[0].lastIndexOf('=')
                const pre = km[0].slice(0, eq)
                const sm = /^(.*?)(\s*)$/.exec(pre)
                out.push({ t: sm[1], c: 'key' })
                if (sm[2]) plain(sm[2])
                out.push({ t: '=', c: 'op' })
                i += km[0].length
                continue
              }
            }
            const dtm = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/.exec(text.slice(i))
            if (dtm) { out.push({ t: dtm[0], c: 'num' }); i += dtm[0].length; continue }
            const nm = /^[+-]?(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
            if (nm) { out.push({ t: nm[0], c: 'num' }); i += nm[0].length; continue }
            const bm = /^(true|false)(?=\s|$)/.exec(text.slice(i))
            if (bm) { out.push({ t: bm[0], c: 'const' }); i += bm[0].length; continue }
            if ('=,{}]'.indexOf(ch) >= 0) { out.push({ t: ch, c: 'op' }); i++; continue }
            if (/\s/.test(ch)) { let j = i; while (j < n && /\s/.test(text[j])) j++; plain(text.slice(i, j)); i = j; continue }
            if (/[A-Za-z_]/.test(ch)) {
              const wm = /^[A-Za-z_][\w-]*/.exec(text.slice(i))
              const w = wm[0]
              out.push({ t: w, c: (w === 'inf' || w === 'nan') ? 'const' : null })
              i += w.length
              continue
            }
            plain(ch); i++
          }
          return out
        }

        const mdInline = (text, out) => {
          const n = text.length
          const plain = (s, c) => { if (s) out.push({ t: s, c: c || null }) }
          let i = 0
          while (i < n) {
            const ch = text[i]
            if (ch === '`') {
              const end = text.indexOf('`', i + 1)
              if (end < 0) { plain(text.slice(i)); break }
              out.push({ t: text.slice(i, end + 1), c: 'codei' })
              i = end + 1
              continue
            }
            if (ch === '*' && text[i + 1] === '*') {
              const end = text.indexOf('**', i + 2)
              if (end < 0) { plain(text.slice(i)); break }
              out.push({ t: '**', c: 'op' })
              if (end > i + 2) out.push({ t: text.slice(i + 2, end), c: 'strong' })
              out.push({ t: '**', c: 'op' })
              i = end + 2
              continue
            }
            if ((ch === '*' || ch === '_') && text[i + 1] !== ch) {
              const end = text.indexOf(ch, i + 1)
              if (end > i + 1 && end < i + 80) {
                out.push({ t: ch, c: 'op' })
                out.push({ t: text.slice(i + 1, end), c: 'strong' })
                out.push({ t: ch, c: 'op' })
                i = end + 1
                continue
              }
            }
            if (ch === '[') {
              const mm = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(text.slice(i))
              if (mm) {
                out.push({ t: '[', c: 'op' })
                out.push({ t: mm[1], c: 'str' })
                out.push({ t: '](', c: 'op' })
                out.push({ t: mm[2], c: 'fn' })
                out.push({ t: ')', c: 'op' })
                i += mm[0].length
                continue
              }
            }
            plain(ch); i++
          }
        }
        const MD_ALIAS = { py: 'python', js: 'javascript', ts: 'typescript', cpp: 'cpp', 'c++': 'cpp', cs: 'csharp', sh: 'bash', ps1: 'powershell', rb: 'ruby', kt: 'kotlin', yml: 'yaml' }
        const scanMd = (text, state) => {
          const out = []
          const plain = (s, c) => { if (s) out.push({ t: s, c: c || null }) }
          state.mode = state.mode || null
          if (state.mode === 'code') {
            if (/^(```|~~~)/.test(text)) { out.push({ t: text, c: 'kw' }); state.mode = null; state.codeLang = null; state.innerState = null; return out }
            const inner = state.codeLang ? lineTokens(text, state.codeLang, state.innerState) : null
            if (inner) { for (const t of inner) out.push(t) }
            else out.push({ t: text, c: 'code' })
            return out
          }
          const fence = /^(```|~~~)\s*([\w.+-]*)(.*)$/.exec(text)
          if (fence) {
            out.push({ t: fence[1] + fence[2], c: 'kw' })
            if (fence[3]) out.push({ t: fence[3], c: 'com' })
            state.mode = 'code'
            let info = (fence[2] || '').toLowerCase()
            if (MD_ALIAS[info]) info = MD_ALIAS[info]
            state.codeLang = (HL_LANGS[info] || HL_SCANNERS[info]) ? info : null
            state.innerState = state.codeLang ? { mode: null } : null
            return out
          }
          const hd = /^(#{1,6})(\s+)(.*)$/.exec(text)
          if (hd) { out.push({ t: hd[1] + hd[2], c: 'kw' }); mdInline(hd[3], out); return out }
          const bq = /^(\s*>\s?)(.*)$/.exec(text)
          if (bq) { out.push({ t: bq[1], c: 'op' }); mdInline(bq[2], out); return out }
          if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(text)) { out.push({ t: text, c: 'op' }); return out }
          const li = /^(\s*)([-+*]|\d+[.)])(\s+)(.*)$/.exec(text)
          if (li) { plain(li[1]); out.push({ t: li[2], c: 'num' }); plain(li[3]); mdInline(li[4], out); return out }
          mdInline(text, out)
          return out
        }

        const HL_SCANNERS = { html: scanHtml, xml: scanHtml, css: scanCss, yaml: scanYaml, toml: scanToml, markdown: scanMd }
        const lineTokens = (text, langId, state) => {
          const sp = HL_SCANNERS[langId]
          if (sp) return sp(text, state)
          const cfg = HL_LANGS[langId]
          return cfg ? tokenize(text, cfg, state) : null
        }
        // Small cache for state-clean lines: renders happen on every hunk
        // hover, so re-tokenizing each line every time would be wasteful.
        const HL_CACHE = new Map()
        const lineTokensCached = (text, langId, state) => {
          if (!langId) return null
          const cleanIn = !state.mode
          const ck = langId + '\u0001' + text
          if (cleanIn && HL_CACHE.has(ck)) return HL_CACHE.get(ck)
          const toks = lineTokens(text, langId, state)
          if (cleanIn && !state.mode) {
            if (HL_CACHE.size > 4000) HL_CACHE.delete(HL_CACHE.keys().next().value)
            HL_CACHE.set(ck, toks)
          }
          return toks
        }
        // Live-editing sync: after the browser mutates a contentEditable line,
        // the pointer-events:none highlight layer below must mirror the new
        // text (imperative, no React render involved).
        const syncHl = (el) => {
          try {
            const wrap = el && el.parentNode
            if (!wrap) return
            const hl = wrap.querySelector('.dsh-fe-hl')
            if (!hl) return
            const text = (el.textContent || '').replace(/\n/g, '')
            const langId = hl.getAttribute('data-lang') || ''
            const toks = langId ? lineTokensCached(text, langId, { mode: null }) : null
            hl.textContent = ''
            if (toks) {
              for (const t of toks) {
                const s = document.createElement('span')
                s.className = 'dsh-fe-tk' + (t.c ? ' dsh-fe-tk-' + t.c : '')
                s.textContent = t.t
                hl.append(s)
              }
            } else {
              hl.textContent = text
            }
          } catch (e) {}
        }

        const LANG_BY_EXT = {
          py: 'python', pyw: 'python',
          java: 'java',
          js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
          ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
          c: 'c', h: 'c',
          cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', inl: 'cpp',
          cs: 'csharp', go: 'go', rs: 'rust',
          php: 'php', rb: 'ruby', swift: 'swift',
          kt: 'kotlin', kts: 'kotlin',
          r: 'r',
          sh: 'bash', bash: 'bash', zsh: 'bash',
          ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
          sql: 'sql',
          html: 'html', htm: 'html',
          css: 'css',
          json: 'json',
          yaml: 'yaml', yml: 'yaml',
          toml: 'toml',
          xml: 'xml', svg: 'xml', xhtml: 'xml',
          md: 'markdown', markdown: 'markdown',
        }
        const langOf = (path) => {
          if (!path) return null
          const base = path.split('/').pop() || ''
          const dot = base.lastIndexOf('.')
          if (dot < 0) {
            if (base === 'Makefile' || base === 'Rakefile' || base === 'Gemfile') return 'bash'
            return null
          }
          const ext = base.slice(dot + 1).toLowerCase()
          return LANG_BY_EXT[ext] || null
        }

        // ---------- markdown rendering (v1.9) ----------
        // markdown-it v15.0.0 (MIT, https://github.com/markdown-it/markdown-it) —
        // vendored browser UMD build; linkify-it/mdurl/uc.micro bundled inside.
        // Loaded fully offline: zero network requests, no CDN, no external
        // service. The default preset adds GFM tables + strikethrough.
        // ==== markdown-it vendored (do not edit) ====
        // markdown-it v15.0.0 — Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin.
        // MIT License — https://github.com/markdown-it/markdown-it/blob/master/LICENSE
        // Bundled inside this UMD build: linkify-it (c) 2015 Vitaly Puzrin,
        // mdurl (c) 2015 Vitaly Puzrin, Alex Kocharin, uc.micro (c) 2015
        // Vitaly Puzrin — all MIT. Full license texts: THIRD_PARTY_LICENSES.md.
        const MarkdownIt = (() => {
          // Local CommonJS shim: the vendored UMD build picks its CommonJS
          // branch only when it SEES `module` — without this shim the browser
          // (no module global) routes it to the `globalThis.markdownit`
          // branch and the `return module.exports` below throws
          // "module is not defined", killing the loader entry.
          const module = { exports: {} }
          const exports = module.exports
          ;(function(e,t){typeof exports==`object`&&typeof module<`u`?module.exports=t():typeof define==`function`&&define.amd?define([],t):(e=typeof globalThis<`u`?globalThis:e||self,e.markdownit=t())})(this,function(){var e=Object.defineProperty,t=(t,n)=>{let r={};for(var i in t)e(r,i,{get:t[i],enumerable:!0});return n||e(r,Symbol.toStringTag,{value:`Module`}),r},n={};function r(e){let t=n[e];if(t)return t;t=n[e]=[];for(let e=0;e<128;e++){let n=String.fromCharCode(e);t.push(n)}for(let n=0;n<e.length;n++){let r=e.charCodeAt(n);t[r]=`%`+(`0`+r.toString(16).toUpperCase()).slice(-2)}return t}function i(e,t){typeof t!=`string`&&(t=i.defaultChars);let n=r(t);return e.replace(/(%[a-f0-9]{2})+/gi,function(e){let t=``;for(let r=0,i=e.length;r<i;r+=3){let a=parseInt(e.slice(r+1,r+3),16);if(a<128){t+=n[a];continue}if((a&224)==192&&r+3<i){let n=parseInt(e.slice(r+4,r+6),16);if((n&192)==128){let e=a<<6&1984|n&63;t+=e<128?`��`:String.fromCharCode(e),r+=3;continue}}if((a&240)==224&&r+6<i){let n=parseInt(e.slice(r+4,r+6),16),i=parseInt(e.slice(r+7,r+9),16);if((n&192)==128&&(i&192)==128){let e=a<<12&61440|n<<6&4032|i&63;t+=e<2048||e>=55296&&e<=57343?`���`:String.fromCharCode(e),r+=6;continue}}if((a&248)==240&&r+9<i){let n=parseInt(e.slice(r+4,r+6),16),i=parseInt(e.slice(r+7,r+9),16),o=parseInt(e.slice(r+10,r+12),16);if((n&192)==128&&(i&192)==128&&(o&192)==128){let e=a<<18&1835008|n<<12&258048|i<<6&4032|o&63;e<65536||e>1114111?t+=`����`:(e-=65536,t+=String.fromCharCode(55296+(e>>10),56320+(e&1023))),r+=9;continue}}t+=`�`}return t})}i.defaultChars=`;/?:@&=+$,#`,i.componentChars=``;var a={};function o(e){let t=a[e];if(t)return t;t=a[e]=[];for(let e=0;e<128;e++){let n=String.fromCharCode(e);/^[0-9a-z]$/i.test(n)?t.push(n):t.push(`%`+(`0`+e.toString(16).toUpperCase()).slice(-2))}for(let n=0;n<e.length;n++)t[e.charCodeAt(n)]=e[n];return t}function s(e,t,n){typeof t!=`string`&&(n=t,t=s.defaultChars),n===void 0&&(n=!0);let r=o(t),i=``;for(let t=0,a=e.length;t<a;t++){let o=e.charCodeAt(t);if(n&&o===37&&t+2<a&&/^[0-9a-f]{2}$/i.test(e.slice(t+1,t+3))){i+=e.slice(t,t+3),t+=2;continue}if(o<128){i+=r[o];continue}if(o>=55296&&o<=57343){if(o>=55296&&o<=56319&&t+1<a){let n=e.charCodeAt(t+1);if(n>=56320&&n<=57343){i+=encodeURIComponent(e[t]+e[t+1]),t++;continue}}i+=`%EF%BF%BD`;continue}i+=encodeURIComponent(e[t])}return i}s.defaultChars=`;/?:@&=+$,-_.!~*'()#`,s.componentChars=`-_.!~*'()`;function c(e){let t=``;return t+=e.protocol||``,t+=e.slashes?`//`:``,t+=e.auth?e.auth+`@`:``,e.hostname&&e.hostname.indexOf(`:`)!==-1?t+=`[`+e.hostname+`]`:t+=e.hostname||``,t+=e.port?`:`+e.port:``,t+=e.pathname||``,t+=e.search||``,t+=e.hash||``,t}function l(){this.protocol=null,this.slashes=null,this.auth=null,this.port=null,this.hostname=null,this.hash=null,this.search=null,this.pathname=null}var u=/^([a-z0-9.+-]+:)/i,d=/:[0-9]*$/,f=/^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/,p=[`%`,`/`,`?`,`;`,`#`,`'`,`{`,`}`,`|`,`\\`,`^`,"`",`<`,`>`,`"`,"`",` `,`\r`,`
`,`	`],m=[`/`,`?`,`#`],h=255,g=/^[+a-z0-9A-Z_-]{0,63}$/,_=/^([+a-z0-9A-Z_-]{0,63})(.*)$/,v={javascript:!0,"javascript:":!0},y={http:!0,https:!0,ftp:!0,gopher:!0,file:!0,"http:":!0,"https:":!0,"ftp:":!0,"gopher:":!0,"file:":!0};function b(e,t){if(e&&e instanceof l)return e;let n=new l;return n.parse(e,t),n}l.prototype.parse=function(e,t){let n,r,i,a=e;if(a=a.trim(),!t&&e.split(`#`).length===1){let e=f.exec(a);if(e)return this.pathname=e[1],e[2]&&(this.search=e[2]),this}let o=u.exec(a);if(o&&(o=o[0],n=o.toLowerCase(),this.protocol=o,a=a.substr(o.length)),(t||o||a.match(/^\/\/[^@\/]+@[^@\/]+/))&&(i=a.substr(0,2)===`//`,i&&!(o&&v[o])&&(a=a.substr(2),this.slashes=!0)),!v[o]&&(i||o&&!y[o])){let e=-1;for(let t=0;t<m.length;t++)r=a.indexOf(m[t]),r!==-1&&(e===-1||r<e)&&(e=r);let t,n;n=e===-1?a.lastIndexOf(`@`):a.lastIndexOf(`@`,e),n!==-1&&(t=a.slice(0,n),a=a.slice(n+1),this.auth=t),e=-1;for(let t=0;t<p.length;t++)r=a.indexOf(p[t]),r!==-1&&(e===-1||r<e)&&(e=r);e===-1&&(e=a.length),a[e-1]===`:`&&e--;let i=a.slice(0,e);a=a.slice(e),this.parseHost(i),this.hostname=this.hostname||``;let o=this.hostname[0]===`[`&&this.hostname[this.hostname.length-1]===`]`;if(!o){let e=this.hostname.split(/\./);for(let t=0,n=e.length;t<n;t++){let n=e[t];if(n&&!n.match(g)){let r=``;for(let e=0,t=n.length;e<t;e++)n.charCodeAt(e)>127?r+=`x`:r+=n[e];if(!r.match(g)){let r=e.slice(0,t),i=e.slice(t+1),o=n.match(_);o&&(r.push(o[1]),i.unshift(o[2])),i.length&&(a=i.join(`.`)+a),this.hostname=r.join(`.`);break}}}}this.hostname.length>h&&(this.hostname=``),o&&(this.hostname=this.hostname.substr(1,this.hostname.length-2))}let s=a.indexOf(`#`);s!==-1&&(this.hash=a.substr(s),a=a.slice(0,s));let c=a.indexOf(`?`);return c!==-1&&(this.search=a.substr(c),a=a.slice(0,c)),a&&(this.pathname=a),y[n]&&this.hostname&&!this.pathname&&(this.pathname=``),this},l.prototype.parseHost=function(e){let t=d.exec(e);t&&(t=t[0],t!==`:`&&(this.port=t.substr(1)),e=e.substr(0,e.length-t.length)),e&&(this.hostname=e)};var ee=t({decode:()=>i,encode:()=>s,format:()=>c,parse:()=>b}),te=t({Any:()=>x,Cc:()=>ne,Cf:()=>re,P:()=>S,S:()=>ie,Z:()=>ae}),x=/[\0-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/,ne=/[\0-\x1F\x7F-\x9F]/,re=/[\xAD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|\uD804[\uDCBD\uDCCD]|\uD80D[\uDC30-\uDC3F]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|\uDB40[\uDC01\uDC20-\uDC7F]/,S=/[!-#%-\*,-\/:;\?@\[-\]_\{\}\xA1\xA7\xAB\xB6\xB7\xBB\xBF\u037E\u0387\u055A-\u055F\u0589\u058A\u05BE\u05C0\u05C3\u05C6\u05F3\u05F4\u0609\u060A\u060C\u060D\u061B\u061D-\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B\u169C\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B4E\u1B4F\u1B5A-\u1B60\u1B7D-\u1B7F\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D\u207E\u208D\u208E\u2308-\u230B\u2329\u232A\u2768-\u2775\u27C5\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC\u29FD\u2CF9-\u2CFC\u2CFE\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52-\u2E5D\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA95F\uA9C1-\uA9CD\uA9DE\uA9DF\uAA5C-\uAA5F\uAADE\uAADF\uAAF0\uAAF1\uABEB\uFD3E\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A\uFF1B\uFF1F\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65]|\uD800[\uDD00-\uDD02\uDF9F\uDFD0]|\uD801\uDD6F|\uD802[\uDC57\uDD1F\uDD3F\uDE50-\uDE58\uDE7F\uDEF0-\uDEF6\uDF39-\uDF3F\uDF99-\uDF9C]|\uD803[\uDD6E\uDEAD\uDED0\uDF55-\uDF59\uDF86-\uDF89]|\uD804[\uDC47-\uDC4D\uDCBB\uDCBC\uDCBE-\uDCC1\uDD40-\uDD43\uDD74\uDD75\uDDC5-\uDDC8\uDDCD\uDDDB\uDDDD-\uDDDF\uDE38-\uDE3D\uDEA9\uDFD4\uDFD5\uDFD7\uDFD8]|\uD805[\uDC4B-\uDC4F\uDC5A\uDC5B\uDC5D\uDCC6\uDDC1-\uDDD7\uDE41-\uDE43\uDE60-\uDE6C\uDEB9\uDF3C-\uDF3E]|\uD806[\uDC3B\uDD44-\uDD46\uDDE2\uDE3F-\uDE46\uDE9A-\uDE9C\uDE9E-\uDEA2\uDF00-\uDF09\uDFE1]|\uD807[\uDC41-\uDC45\uDC70\uDC71\uDEF7\uDEF8\uDF43-\uDF4F\uDFFF]|\uD809[\uDC70-\uDC74]|\uD80B[\uDFF1\uDFF2]|\uD81A[\uDE6E\uDE6F\uDEF5\uDF37-\uDF3B\uDF44]|\uD81B[\uDD6D-\uDD6F\uDE97-\uDE9A\uDFE2]|\uD82F\uDC9F|\uD836[\uDE87-\uDE8B]|\uD839\uDDFF|\uD83A[\uDD5E\uDD5F]/,ie=/[\$\+<->\^`\|~\xA2-\xA6\xA8\xA9\xAC\xAE-\xB1\xB4\xB8\xD7\xF7\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0384\u0385\u03F6\u0482\u058D-\u058F\u0606-\u0608\u060B\u060E\u060F\u06DE\u06E9\u06FD\u06FE\u07F6\u07FE\u07FF\u0888\u09F2\u09F3\u09FA\u09FB\u0AF1\u0B70\u0BF3-\u0BFA\u0C7F\u0D4F\u0D79\u0E3F\u0F01-\u0F03\u0F13\u0F15-\u0F17\u0F1A-\u0F1F\u0F34\u0F36\u0F38\u0FBE-\u0FC5\u0FC7-\u0FCC\u0FCE\u0FCF\u0FD5-\u0FD8\u109E\u109F\u1390-\u1399\u166D\u17DB\u1940\u19DE-\u19FF\u1B61-\u1B6A\u1B74-\u1B7C\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u2044\u2052\u207A-\u207C\u208A-\u208C\u20A0-\u20C1\u2100\u2101\u2103-\u2106\u2108\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u212E\u213A\u213B\u2140-\u2144\u214A-\u214D\u214F\u218A\u218B\u2190-\u2307\u230C-\u2328\u232B-\u2429\u2440-\u244A\u249C-\u24E9\u2500-\u2767\u2794-\u27C4\u27C7-\u27E5\u27F0-\u2982\u2999-\u29D7\u29DC-\u29FB\u29FE-\u2B73\u2B76-\u2BFF\u2CE5-\u2CEA\u2E50\u2E51\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFF\u3004\u3012\u3013\u3020\u3036\u3037\u303E\u303F\u309B\u309C\u3190\u3191\u3196-\u319F\u31C0-\u31E5\u31EF\u3200-\u321E\u322A-\u3247\u3250\u3260-\u327F\u328A-\u32B0\u32C0-\u33FF\u4DC0-\u4DFF\uA490-\uA4C6\uA700-\uA716\uA720\uA721\uA789\uA78A\uA828-\uA82B\uA836-\uA839\uAA77-\uAA79\uAB5B\uAB6A\uAB6B\uFB29\uFBB2-\uFBD2\uFD40-\uFD4F\uFD90\uFD91\uFDC8-\uFDCF\uFDFC-\uFDFF\uFE62\uFE64-\uFE66\uFE69\uFF04\uFF0B\uFF1C-\uFF1E\uFF3E\uFF40\uFF5C\uFF5E\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFFC\uFFFD]|\uD800[\uDD37-\uDD3F\uDD79-\uDD89\uDD8C-\uDD8E\uDD90-\uDD9C\uDDA0\uDDD0-\uDDFC]|\uD802[\uDC77\uDC78\uDEC8]|\uD803[\uDD8E\uDD8F\uDED1-\uDED8]|\uD805\uDF3F|\uD807[\uDFD5-\uDFF1]|\uD81A[\uDF3C-\uDF3F\uDF45]|\uD82F\uDC9C|\uD833[\uDC00-\uDCEF\uDCFA-\uDCFC\uDD00-\uDEB3\uDEBA-\uDED0\uDEE0-\uDEF0\uDF50-\uDFC3]|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD64\uDD6A-\uDD6C\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDEA\uDE00-\uDE41\uDE45\uDF00-\uDF56]|\uD835[\uDEC1\uDEDB\uDEFB\uDF15\uDF35\uDF4F\uDF6F\uDF89\uDFA9\uDFC3]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85\uDE86]|\uD838[\uDD4F\uDEFF]|\uD83B[\uDCAC\uDCB0\uDD2E\uDEF0\uDEF1]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD0D-\uDDAD\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED8\uDEDC-\uDEEC\uDEF0-\uDEFC\uDF00-\uDFD9\uDFE0-\uDFEB\uDFF0]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDCB0-\uDCBB\uDCC0\uDCC1\uDCD0-\uDCD8\uDD00-\uDE57\uDE60-\uDE6D\uDE70-\uDE7C\uDE80-\uDE8A\uDE8E-\uDEC6\uDEC8\uDECD-\uDEDC\uDEDF-\uDEEA\uDEEF-\uDEF8\uDF00-\uDF92\uDF94-\uDFEF\uDFFA]/,ae=/[ \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/,oe=new Map([[0,65533],[128,8364],[130,8218],[131,402],[132,8222],[133,8230],[134,8224],[135,8225],[136,710],[137,8240],[138,352],[139,8249],[140,338],[142,381],[145,8216],[146,8217],[147,8220],[148,8221],[149,8226],[150,8211],[151,8212],[152,732],[153,8482],[154,353],[155,8250],[156,339],[158,382],[159,376]]);function se(e){var t;return e>=55296&&e<=57343||e>1114111?65533:(t=oe.get(e))==null?e:t}function ce(e){let t=atob(e),n=t.length&-2,r=new Uint16Array(n/2);for(let e=0,i=0;e<n;e+=2){let n=t.charCodeAt(e),a=t.charCodeAt(e+1);r[i++]=n|a<<8}return r}var le=ce(`QR08ALkAAgH6AYsDNQR2BO0EPgXZBQEGLAbdBxMISQrvCmQLfQurDKQNLw4fD4YPpA+6D/IPAAAAAAAAAAAAAAAAKhBMEY8TmxUWF2EYLBkxGuAa3RsJHDscWR8YIC8jSCSIJcMl6ie3Ku8rEC0CLjoupS7kLgAIRU1hYmNmZ2xtbm9wcnN0dVQAWgBeAGUAaQBzAHcAfgCBAIQAhwCSAJoAoACsALMAbABpAGcAO4DGAMZAUAA7gCYAJkBjAHUAdABlADuAwQDBQHIiZXZlAAJhAAFpeW0AcgByAGMAO4DCAMJAEGRyAADgNdgE3XIAYQB2AGUAO4DAAMBA8CFoYZFj4SFjcgBhZAAAoFMqAAFncIsAjgBvAG4ABGFmAADgNdg43fAlbHlGdW5jdGlvbgCgYSBpAG4AZwA7gMUAxUAAAWNzpACoAHIAAOA12Jzc6SFnbgCgVCJpAGwAZABlADuAwwDDQG0AbAA7gMQAxEAABGFjZWZvcnN1xQDYANoA7QDxAPYA+QD8AAABY3LJAM8AayNzbGFzaAAAoBYidgHTANUAAKDnKmUAZAAAoAYjeQARZIABY3J0AOAA5QDrAGEidXNlAACgNSLuI291bGxpcwCgLCFhAJJjcgAA4DXYBd1wAGYAAOA12Dnd5SF2ZdhiYwDyAOoAbSJwZXEAAKBOIgAHSE9hY2RlZmhpbG9yc3UXARoBHwE6AVIBVQFiAWQBZgGCAakB6QHtAfIBYwB5ACdkUABZADuAqQCpQIABY3B5ACUBKAE1AfUhdGUGYWmg0iJ0KGFsRGlmZmVyZW50aWFsRAAAoEUhbCJleXMAAKAtIQACYWVpb0EBRAFKAU0B8iFvbgxhZABpAGwAO4DHAMdAcgBjAAhhbiJpbnQAAKAwIm8AdAAKYQABZG5ZAV0BaSJsbGEAuGB0I2VyRG90ALdg8gA5AWkAp2NyImNsZQAAAkRNUFRwAXQBeQF9AW8AdAAAoJkiaSJudXMAAKCWIuwhdXMAoJUiaSJtZXMAAKCXIm8AAAFjc4cBlAFrKndpc2VDb250b3VySW50ZWdyYWwAAKAyImUjQ3VybHkAAAFEUZwBpAFvJXVibGVRdW90ZQAAoB0gdSJvdGUAAKAZIAACbG5wdbABtgHNAdgBbwBuAGWgNyIAoHQqgAFnaXQAvAHBAcUB8iJ1ZW50AKBhIm4AdAAAoC8i7yV1ckludGVncmFsAKAuIgABZnLRAdMBAKACIe8iZHVjdACgECJuLnRlckNsb2Nrd2lzZUNvbnRvdXJJbnRlZ3JhbAAAoDMi7yFzcwCgLypjAHIAAOA12J7ccABDoNMiYQBwAACgTSKABURKU1phY2VmaW9zAAsCEgIVAhgCGwIsAjQCOQI9AnMCfwNvoEUh9CJyYWhkAKARKWMAeQACZGMAeQAFZGMAeQAPZIABZ3JzACECJQIoAuchZXIAoCEgcgAAoKEhaAB2AACg5CoAAWF5MAIzAvIhb24OYRRkbAB0oAciYQCUY3IAAOA12AfdAAFhZkECawIAAWNtRQJnAvIjaXRpY2FsAAJBREdUUAJUAl8CYwJjInV0ZQC0YG8AdAFZAloC2WJiJGxlQWN1dGUA3WJyImF2ZQBgYGkibGRlANxi7yFuZACgxCJmJWVyZW50aWFsRAAAoEYhcAR9AgAAAAAAAIECjgIAABoDZgAA4DXYO91EoagAhQKJAm8AdAAAoNwgcSJ1YWwAAKBQIuIhbGUAA0NETFJVVpkCqAK1Au8C/wIRA28AbgB0AG8AdQByAEkAbgB0AGUAZwByAGEA7ADEAW8AdAKvAgAAAACwAqhgbiNBcnJvdwAAoNMhAAFlb7kC0AJmAHQAgAFBUlQAwQLGAs0CciJyb3cAAKDQIekkZ2h0QXJyb3cAoNQhZQDlACsCbgBnAAABTFLWAugC5SFmdAABQVLcAuECciJyb3cAAKD4J+kkZ2h0QXJyb3cAoPon6SRnaHRBcnJvdwCg+SdpImdodAAAAUFU9gL7AnIicm93AACg0iFlAGUAAKCoInAAQQIGAwAAAAALA3Iicm93AACg0SFvJHduQXJyb3cAAKDVIWUlcnRpY2FsQmFyAACgJSJuAAADQUJMUlRhJAM2AzoDWgNxA3oDciJyb3cAAKGTIUJVLAMwA2EAcgAAoBMpcCNBcnJvdwAAoPUhciJldmUAEWPlIWZ00gJDAwAASwMAAFIDaSVnaHRWZWN0b3IAAKBQKWUkZVZlY3RvcgAAoF4p5SJjdG9yQqC9IWEAcgAAoFYpaSJnaHQA1AFiAwAAaQNlJGVWZWN0b3IAAKBfKeUiY3RvckKgwSFhAHIAAKBXKWUAZQBBoKQiciJyb3cAAKCnIXIAcgBvAPcAtAIAAWN0gwOHA3IAAOA12J/c8iFvaxBhAAhOVGFjZGZnbG1vcHFzdHV4owOlA6kDsAO/A8IDxgPNA9ID8gP9AwEEFAQeBCAEJQRHAEphSAA7gNAA0EBjAHUAdABlADuAyQDJQIABYWl5ALYDuQO+A/Ihb24aYXIAYwA7gMoAykAtZG8AdAAWYXIAAOA12AjdcgBhAHYAZQA7gMgAyEDlIm1lbnQAoAgiAAFhcNYD2QNjAHIAEmF0AHkAUwLhAwAAAADpA20lYWxsU3F1YXJlAACg+yVlJ3J5U21hbGxTcXVhcmUAAKCrJQABZ3D2A/kDbwBuABhhZgAA4DXYPN3zImlsb26VY3UAAAFhaQYEDgRsAFSgdSppImxkZQAAoEIi7CNpYnJpdW0AoMwhAAFjaRgEGwRyAACgMCFtAACgcyphAJdjbQBsADuAywDLQAABaXApBC0E8yF0cwCgAyLvJG5lbnRpYWxFAKBHIYACY2Zpb3MAPQQ/BEMEXQRyBHkAJGRyAADgNdgJ3WwibGVkAFMCTAQAAAAAVARtJWFsbFNxdWFyZQAAoPwlZSdyeVNtYWxsU3F1YXJlAACgqiVwA2UEAABpBAAAAABtBGYAAOA12D3dwSFsbACgACLyI2llcnRyZgCgMSFjAPIAcQQABkpUYWJjZGZnb3JzdIgEiwSOBJMElwSkBKcEqwStBLIE5QTqBGMAeQADZDuAPgA+QO0hbWFkoJMD3GNyImV2ZQAeYYABZWl5AJ0EoASjBOQhaWwiYXIAYwAcYRNkbwB0ACBhcgAA4DXYCt0AoNkicABmAADgNdg+3eUiYXRlcgADRUZHTFNUvwTIBM8E1QTZBOAEcSJ1YWwATKBlIuUhc3MAoNsidSRsbEVxdWFsAACgZyJyI2VhdGVyAACgoirlIXNzAKB3IuwkYW50RXF1YWwAoH4qaSJsZGUAAKBzImMAcgAA4DXYotwAoGsiAARBYWNmaW9zdfkE/QQFBQgFCwUTBSIFKwVSIkRjeQAqZAABY3QBBQQFZQBrAMdiXmDpIXJjJGFyAACgDCFsJWJlcnRTcGFjZQAAoAsh8AEYBQAAGwVmAACgDSHpJXpvbnRhbExpbmUAoAAlAAFjdCYFKAXyABIF8iFvayZhbQBwAEQBMQU5BW8AdwBuAEgAdQBtAPAAAAFxInVhbAAAoE8iAAdFSk9hY2RmZ21ub3N0dVMFVgVZBVwFYwVtBXAFcwV6BZAFtgXFBckFzQVjAHkAFWTsIWlnMmFjAHkAAWRjAHUAdABlADuAzQDNQAABaXlnBWwFcgBjADuAzgDOQBhkbwB0ADBhcgAAoBEhcgBhAHYAZQA7gMwAzEAAoREhYXB/BYsFAAFjZ4MFhQVyACphaSNuYXJ5SQAAoEghbABpAGUA8wD6AvQBlQUAAKUFZaAsIgABZ3KaBZ4F8iFhbACgKyLzI2VjdGlvbgCgwiJpI3NpYmxlAAABQ1SsBbEFbyJtbWEAAKBjIGkibWVzAACgYiCAAWdwdAC8Bb8FwwVvAG4ALmFmAADgNdhA3WEAmWNjAHIAAKAQIWkibGRlAChh6wHSBQAA1QVjAHkABmRsADuAzwDPQIACY2Zvc3UA4QXpBe0F8gX9BQABaXnlBegFcgBjADRhGWRyAADgNdgN3XAAZgAA4DXYQd3jAfcFAAD7BXIAAOA12KXc8iFjeQhk6yFjeQRkgANISmFjZm9zAAwGDwYSBhUGHQYhBiYGYwB5ACVkYwB5AAxk8CFwYZpjAAFleRkGHAbkIWlsNmEaZHIAAOA12A7dcABmAADgNdhC3WMAcgAA4DXYptyABUpUYWNlZmxtb3N0AD0GQAZDBl4GawZkB2gHcAd0B80H2gdjAHkACWQ7gDwAPECAAmNtbnByAEwGTwZSBlUGWwb1IXRlOWHiIWRhm2NnAACg6ifsI2FjZXRyZgCgEiFyAACgniGAAWFleQBkBmcGagbyIW9uPWHkIWlsO2EbZAABZnNvBjQHdAAABUFDREZSVFVWYXKABp4GpAbGBssG3AYDByEHwQIqBwABbnKEBowGZyVsZUJyYWNrZXQAAKDoJ/Ihb3cAoZAhQlKTBpcGYQByAACg5CHpJGdodEFycm93AKDGIWUjaWxpbmcAAKAII28A9QGqBgAAsgZiJWxlQnJhY2tldAAAoOYnbgDUAbcGAAC+BmUkZVZlY3RvcgAAoGEp5SJjdG9yQqDDIWEAcgAAoFkpbCJvb3IAAKAKI2kiZ2h0AAABQVbSBtcGciJyb3cAAKCUIeUiY3RvcgCgTikAAWVy4AbwBmUAAKGjIkFW5gbrBnIicm93AACgpCHlImN0b3IAoFopaSNhbmdsZQBCorIi+wYAAAAA/wZhAHIAAKDPKXEidWFsAACgtCJwAIABRFRWAAoHEQcYB+8kd25WZWN0b3IAoFEpZSRlVmVjdG9yAACgYCnlImN0b3JCoL8hYQByAACgWCnlImN0b3JCoLwhYQByAACgUilpAGcAaAB0AGEAcgByAG8A9wDMAnMAAANFRkdMU1Q/B0cHTgdUB1gHXwfxJXVhbEdyZWF0ZXIAoNoidSRsbEVxdWFsAACgZiJyI2VhdGVyAACgdiLlIXNzAKChKuwkYW50RXF1YWwAoH0qaSJsZGUAAKByInIAAOA12A/dZaDYIuYjdGFycm93AKDaIWkiZG90AD9hgAFucHcAege1B7kHZwAAAkxSbHKCB5QHmwerB+UhZnQAAUFSiAeNB3Iicm93AACg9SfpJGdodEFycm93AKD3J+kkZ2h0QXJyb3cAoPYn5SFmdAABYXLcAqEHaQBnAGgAdABhAHIAcgBvAPcA5wJpAGcAaAB0AGEAcgByAG8A9wDuAmYAAOA12EPdZQByAAABTFK/B8YHZSRmdEFycm93AACgmSHpJGdodEFycm93AKCYIYABY2h0ANMH1QfXB/IAWgYAoLAh8iFva0FhAKBqIgAEYWNlZmlvc3XpB+wH7gf/BwMICQgOCBEIcAAAoAUpeQAcZAABZGzyB/kHaSR1bVNwYWNlAACgXyBsI2ludHJmAACgMyFyAADgNdgQ3e4jdXNQbHVzAKATInAAZgAA4DXYRN1jAPIA/gecY4AESmFjZWZvc3R1ACEIJAgoCDUIgQiFCDsKQApHCmMAeQAKZGMidXRlAENhgAFhZXkALggxCDQI8iFvbkdh5CFpbEVhHWSAAWdzdwA7CGEIfQjhInRpdmWAAU1UVgBECEwIWQhlJWRpdW1TcGFjZQAAoAsgaABpAAABY25SCFMIawBTAHAAYQBjAOUASwhlAHIAeQBUAGgAaQDuAFQI9CFlZAABR0xnCHUIcgBlAGEAdABlAHIARwByAGUAYQB0AGUA8gDrBGUAcwBzAEwAZQBzAPMA2wdMImluZQAKYHIAAOA12BHdAAJCbnB0jAiRCJkInAhyImVhawAAoGAgwiZyZWFraW5nU3BhY2WgYGYAAKAVIUOq7CqzCMIIzQgAAOcIGwkAAAAAAAAtCQAAbwkAAIcJAACdCcAJGQoAADQKAAFvdbYIvAjuI2dydWVudACgYiJwIkNhcAAAoG0ibyh1YmxlVmVydGljYWxCYXIAAKAmIoABbHF4ANII1wjhCOUibWVudACgCSL1IWFsVKBgImkibGRlAADgQiI4A2kic3RzAACgBCJyI2VhdGVyAACjbyJFRkdMU1T1CPoIAgkJCQ0JFQlxInVhbAAAoHEidSRsbEVxdWFsAADgZyI4A3IjZWF0ZXIAAOBrIjgD5SFzcwCgeSLsJGFudEVxdWFsAOB+KjgDaSJsZGUAAKB1IvUhbXBEASAJJwnvI3duSHVtcADgTiI4A3EidWFsAADgTyI4A2UAAAFmczEJRgn0JFRyaWFuZ2xlQqLqIj0JAAAAAEIJYQByAADgzyk4A3EidWFsAACg7CJzAICibiJFR0xTVABRCVYJXAlhCWkJcSJ1YWwAAKBwInIjZWF0ZXIAAKB4IuUhc3MA4GoiOAPsJGFudEVxdWFsAOB9KjgDaSJsZGUAAKB0IuUic3RlZAABR0x1CX8J8iZlYXRlckdyZWF0ZXIA4KIqOAPlI3NzTGVzcwDgoSo4A/IjZWNlZGVzAKGAIkVTjwmVCXEidWFsAADgryo4A+wkYW50RXF1YWwAoOAiAAFlaaAJqQl2JmVyc2VFbGVtZW50AACgDCLnJWh0VHJpYW5nbGVCousitgkAAAAAuwlhAHIAAODQKTgDcSJ1YWwAAKDtIgABcXXDCeAJdSNhcmVTdQAAAWJwywnVCfMhZXRF4I8iOANxInVhbAAAoOIi5SJyc2V0ReCQIjgDcSJ1YWwAAKDjIoABYmNwAOYJ8AkNCvMhZXRF4IIi0iBxInVhbAAAoIgi4yJlZWRzgKGBIkVTVAD6CQAKBwpxInVhbAAA4LAqOAPsJGFudEVxdWFsAKDhImkibGRlAADgfyI4A+UicnNldEXggyLSIHEidWFsAACgiSJpImxkZQCAoUEiRUZUACIKJwouCnEidWFsAACgRCJ1JGxsRXF1YWwAAKBHImkibGRlAACgSSJlJXJ0aWNhbEJhcgAAoCQiYwByAADgNdip3GkAbABkAGUAO4DRANFAnWMAB0VhY2RmZ21vcHJzdHV2XgphCmgKcgp2CnoKgQqRCpYKqwqtCrsKyArNCuwhaWdSYWMAdQB0AGUAO4DTANNAAAFpeWwKcQpyAGMAO4DUANRAHmRiImxhYwBQYXIAAOA12BLdcgBhAHYAZQA7gNIA0kCAAWFlaQCHCooKjQpjAHIATGFnAGEAqWNjInJvbgCfY3AAZgAA4DXYRt3lI25DdXJseQABRFGeCqYKbyV1YmxlUXVvdGUAAKAcIHUib3RlAACgGCAAoFQqAAFjbLEKtQpyAADgNdiq3GEAcwBoADuA2ADYQGkAbAHACsUKZABlADuA1QDVQGUAcwAAoDcqbQBsADuA1gDWQGUAcgAAAUJQ0wrmCgABYXLXCtoKcgAAoD4gYQBjAAABZWvgCuIKAKDeI2UAdAAAoLQjYSVyZW50aGVzaXMAAKDcI4AEYWNmaGlsb3JzAP0KAwsFCwkLCwsMCxELIwtaC3IjdGlhbEQAAKACInkAH2RyAADgNdgT3WkApmOgY/Ujc01pbnVzsWAAAWlwFQsgC24AYwBhAHIAZQBwAGwAYQBuAOUACgVmAACgGSGAobsqZWlvACoLRQtJC+MiZWRlc4CheiJFU1QANAs5C0ALcSJ1YWwAAKCvKuwkYW50RXF1YWwAoHwiaSJsZGUAAKB+Im0AZQAAoDMgAAFkcE0LUQv1IWN0AKAPIm8jcnRpb24AYaA3ImwAAKAdIgABY2leC2ILcgAA4DXYq9yoYwACVWZvc2oLbwtzC3cLTwBUADuAIgAiQHIAAOA12BTdcABmAACgGiFjAHIAAOA12KzcAAZCRWFjZWZoaW9yc3WPC5MLlwupC7YL2AvbC90LhQyTDJoMowzhIXJyAKAQKUcAO4CuAK5AgAFjbnIAnQugC6ML9SF0ZVRhZwAAoOsncgB0oKAhbAAAoBYpgAFhZXkArwuyC7UL8iFvblhh5CFpbFZhIGR2oBwhZSJyc2UAAAFFVb8LzwsAAWxxwwvIC+UibWVudACgCyL1JGlsaWJyaXVtAKDLIXAmRXF1aWxpYnJpdW0AAKBvKXIAAKAcIW8AoWPnIWh0AARBQ0RGVFVWYewLCgwQDDIMNwxeDHwM9gIAAW5y8Av4C2clbGVCcmFja2V0AACg6SfyIW93AKGSIUJM/wsDDGEAcgAAoOUhZSRmdEFycm93AACgxCFlI2lsaW5nAACgCSNvAPUBFgwAAB4MYiVsZUJyYWNrZXQAAKDnJ24A1AEjDAAAKgxlJGVWZWN0b3IAAKBdKeUiY3RvckKgwiFhAHIAAKBVKWwib29yAACgCyMAAWVyOwxLDGUAAKGiIkFWQQxGDHIicm93AACgpiHlImN0b3IAoFspaSNhbmdsZQBCorMiVgwAAAAAWgxhAHIAAKDQKXEidWFsAACgtSJwAIABRFRWAGUMbAxzDO8kd25WZWN0b3IAoE8pZSRlVmVjdG9yAACgXCnlImN0b3JCoL4hYQByAACgVCnlImN0b3JCoMAhYQByAACgUykAAXB1iQyMDGYAAKAdIe4kZEltcGxpZXMAoHAp6SRnaHRhcnJvdwCg2yEAAWNongyhDHIAAKAbIQCgsSHsJGVEZWxheWVkAKD0KYAGSE9hY2ZoaW1vcXN0dQC/DMgMzAzQDOIM5gwKDQ0NFA0ZDU8NVA1YDQABQ2PDDMYMyCFjeSlkeQAoZEYiVGN5ACxkYyJ1dGUAWmEAorwqYWVpedgM2wzeDOEM8iFvbmBh5CFpbF5hcgBjAFxhIWRyAADgNdgW3e8hcnQAAkRMUlXvDPYM/QwEDW8kd25BcnJvdwAAoJMhZSRmdEFycm93AACgkCHpJGdodEFycm93AKCSIXAjQXJyb3cAAKCRIechbWGjY+EkbGxDaXJjbGUAoBgicABmAADgNdhK3XICHw0AAAAAIg10AACgGiLhIXJlgKGhJUlTVQAqDTINSg3uJXRlcnNlY3Rpb24AoJMidQAAAWJwNw1ADfMhZXRFoI8icSJ1YWwAAKCRIuUicnNldEWgkCJxInVhbAAAoJIibiJpb24AAKCUImMAcgAA4DXYrtxhAHIAAKDGIgACYmNtcF8Nag2ODZANc6DQImUAdABFoNAicSJ1YWwAAKCGIgABY2huDYkNZSJlZHMAgKF7IkVTVAB4DX0NhA1xInVhbAAAoLAq7CRhbnRFcXVhbACgfSJpImxkZQAAoH8iVABoAGEA9ADHCwCgESIAodEiZXOVDZ8NciJzZXQARaCDInEidWFsAACghyJlAHQAAKDRIoAFSFJTYWNmaGlvcnMAtQ27Db8NyA3ODdsN3w3+DRgOHQ4jDk8AUgBOADuA3gDeQMEhREUAoCIhAAFIY8MNxg1jAHkAC2R5ACZkAAFidcwNzQ0JYKRjgAFhZXkA1A3XDdoN8iFvbmRh5CFpbGJhImRyAADgNdgX3QABZWnjDe4N8gHoDQAA7Q3lImZvcmUAoDQiYQCYYwABY27yDfkNayNTcGFjZQAA4F8gCiDTInBhY2UAoAkg7CFkZYChPCJFRlQABw4MDhMOcSJ1YWwAAKBDInUkbGxFcXVhbAAAoEUiaSJsZGUAAKBIInAAZgAA4DXYS93pI3BsZURvdACg2yAAAWN0Jw4rDnIAAOA12K/c8iFva2Zh4QpFDlYOYA5qDgAAbg5yDgAAAAAAAAAAAAB5DnwOqA6zDgAADg8RDxYPGg8AAWNySA5ODnUAdABlADuA2gDaQHIAb6CfIeMhaXIAoEkpcgDjAVsOAABdDnkADmR2AGUAbGEAAWl5Yw5oDnIAYwA7gNsA20AjZGIibGFjAHBhcgAA4DXYGN1yAGEAdgBlADuA2QDZQOEhY3JqYQABZGl/Dp8OZQByAAABQlCFDpcOAAFhcokOiw5yAF9gYQBjAAABZWuRDpMOAKDfI2UAdAAAoLUjYSVyZW50aGVzaXMAAKDdI28AbgBQoMMi7CF1cwCgjiIAAWdwqw6uDm8AbgByYWYAAOA12EzdAARBREVUYWRwc78O0g7ZDuEOBQPqDvMOBw9yInJvdwDCoZEhyA4AAMwOYQByAACgEilvJHduQXJyb3cAAKDFIW8kd25BcnJvdwAAoJUhcSV1aWxpYnJpdW0AAKBuKWUAZQBBoKUiciJyb3cAAKClIW8AdwBuAGEAcgByAG8A9wAQA2UAcgAAAUxS+Q4AD2UkZnRBcnJvdwAAoJYh6SRnaHRBcnJvdwCglyFpAGyg0gNvAG4ApWPpIW5nbmFjAHIAAOA12LDcaSJsZGUAaGFtAGwAO4DcANxAgAREYmNkZWZvc3YALQ8xDzUPNw89D3IPdg97D4AP4SFzaACgqyJhAHIAAKDrKnkAEmThIXNobKCpIgCg5ioAAWVyQQ9DDwCgwSKAAWJ0eQBJD00Paw9hAHIAAKAWIGmgFiDjIWFsAAJCTFNUWA9cD18PZg9hAHIAAKAjIukhbmV8YGUkcGFyYXRvcgAAoFgnaSJsZGUAAKBAItQkaGluU3BhY2UAoAogcgAA4DXYGd1wAGYAAOA12E3dYwByAADgNdix3GQiYXNoAACgqiKAAmNlZm9zAI4PkQ+VD5kPng/pIXJjdGHkIWdlAKDAInIAAOA12BrdcABmAADgNdhO3WMAcgAA4DXYstwAAmZpb3OqD64Prw+0D3IAAOA12BvdnmNwAGYAAOA12E/dYwByAADgNdiz3IAEQUlVYWNmb3N1AMgPyw/OD9EP2A/gD+QP6Q/uD2MAeQAvZGMAeQAHZGMAeQAuZGMAdQB0AGUAO4DdAN1AAAFpedwP3w9yAGMAdmErZHIAAOA12BzdcABmAADgNdhQ3WMAcgAA4DXYtNxtAGwAeGEABEhhY2RlZm9z/g8BEAUQDRAQEB0QIBAkEGMAeQAWZGMidXRlAHlhAAFheQkQDBDyIW9ufWEXZG8AdAB7YfIBFRAAABwQbwBXAGkAZAB0AOgAVAhhAJZjcgAAoCghcABmAACgJCFjAHIAAOA12LXc4QtCEEkQTRAAAGcQbRByEAAAAAAAAAAAeRCKEJcQ8hD9EAAAGxEhETIROREAAD4RYwB1AHQAZQA7gOEA4UByImV2ZQADYYCiPiJFZGl1eQBWEFkQWxBgEGUQAOA+IjMDAKA/InIAYwA7gOIA4kB0AGUAO4C0ALRAMGRsAGkAZwA7gOYA5kByoGEgAOA12B7dcgBhAHYAZQA7gOAA4EAAAWVwfBCGEAABZnCAEIQQ8yF5bQCgNSHoAIMQaABhALFjAAFhcI0QWwAAAWNskRCTEHIAAWFnAACgPypkApwQAAAAALEQAKInImFkc3ajEKcQqRCuEG4AZAAAoFUqAKBcKmwib3BlAACgWCoAoFoqAKMgImVsbXJzersQvRDAEN0Q5RDtEACgpCllAACgICJzAGQAYaAhImEEzhDQENIQ1BDWENgQ2hDcEACgqCkAoKkpAKCqKQCgqykAoKwpAKCtKQCgrikAoK8pdAB2oB8iYgBkoL4iAKCdKQABcHTpEOwQaAAAoCIixWDhIXJyAKB8IwABZ3D1EPgQbwBuAAVhZgAA4DXYUt0Ao0giRWFlaW9wBxEJEQ0RDxESERQRAKBwKuMhaXIAoG8qAKBKImQAAKBLInMAJ2DyIW94ZaBIIvEADhFpAG4AZwA7gOUA5UCAAWN0eQAmESoRKxFyAADgNdi23CpgbQBwAGWgSCLxAPgBaQBsAGQAZQA7gOMA40BtAGwAO4DkAORAAAFjaUERRxFvAG4AaQBuAPQA6AFuAHQAAKARKgAITmFiY2RlZmlrbG5vcHJzdWQRaBGXEZ8RpxGrEdIR1hErEjASexKKEn0RThNbE3oTbwB0AACg7SoAAWNybBGJEWsAAAJjZXBzdBF4EX0RghHvIW5nAKBMInAjc2lsb24A9mNyImltZQAAoDUgaQBtAGWgPSJxAACgzSJ2AY0RkRFlAGUAAKC9ImUAZABnoAUjZQAAoAUjcgBrAHSgtSPiIXJrAKC2IwABb3mjEaYRbgDnAHcRMWTxIXVvAKAeIIACY21wcnQAtBG5Eb4RwRHFEeEhdXPloDUi5ABwInR5dgAAoLApcwDpAH0RbgBvAPUA6gCAAWFodwDLEcwRzhGyYwCgNiHlIWVuAKBsInIAAOA12B/dZwCAA2Nvc3R1dncA4xHyEQUSEhIhEiYSKRKAAWFpdQDpEesR7xHwAKMFcgBjAACg7yVwAACgwyKAAWRwdAD4EfwRABJvAHQAAKAAKuwhdXMAoAEqaSJtZXMAAKACKnECCxIAAAAADxLjIXVwAKAGKmEAcgAAoAUm8iNpYW5nbGUAAWR1GhIeEu8hd24AoL0lcAAAoLMlcCJsdXMAAKAEKmUA5QBCD+UAkg9hInJvdwAAoA0pgAFha28ANhJoEncSAAFjbjoSZRJrAIABbHN0AEESRxJNEm8jemVuZ2UAAKDrKXEAdQBhAHIA5QBcBPIjaWFuZ2xlgKG0JWRscgBYElwSYBLvIXduAKC+JeUhZnQAoMIlaSJnaHQAAKC4JWsAAKAjJLEBbRIAAHUSsgFxEgAAcxIAoJIlAKCRJTQAAKCTJWMAawAAoIglAAFlb38ShxJx4D0A5SD1IWl2AOBhIuUgdAAAoBAjAAJwdHd4kRKVEpsSnxJmAADgNdhT3XSgpSJvAG0AAKClIvQhaWUAoMgiAAZESFVWYmRobXB0dXayEsES0RLgEvcS+xIKExoTHxMjEygTNxMAAkxSbHK5ErsSvRK/EgCgVyUAoFQlAKBWJQCgUyUAolAlRFVkdckSyxLNEs8SAKBmJQCgaSUAoGQlAKBnJQACTFJsctgS2hLcEt4SAKBdJQCgWiUAoFwlAKBZJQCjUSVITFJobHLrEu0S7xLxEvMS9RIAoGwlAKBjJQCgYCUAoGslAKBiJQCgXyVvAHgAAKDJKQACTFJscgITBBMGEwgTAKBVJQCgUiUAoBAlAKAMJQCiACVEVWR1EhMUExYTGBMAoGUlAKBoJQCgLCUAoDQlaSJudXMAAKCfIuwhdXMAoJ4iaSJtZXMAAKCgIgACTFJsci8TMRMzEzUTAKBbJQCgWCUAoBglAKAUJQCjAiVITFJobHJCE0QTRhNIE0oTTBMAoGolAKBhJQCgXiUAoDwlAKAkJQCgHCUAAWV2UhNVE3YA5QD5AGIAYQByADuApgCmQAACY2Vpb2ITZhNqE24TcgAA4DXYt9xtAGkAAKBPIG0A5aA9IogRbAAAoVwAYmh0E3YTAKDFKfMhdWIAoMgnbAF+E4QTbABloCIgdAAAoCIgcAAAoU4iRWWJE4sTAKCuKvGgTyI8BeEMqRMAAN8TABQDFB8UAAAjFDQUAAAAAIUUAAAAAI0UAAAAANcU4xT3FPsUAACIFQAAlhWAAWNwcgCuE7ET1RP1IXRlB2GAoikiYWJjZHMAuxO/E8QTzhPSE24AZAAAoEQqciJjdXAAAKBJKgABYXXIE8sTcAAAoEsqcAAAoEcqbwB0AACgQCoA4CkiAP4AAWVv2RPcE3QAAKBBIO4ABAUAAmFlaXXlE+8T9RP4E/AB6hMAAO0TcwAAoE0qbwBuAA1hZABpAGwAO4DnAOdAcgBjAAlhcABzAHOgTCptAACgUCpvAHQAC2GAAWRtbgAIFA0UEhRpAGwAO4C4ALhAcCJ0eXYAAKCyKXQAAIGiADtlGBQZFKJAcgBkAG8A9ABiAXIAAOA12CDdgAFjZWkAKBQqFDIUeQBHZGMAawBtoBMn4SFyawCgEyfHY3IAAKPLJUVjZWZtcz8UQRRHFHcUfBSAFACgwykAocYCZWxGFEkUcQAAoFciZQBhAlAUAAAAAGAUciJyb3cAAAFsclYUWhTlIWZ0AKC6IWkiZ2h0AACguyGAAlJTYWNkAGgUaRRrFG8UcxSuYACgyCRzAHQAAKCbIukhcmMAoJoi4SFzaACgnSJuImludAAAoBAqaQBkAACg7yrjIWlyAKDCKfUhYnN1oGMmaQB0AACgYybsApMUmhS2FAAAwxRvAG4AZaA6APGgVCKrAG0CnxQAAAAAoxRhAHSgLABAYAChASJmbKcUqRTuABMNZQAAAW14rhSyFOUhbnQAoAEiZQDzANIB5wG6FAAAwBRkoEUibwB0AACgbSpuAPQAzAGAAWZyeQDIFMsUzhQA4DXYVN1vAOQA1wEAgakAO3MeAdMUcgAAoBchAAFhb9oU3hRyAHIAAKC1IXMAcwAAoBcnAAFjdeYU6hRyAADgNdi43AABYnDuFPIUZaDPKgCg0SploNAqAKDSKuQhb3QAoO8igANkZWxwcnZ3AAYVEBUbFSEVRBVlFYQV4SFycgABbHIMFQ4VAKA4KQCgNSlwAhYVAAAAABkVcgAAoN4iYwAAoN8i4SFycnCgtiEAoD0pgKIqImJjZG9zACsVMBU6FT4VQRVyImNhcAAAoEgqAAFhdTQVNxVwAACgRipwAACgSipvAHQAAKCNInIAAKBFKgDgKiIA/gACYWxydksVURVuFXMVcgByAG2gtyEAoDwpeQCAAWV2dwBYFWUVaRVxAHACXxUAAAAAYxVyAGUA4wAXFXUA4wAZFWUAZQAAoM4iZSJkZ2UAAKDPImUAbgA7gKQApEBlI2Fycm93AAABbHJ7FX8V5SFmdACgtiFpImdodAAAoLchZQDkAG0VAAFjaYsVkRVvAG4AaQBuAPQAkwFuAHQAAKAxImwiY3R5AACgLSOACUFIYWJjZGVmaGlqbG9yc3R1d3oAuBW7Fb8V1RXgFegV+RUKFhUWHxZUFlcWZRbFFtsW7xb7FgUXChdyAPIAtAJhAHIAAKBlKQACZ2xyc8YVyhXOFdAV5yFlcgCgICDlIXRoAKA4IfIA9QxoAHagECAAoKMiawHZFd4VYSJyb3cAAKAPKWEA4wBfAgABYXnkFecV8iFvbg9hNGQAoUYhYW/tFfQVAAFnciEC8RVyAACgyiF0InNlcQAAoHcqgAFnbG0A/xUCFgUWO4CwALBAdABhALRjcCJ0eXYAAKCxKQABaXIOFhIW8yFodACgfykA4DXYId1hAHIAAAFschsWHRYAoMMhAKDCIYACYWVnc3YAKBauAjYWOhY+Fm0AAKHEIm9zLhY0Fm4AZABzoMQi9SFpdACgZiZhIm1tYQDdY2kAbgAAoPIiAKH3AGlvQxZRFmQAZQAAgfcAO29KFksW90BuI3RpbWVzAACgxyJuAPgAUBZjAHkAUmRjAG8CXhYAAAAAYhZyAG4AAKAeI28AcAAAoA0jgAJscHR1dwBuFnEWdRaSFp4W7CFhciRgZgAA4DXYVd0AotkCZW1wc30WhBaJFo0WcQBkoFAibwB0AACgUSJpIm51cwAAoDgi7CF1cwCgFCLxInVhcmUAoKEiYgBsAGUAYgBhAHIAdwBlAGQAZwDlANcAbgCAAWFkaAClFqoWtBZyAHIAbwD3APUMbwB3AG4AYQByAHIAbwB3APMA8xVhI3Jwb29uAAABbHK8FsAWZQBmAPQAHBZpAGcAaAD0AB4WYgHJFs8WawBhAHIAbwD3AJILbwLUFgAAAADYFnIAbgAAoB8jbwBwAACgDCOAAWNvdADhFukW7BYAAXJ55RboFgDgNdi53FVkbAAAoPYp8iFvaxFhAAFkcvMW9xZvAHQAAKDxImkA5qC/JVsSAAFhaP8WAhdyAPIANQNhAPIA1wvhIm5nbGUAoKYpAAFjaQ4XEBd5AF9k5yJyYXJyAKD/JwAJRGFjZGVmZ2xtbm9wcXJzdHV4MRc4F0YXWxcyBF4XaRd5F40XrBe0F78X2RcVGCEYLRg1GEAYAAFEbzUXgRZvAPQA+BUAAWNzPBdCF3UAdABlADuA6QDpQPQhZXIAoG4qAAJhaW95TRdQF1YXWhfyIW9uG2FyAGOgViI7gOoA6kDsIW9uAKBVIk1kbwB0ABdhAAFEcmIXZhdvAHQAAKBSIgDgNdgi3XKhmipuF3QXYQB2AGUAO4DoAOhAZKCWKm8AdAAAoJgqgKGZKmlscwCAF4UXhxfuInRlcnMAoOcjAKATIWSglSpvAHQAAKCXKoABYXBzAJMXlheiF2MAcgATYXQAeQBzogUinxcAAAAAoRdlAHQAAKAFInAAMaADIDMBqRerFwCgBCAAoAUgAAFnc7AXsRdLYXAAAKACIAABZ3C4F7sXbwBuABlhZgAA4DXYVt2AAWFscwDFF8sXzxdyAHOg1SJsAACg4yl1AHMAAKBxKmkAAKG1A2x21RfYF28AbgC1Y/VjAAJjc3V24BfoF/0XEBgAAWlv5BdWF3IAYwAAoFYiaQLuFwAAAADwF+0ADQThIW50AAFnbPUX+Rd0AHIAAKCWKuUhc3MAoJUqgAFhZWkAAxgGGAoYbABzAD1gcwB0AACgXyJ2AESgYSJEAACgeCrwImFyc2wAoOUpAAFEYRkYHRhvAHQAAKBTInIAcgAAoHEpgAFjZGkAJxgqGO0XcgAAoC8hbwD0AIwCAAFhaDEYMhi3YzuA8ADwQAABbXI5GD0YbAA7gOsA60BvAACgrCCAAWNpcABGGEgYSxhsACFgcwD0ACwEAAFlb08YVxhjAHQAYQB0AGkAbwDuABoEbgBlAG4AdABpAGEAbADlADME4Ql1GAAAgRgAAIMYiBgAAAAAoRilGAAAqhgAALsYvhjRGAAA1xgnGWwAbABpAG4AZwBkAG8AdABzAGUA8QBlF3kARGRtImFsZQAAoEAmgAFpbHIAjRiRGJ0Y7CFpZwCgA/tpApcYAAAAAJoYZwAAoAD7aQBnAACgBPsA4DXYI93sIWlnAKAB++whaWcA4GYAagCAAWFsdACvGLIYthh0AACgbSZpAGcAAKAC+24AcwAAoLElbwBmAJJh8AHCGAAAxhhmAADgNdhX3QABYWvJGMwYbADsAGsEdqDUIgCg2SphI3J0aW50AACgDSoAAWFv2hgiGQABY3PeGB8ZsQPnGP0YBRkSGRUZAAAdGbID7xjyGPQY9xj5GAAA+xg7gL0AvUAAoFMhO4C8ALxAAKBVIQCgWSEAoFshswEBGQAAAxkAoFQhAKBWIbQCCxkOGQAAAAAQGTuAvgC+QACgVyEAoFwhNQAAoFghtgEZGQAAGxkAoFohAKBdITgAAKBeIWwAAKBEIHcAbgAAoCIjYwByAADgNdi73IAIRWFiY2RlZmdpamxub3JzdHYARhlKGVoZXhlmGWkZkhmWGZkZnRmgGa0ZxhnLGc8Z4BkjGmygZyIAoIwqgAFjbXAAUBlTGVgZ9SF0ZfVhbQBhAOSgswM6FgCghipyImV2ZQAfYQABaXliGWUZcgBjAB1hM2RvAHQAIWGAoWUibHFzAMYEcBl6GfGhZSLOBAAAdhlsAGEAbgD0AN8EgKF+KmNkbACBGYQZjBljAACgqSpvAHQAb6CAKmyggioAoIQqZeDbIgD+cwAAoJQqcgAA4DXYJN3noGsirATtIWVsAKA3IWMAeQBTZIChdyJFYWoApxmpGasZAKCSKgCgpSoAoKQqAAJFYWVztBm2Gb0ZwhkAoGkicABwoIoq8iFveACgiipxoIgq8aCIKrUZaQBtAACg5yJwAGYAAOA12FjdYQB2AOUAYwIAAWNp0xnWGXIAAKAKIW0AAKFzImVs3BneGQCgjioAoJAqAIM+ADtjZGxxco0E6xn0GfgZ/BkBGgABY2nvGfEZAKCnKnIAAKB6Km8AdAAAoNci0CFhcgCglSl1ImVzdAAAoHwqgAJhZGVscwAKGvQZFhrVBCAa8AEPGgAAFBpwAHIAbwD4AFkZcgAAoHgpcQAAAWxxxAQbGmwAZQBzAPMASRlpAO0A5AQAAWVuJxouGnIjdG5lcXEAAOBpIgD+xQAsGgAFQWFiY2Vma29zeUAaQxpmGmoabRqDGocalhrCGtMacgDyAMwCAAJpbG1yShpOGlAaVBpyAHMA8ABxD2YAvWBpAGwA9AASBQABZHJYGlsaYwB5AEpkAKGUIWN3YBpkGmkAcgAAoEgpAKCtIWEAcgAAoA8h6SFyYyVhgAFhbHIAcxp7Gn8a8iF0c3WgZSZpAHQAAKBlJuwhaXAAoCYg4yFvbgCguSJyAADgNdgl3XMAAAFld4wakRphInJvdwAAoCUpYSJyb3cAAKAmKYACYW1vcHIAnxqjGqcauhq+GnIAcgAAoP8h9CFodACgOyJrAAABbHKsGrMaZSRmdGFycm93AACgqSHpJGdodGFycm93AKCqIWYAAOA12Fnd4iFhcgCgFSCAAWNsdADIGswa0BpyAADgNdi93GEAcwDoAGka8iFvaydhAAFicNca2xr1IWxsAKBDIOghZW4AoBAg4Qr2GgAA/RoAAAgbExsaGwAAIRs7GwAAAAA+G2IbmRuVG6sbAACyG80b0htjAHUAdABlADuA7QDtQAChYyBpeQEbBhtyAGMAO4DuAO5AOGQAAWN4CxsNG3kANWRjAGwAO4ChAKFAAAFmcssCFhsA4DXYJt1yAGEAdgBlADuA7ADsQIChSCFpbm8AJxsyGzYbAAFpbisbLxtuAHQAAKAMKnQAAKAtIuYhaW4AoNwpdABhAACgKSHsIWlnM2GAAWFvcABDG1sbXhuAAWNndABJG0sbWRtyACthgAFlbHAAcQVRG1UbaQBuAOUAyAVhAHIA9AByBWgAMWFmAACgtyJlAGQAtWEAoggiY2ZvdGkbbRt1G3kb4SFyZQCgBSFpAG4AdKAeImkAZQAAoN0pZABvAPQAWxsAoisiY2VscIEbhRuPG5QbYQBsAACguiIAAWdyiRuNG2UAcgDzACMQ4wCCG2EicmhrAACgFyryIW9kAKA8KgACY2dwdJ8boRukG6gbeQBRZG8AbgAvYWYAAOA12FrdYQC5Y3UAZQBzAHQAO4C/AL9AAAFjabUbuRtyAADgNdi+3G4AAKIIIkVkc3bCG8QbyBvQAwCg+SJvAHQAAKD1Inag9CIAoPMiaaBiIOwhZGUpYesB1hsAANkbYwB5AFZkbAA7gO8A70AAA2NmbW9zdeYb7hvyG/Ub+hsFHAABaXnqG+0bcgBjADVhOWRyAADgNdgn3eEhdGg3YnAAZgAA4DXYW93jAf8bAAADHHIAAOA12L/c8iFjeVhk6yFjeVRkAARhY2ZnaGpvcxUcGhwiHCYcKhwtHDAcNRzwIXBhdqC6A/BjAAFleR4cIRzkIWls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ZmdobG1vcHJzdHV3CiwNLBEsHSwnLDEsQCxLLFIsYix6LIQsjyzLLOgs7Sz/LAotcgDyAAkDYQByAACgYykAAWNyFSwbLHUAdABlADuA+gD6QPIACQ1yAOMBIywAACUseQBeZHYAZQBtYQABaXkrLDAscgBjADuA+wD7QENkgAFhYmgANyw6LD0scgDyANEO7CFhY3FhYQDyAOAOAAFpckQsSCzzIWh0AKB+KQDgNdgy3XIAYQB2AGUAO4D5APlAYQFWLF8scgAAAWxyWixcLACgvyEAoL4hbABrAACggCUAAWN0Zix2LG8CbCwAAAAAcyxyAG4AZaAcI3IAAKAcI28AcAAAoA8jcgBpAACg+CUAAWFsfiyBLGMAcgBrYTuAqACoQAABZ3CILIssbwBuAHNhZgAA4DXYZt0AA2FkaGxzdZksniynLLgsuyzFLHIAcgBvAPcACQ1vAHcAbgBhAHIAcgBvAPcA2A5hI3Jwb29uAAABbHKvLLMsZQBmAPQAWyxpAGcAaAD0AF0sdQDzAKYOaQAAocUDaGzBLMIs0mNvAG4AxWPwI2Fycm93cwCgyCGAAWNpdADRLOEs5CxvAtcsAAAAAN4scgBuAGWgHSNyAACgHSNvAHAAAKAOI24AZwBvYXIAaQAAoPklYwByAADgNdjK3IABZGlyAPMs9yz6LG8AdAAAoPAi7CFkZWlhaQBmoLUlAKC0JQABYW0DLQYtcgDyAMosbAA7gPwA/EDhIm5nbGUAoKcpgAdBQkRhY2RlZmxub3Byc3oAJy0qLTAtNC2bLZ0toS2/LcMtxy3TLdgt3C3gLfwtcgDyABADYQByAHag6CoAoOkqYQBzAOgA/gIAAW5yOC08LechcnQAoJwpgANla25wcnN0AJkpSC1NLVQtXi1iLYItYQBwAHAA4QAaHG8AdABoAGkAbgDnAKEXgAFoaXIAoSmzJFotbwBwAPQAdCVooJUh7wD4JgABaXVmLWotZwBtAOEAuygAAWJwbi14LXMjZXRuZXEAceCKIgD+AODLKgD+cyNldG5lcQBx4IsiAP4A4MwqAP4AAWhyhi2KLWUAdADhABIraSNhbmdsZQAAAWxyki2WLeUhZnQAoLIiaSJnaHQAAKCzInkAMmThIXNoAKCiIoABZWxyAKcttC24LWKiKCKuLQAAAACyLWEAcgAAoLsicQAAoFoi7CFpcACg7iIAAWJ0vC1eD2EA8gBfD3IAAOA12DPddAByAOkAlS1zAHUAAAFicM0t0C0A4IIi0iAA4IMi0iBwAGYAAOA12GfdcgBvAPAAWQt0AHIA6QCaLQABY3XkLegtcgAA4DXYy9wAAWJw7C30LW4AAAFFZXUt8S0A4IoiAP5uAAABRWV/LfktAOCLIgD+6SJnemFnAKCaKYADY2Vmb3BycwANLhAuJS4pLiMuLi40LukhcmN1YQABZGkULiEuAAFiZxguHC5hAHIAAKBfKmUAcaAnIgCgWSLlIXJwAKAYIXIAAOA12DTdcABmAADgNdho3WWgQCJhAHQA6ABqD2MAcgAA4DXYzNzjCuQRUC4AAFQuAABYLmIuAAAAAGMubS5wLnQuAAAAAIguki4AAJouJxIqEnQAcgDpAB0ScgAA4DXYNd0AAUFhWy5eLnIA8gDnAnIA8gCTB75jAAFBYWYuaS5yAPIA4AJyAPIAjAdhAPAAeh5pAHMAAKD7IoABZHB0APgReS6DLgABZmx9LoAuAOA12GnddQDzAP8RaQBtAOUABBIAAUFhiy6OLnIA8gDuAnIA8gCaBwABY3GVLgoScgAA4DXYzdwAAXB0nS6hLmwAdQDzACUScgDpACASAARhY2VmaW9zdbEuvC7ELsguzC7PLtQu2S5jAAABdXm2LrsudABlADuA/QD9QE9kAAFpecAuwy5yAGMAd2FLZG4AO4ClAKVAcgAA4DXYNt1jAHkAV2RwAGYAAOA12GrdYwByAADgNdjO3AABY23dLt8ueQBOZGwAO4D/AP9AAAVhY2RlZmhpb3N38y73Lv8uAi8MLxAvEy8YLx0vIi9jInV0ZQB6YQABYXn7Lv4u8iFvbn5hN2RvAHQAfGEAAWV0Bi8KL3QAcgDmAB8QYQC2Y3IAAOA12DfdYwB5ADZk5yJyYXJyAKDdIXAAZgAA4DXYa91jAHIAAOA12M/cAAFqbiYvKC8AoA0gagAAoAwg`),C;(function(e){e[e.VALUE_LENGTH=49152]=`VALUE_LENGTH`,e[e.FLAG13=8192]=`FLAG13`,e[e.BRANCH_LENGTH=8064]=`BRANCH_LENGTH`,e[e.JUMP_TABLE=127]=`JUMP_TABLE`})(C||(C={}));function w(e){"@babel/helpers - typeof";return w=typeof Symbol==`function`&&typeof Symbol.iterator==`symbol`?function(e){return typeof e}:function(e){return e&&typeof Symbol==`function`&&e.constructor===Symbol&&e!==Symbol.prototype?`symbol`:typeof e},w(e)}function ue(e,t){if(w(e)!=`object`||!e)return e;var n=e[Symbol.toPrimitive];if(n!==void 0){var r=n.call(e,t||`default`);if(w(r)!=`object`)return r;throw TypeError(`@@toPrimitive must return a primitive value.`)}return(t===`string`?String:Number)(e)}function de(e){var t=ue(e,`string`);return w(t)==`symbol`?t:t+``}function T(e,t,n){return(t=de(t))in e?Object.defineProperty(e,t,{value:n,enumerable:!0,configurable:!0,writable:!0}):e[t]=n,e}var E;(function(e){e[e.NUM=35]=`NUM`,e[e.SEMI=59]=`SEMI`,e[e.EQUALS=61]=`EQUALS`,e[e.ZERO=48]=`ZERO`,e[e.NINE=57]=`NINE`,e[e.LOWER_A=97]=`LOWER_A`,e[e.LOWER_F=102]=`LOWER_F`,e[e.LOWER_X=120]=`LOWER_X`,e[e.LOWER_Z=122]=`LOWER_Z`,e[e.UPPER_A=65]=`UPPER_A`,e[e.UPPER_F=70]=`UPPER_F`,e[e.UPPER_Z=90]=`UPPER_Z`})(E||(E={}));var fe=32;function D(e){return e>=E.ZERO&&e<=E.NINE}function pe(e){return e>=E.UPPER_A&&e<=E.UPPER_F||e>=E.LOWER_A&&e<=E.LOWER_F}function me(e){return e>=E.UPPER_A&&e<=E.UPPER_Z||e>=E.LOWER_A&&e<=E.LOWER_Z||D(e)}function he(e){return e===E.EQUALS||me(e)}var O;(function(e){e[e.EntityStart=0]=`EntityStart`,e[e.NumericStart=1]=`NumericStart`,e[e.NumericDecimal=2]=`NumericDecimal`,e[e.NumericHex=3]=`NumericHex`,e[e.NamedEntity=4]=`NamedEntity`})(O||(O={}));var k;(function(e){e[e.Legacy=0]=`Legacy`,e[e.Strict=1]=`Strict`,e[e.Attribute=2]=`Attribute`})(k||(k={}));var ge=class{constructor(e,t,n){T(this,`decodeTree`,void 0),T(this,`emitCodePoint`,void 0),T(this,`errors`,void 0),T(this,`state`,O.EntityStart),T(this,`consumed`,1),T(this,`result`,0),T(this,`treeIndex`,0),T(this,`excess`,1),T(this,`decodeMode`,k.Strict),T(this,`runConsumed`,0),this.decodeTree=e,this.emitCodePoint=t,this.errors=n}startEntity(e){this.decodeMode=e,this.state=O.EntityStart,this.result=0,this.treeIndex=0,this.excess=1,this.consumed=1,this.runConsumed=0}write(e,t){switch(this.state){case O.EntityStart:return e.charCodeAt(t)===E.NUM?(this.state=O.NumericStart,this.consumed+=1,this.stateNumericStart(e,t+1)):(this.state=O.NamedEntity,this.stateNamedEntity(e,t));case O.NumericStart:return this.stateNumericStart(e,t);case O.NumericDecimal:return this.stateNumericDecimal(e,t);case O.NumericHex:return this.stateNumericHex(e,t);case O.NamedEntity:return this.stateNamedEntity(e,t)}}stateNumericStart(e,t){return t>=e.length?-1:(e.charCodeAt(t)|fe)===E.LOWER_X?(this.state=O.NumericHex,this.consumed+=1,this.stateNumericHex(e,t+1)):(this.state=O.NumericDecimal,this.stateNumericDecimal(e,t))}stateNumericHex(e,t){for(;t<e.length;){let n=e.charCodeAt(t);if(D(n)||pe(n)){let e=n<=E.NINE?n-E.ZERO:(n|fe)-E.LOWER_A+10;this.result=this.result*16+e,this.consumed++,t++}else return this.emitNumericEntity(n,3)}return-1}stateNumericDecimal(e,t){for(;t<e.length;){let n=e.charCodeAt(t);if(D(n))this.result=this.result*10+(n-E.ZERO),this.consumed++,t++;else return this.emitNumericEntity(n,2)}return-1}emitNumericEntity(e,t){if(this.consumed<=t){var n;return(n=this.errors)==null||n.absenceOfDigitsInNumericCharacterReference(this.consumed),0}if(e===E.SEMI)this.consumed+=1;else if(this.decodeMode===k.Strict)return 0;return this.emitCodePoint(se(this.result),this.consumed),this.errors&&(e!==E.SEMI&&this.errors.missingSemicolonAfterCharacterReference(),this.errors.validateNumericCharacterReference(this.result)),this.consumed}stateNamedEntity(e,t){let{decodeTree:n}=this,r=n[this.treeIndex],i=(r&C.VALUE_LENGTH)>>14;for(;t<e.length;){if(i===0&&(r&C.FLAG13)!==0){let a=(r&C.BRANCH_LENGTH)>>7;if(this.runConsumed===0){let n=r&C.JUMP_TABLE;if(e.charCodeAt(t)!==n)return this.result===0?0:this.emitNotTerminatedNamedEntity();t++,this.excess++,this.runConsumed++}for(;this.runConsumed<a;){if(t>=e.length)return-1;let r=this.runConsumed-1,i=n[this.treeIndex+1+(r>>1)],a=r%2==0?i&255:i>>8&255;if(e.charCodeAt(t)!==a)return this.runConsumed=0,this.result===0?0:this.emitNotTerminatedNamedEntity();t++,this.excess++,this.runConsumed++}this.runConsumed=0,this.treeIndex+=1+(a>>1),r=n[this.treeIndex],i=(r&C.VALUE_LENGTH)>>14}if(t>=e.length)break;let a=e.charCodeAt(t);if(a===E.SEMI&&i!==0&&(r&C.FLAG13)!==0)return this.emitNamedEntityData(this.treeIndex,i,this.consumed+this.excess);if(this.treeIndex=ve(n,r,this.treeIndex+Math.max(1,i),a),this.treeIndex<0)return this.result===0||this.decodeMode===k.Attribute&&(i===0||he(a))?0:this.emitNotTerminatedNamedEntity();if(r=n[this.treeIndex],i=(r&C.VALUE_LENGTH)>>14,i!==0){if(a===E.SEMI)return this.emitNamedEntityData(this.treeIndex,i,this.consumed+this.excess);this.decodeMode!==k.Strict&&(r&C.FLAG13)===0&&(this.result=this.treeIndex,this.consumed+=this.excess,this.excess=0)}t++,this.excess++}return-1}emitNotTerminatedNamedEntity(){var e;let{result:t,decodeTree:n}=this,r=(n[t]&C.VALUE_LENGTH)>>14;return this.emitNamedEntityData(t,r,this.consumed),(e=this.errors)==null||e.missingSemicolonAfterCharacterReference(),this.consumed}emitNamedEntityData(e,t,n){let{decodeTree:r}=this;return this.emitCodePoint(t===1?r[e]&~(C.VALUE_LENGTH|C.FLAG13):r[e+1],n),t===3&&this.emitCodePoint(r[e+2],n),n}end(){switch(this.state){case O.NamedEntity:return this.result!==0&&(this.decodeMode!==k.Attribute||this.result===this.treeIndex)?this.emitNotTerminatedNamedEntity():0;case O.NumericDecimal:return this.emitNumericEntity(0,2);case O.NumericHex:return this.emitNumericEntity(0,3);case O.NumericStart:var e;return(e=this.errors)==null||e.absenceOfDigitsInNumericCharacterReference(this.consumed),0;case O.EntityStart:return 0}}};function _e(e){let t=``,n=new ge(e,e=>t+=String.fromCodePoint(e));return function(e,r){let i=0,a=0;for(;(a=e.indexOf(`&`,a))>=0;){t+=e.slice(i,a),n.startEntity(r);let o=n.write(e,a+1);if(o<0){i=a+n.end();break}i=a+o,a=o===0?i+1:i}let o=t+e.slice(i);return t=``,o}}function ve(e,t,n,r){let i=(t&C.BRANCH_LENGTH)>>7,a=t&C.JUMP_TABLE;if(i===0)return a!==0&&r===a?n:-1;if(a){let t=r-a;return t<0||t>=i?-1:e[n+t]-1}let o=i+1>>1,s=0,c=i-1;for(;s<=c;){let t=s+c>>>1,i=e[n+(t>>1)]>>(t&1)*8&255;if(i<r)s=t+1;else if(i>r)c=t-1;else return e[n+o+t]}return-1}var ye=_e(le);function be(e){return ye(e,k.Strict)}var xe=t({arrayReplaceAt:()=>Ce,asciiTrim:()=>R,callable:()=>Se,escapeHtml:()=>M,escapeRE:()=>Fe,fromCodePoint:()=>A,isMdAsciiPunct:()=>I,isPunctChar:()=>Ie,isPunctCharCode:()=>F,isSpace:()=>N,isValidEntityCode:()=>we,isWhiteSpace:()=>P,lib:()=>Re,normalizeReference:()=>L,unescapeAll:()=>j,unescapeMd:()=>ke});function Se(e){let t=function(...n){return Reflect.construct(e,n,new.target&&new.target!==t?new.target:e)};return Object.defineProperty(t,"name",{value:e.name}),Object.setPrototypeOf(t,e),t.prototype=e.prototype,t}function Ce(e,t,n){return[].concat(e.slice(0,t),n,e.slice(t+1))}function we(e){return!(e>=55296&&e<=57343||e>=64976&&e<=65007||(e&65535)==65535||(e&65535)==65534||e>=0&&e<=8||e===11||e>=14&&e<=31||e>=127&&e<=159||e>1114111)}function A(e){if(e>65535){e-=65536;let t=55296+(e>>10),n=56320+(e&1023);return String.fromCharCode(t,n)}return String.fromCharCode(e)}var Te=/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g,Ee=RegExp(`${Te.source}|&([a-z#][a-z0-9]{1,31});`,`gi`),De=/^#((?:x[a-f0-9]{1,8}|[0-9]{1,8}))$/i;function Oe(e,t){if(t.charCodeAt(0)===35&&De.test(t)){let n=t[1].toLowerCase()===`x`?parseInt(t.slice(2),16):parseInt(t.slice(1),10);return we(n)?A(n):e}let n=be(e);return n===e?e:n}function ke(e){return e.indexOf(`\\`)<0?e:e.replace(Te,`$1`)}function j(e){return e.indexOf(`\\`)<0&&e.indexOf(`&`)<0?e:e.replace(Ee,function(e,t,n){return t||Oe(e,n)})}var Ae=/[&<>"]/,je=/[&<>"]/g,Me={"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`};function Ne(e){return Me[e]}function M(e){return Ae.test(e)?e.replace(je,Ne):e}var Pe=/[.?*+^$[\]\\(){}|-]/g;function Fe(e){return e.replace(Pe,`\\$&`)}function N(e){switch(e){case 9:case 32:return!0}return!1}function P(e){if(e>=8192&&e<=8202)return!0;switch(e){case 9:case 10:case 11:case 12:case 13:case 32:case 160:case 5760:case 8239:case 8287:case 12288:return!0}return!1}function Ie(e){return S.test(e)||ie.test(e)}function F(e){return Ie(A(e))}function I(e){switch(e){case 33:case 34:case 35:case 36:case 37:case 38:case 39:case 40:case 41:case 42:case 43:case 44:case 45:case 46:case 47:case 58:case 59:case 60:case 61:case 62:case 63:case 64:case 91:case 92:case 93:case 94:case 95:case 96:case 123:case 124:case 125:case 126:return!0;default:return!1}}function L(e){return e=e.trim().replace(/\s+/g,` `),e.toLowerCase().toUpperCase()}function Le(e){return e===32||e===9||e===10||e===13}function R(e){let t=0;for(;t<e.length&&Le(e.charCodeAt(t));t++);let n=e.length-1;for(;n>=t&&Le(e.charCodeAt(n));n--);return e.slice(t,n+1)}var Re={mdurl:ee,ucmicro:te};function ze(e,t,n){let r,i,a,o,s=e.posMax,c=e.pos;for(e.pos=t+1,r=1;e.pos<s;){if(a=e.src.charCodeAt(e.pos),a===93&&(r--,r===0)){i=!0;break}if(o=e.pos,e.md.inline.skipToken(e),a===91){if(o===e.pos-1)r++;else if(n)return e.pos=c,-1}}let l=-1;return i&&(l=e.pos),e.pos=c,l}function Be(e,t,n){let r,i=t,a={ok:!1,pos:0,str:``};if(e.charCodeAt(i)===60){for(i++;i<n;){if(r=e.charCodeAt(i),r===10||r===60)return a;if(r===62)return a.pos=i+1,a.str=j(e.slice(t+1,i)),a.ok=!0,a;if(r===92&&i+1<n){i+=2;continue}i++}return a}let o=0;for(;i<n&&(r=e.charCodeAt(i),!(r===32||r<32||r===127));){if(r===92&&i+1<n){if(e.charCodeAt(i+1)===32){i++;continue}i+=2;continue}if(r===40&&(o++,o>32))return a;if(r===41){if(o===0)break;o--}i++}return t===i||o!==0?a:(a.str=j(e.slice(t,i)),a.pos=i,a.ok=!0,a)}function Ve(e,t,n,r){let i,a=t,o={ok:!1,can_continue:!1,pos:0,str:``,marker:0};if(r)o.str=r.str,o.marker=r.marker;else{if(a>=n)return o;let r=e.charCodeAt(a);if(r!==34&&r!==39&&r!==40)return o;t++,a++,r===40&&(r=41),o.marker=r}for(;a<n;){if(i=e.charCodeAt(a),i===o.marker)return o.pos=a+1,o.str+=j(e.slice(t,a)),o.ok=!0,o;if(i===40&&o.marker===41)return o;i===92&&a+1<n&&a++,a++}return o.can_continue=!0,o.str+=j(e.slice(t,a)),o}var He=t({parseLinkDestination:()=>Be,parseLinkLabel:()=>ze,parseLinkTitle:()=>Ve}),z=class{constructor(e,t,n){T(this,`map`,null),T(this,`level`,0),T(this,`children`,null),T(this,`content`,``),T(this,`markup`,``),T(this,`info`,``),T(this,`block`,!1),T(this,`hidden`,!1),this.type=e,this.tag=t,this.attrs=null,this.nesting=n,this.meta=null}attrIndex(e){if(!this.attrs)return-1;let t=this.attrs;for(let n=0,r=t.length;n<r;n++)if(t[n][0]===e)return n;return-1}attrPush(e){this.attrs?this.attrs.push(e):this.attrs=[e]}attrSet(e,t){let n=this.attrIndex(e),r=[e,t];n<0?this.attrPush(r):this.attrs[n]=r}attrGet(e){let t=this.attrIndex(e),n=null;return t>=0&&(n=this.attrs[t][1]),n}attrJoin(e,t){let n=this.attrIndex(e);n<0?this.attrPush([e,t]):this.attrs[n][1]=`${this.attrs[n][1]} ${t}`}},B=class{constructor(){T(this,`__rules__`,[]),T(this,`__cache__`,null)}__find__(e){for(let t=0;t<this.__rules__.length;t++)if(this.__rules__[t].name===e)return t;return-1}__compile__(){let e=new Set;this.__rules__.forEach(t=>{t.enabled&&t.alt.forEach(t=>{t&&e.add(t)})}),this.__cache__=Object.create(null),this.__cache__[``]=[],this.__rules__.forEach(e=>{e.enabled&&this.__cache__[``].push(e.fn)}),e.forEach(e=>{this.__cache__[e]=[],this.__rules__.forEach(t=>{t.enabled&&t.alt.indexOf(e)>=0&&this.__cache__[e].push(t.fn)})})}at(e,t,n={}){let r=this.__find__(e);if(r===-1)throw Error(`Parser rule not found: ${e}`);this.__rules__[r].fn=t,this.__rules__[r].alt=n.alt||[],this.__cache__=null}before(e,t,n,r={}){let i=this.__find__(e);if(i===-1)throw Error(`Parser rule not found: ${e}`);this.__rules__.splice(i,0,{name:t,enabled:!0,fn:n,alt:r.alt||[]}),this.__cache__=null}after(e,t,n,r={}){let i=this.__find__(e);if(i===-1)throw Error(`Parser rule not found: ${e}`);this.__rules__.splice(i+1,0,{name:t,enabled:!0,fn:n,alt:r.alt||[]}),this.__cache__=null}push(e,t,n={}){this.__rules__.push({name:e,enabled:!0,fn:t,alt:n.alt||[]}),this.__cache__=null}enable(e,t=!1){Array.isArray(e)||(e=[e]);let n=[];return e.forEach(e=>{let r=this.__find__(e);if(r<0){if(t)return;throw Error(`Rules manager: invalid rule name ${e}`)}this.__rules__[r].enabled=!0,n.push(e)}),this.__cache__=null,n}enableOnly(e,t=!1){Array.isArray(e)||(e=[e]),this.__rules__.forEach(e=>{e.enabled=!1}),this.enable(e,t)}disable(e,t=!1){Array.isArray(e)||(e=[e]);let n=[];return e.forEach(e=>{let r=this.__find__(e);if(r<0){if(t)return;throw Error(`Rules manager: invalid rule name ${e}`)}this.__rules__[r].enabled=!1,n.push(e)}),this.__cache__=null,n}getRules(e){return this.__cache__||this.__compile__(),this.__cache__[e]||[]}},V={};V.code_inline=function(e,t,n,r,i){let a=e[t];return`<code${i.renderAttrs(a)}>${M(a.content)}</code>`},V.code_block=function(e,t,n,r,i){let a=e[t];return`<pre${i.renderAttrs(a)}><code>${M(e[t].content)}</code></pre>\n`},V.fence=function(e,t,n,r,i){let a=e[t],o=a.info?j(a.info).trim():``,s=``,c=``;if(o){let e=o.split(/(\s+)/g);s=e[0],c=e.slice(2).join(``)}let l;if(l=n.highlight&&n.highlight(a.content,s,c)||M(a.content),l.indexOf(`<pre`)===0)return l+`
`;if(o){let e=a.attrIndex(`class`),t=a.attrs?a.attrs.slice():[];e<0?t.push([`class`,`${n.langPrefix}${s}`]):(t[e]=[t[e][0],t[e][1]],t[e][1]+=` ${n.langPrefix}${s}`);let r={attrs:t};return`<pre><code${i.renderAttrs(r)}>${l}</code></pre>\n`}return`<pre><code${i.renderAttrs(a)}>${l}</code></pre>\n`},V.image=function(e,t,n,r,i){let a=e[t];return a.attrs[a.attrIndex(`alt`)][1]=i.renderInlineAsText(a.children,n,r),i.renderToken(e,t,n)},V.hardbreak=function(e,t,n){return n.xhtmlOut?`<br />
`:`<br>
`},V.softbreak=function(e,t,n){return n.breaks?n.xhtmlOut?`<br />
`:`<br>
`:`
`},V.text=function(e,t){return M(e[t].content)},V.html_block=function(e,t){return e[t].content},V.html_inline=function(e,t){return e[t].content};var Ue=class{constructor(){T(this,`rules`,Object.assign({},V))}renderAttrs(e){let t,n,r;if(!e.attrs)return``;for(r=``,t=0,n=e.attrs.length;t<n;t++)r+=` ${M(e.attrs[t][0])}="${M(String(e.attrs[t][1]))}"`;return r}renderToken(e,t,n){let r=e[t],i=``;if(r.hidden)return``;let a=t-1;for(;a>=0&&e[a].hidden&&e[a].nesting===0;)a--;r.block&&r.nesting!==-1&&a>=0&&e[a].hidden&&e[a].nesting===-1&&(i+=`
`),i+=(r.nesting===-1?`</`:`<`)+r.tag,i+=this.renderAttrs(r),r.nesting===0&&n.xhtmlOut&&(i+=` /`);let o=!1;if(r.block&&(o=!0,r.nesting===1)){let n=t+1;for(;n<e.length&&e[n].hidden&&e[n].nesting===0;)n++;if(n<e.length){let t=e[n];(t.type===`inline`||t.hidden||t.nesting===-1&&t.tag===r.tag)&&(o=!1)}}return i+=o?`>
`:`>`,i}renderInline(e,t,n){let r=``,i=this.rules;for(let a=0,o=e.length;a<o;a++){let o=e[a].type;i[o]===void 0?r+=this.renderToken(e,a,t):r+=i[o](e,a,t,n,this)}return r}renderInlineAsText(e,t,n){let r=``;for(let i=0,a=e.length;i<a;i++)switch(e[i].type){case`text`:case`code_inline`:r+=e[i].content;break;case`image`:r+=this.renderInlineAsText(e[i].children,t,n);break;case`html_inline`:case`html_block`:r+=e[i].content;break;case`softbreak`:case`hardbreak`:r+=`
`}return r}render(e,t,n){let r=``,i=this.rules;for(let a=0,o=e.length;a<o;a++){let o=e[a].type;o===`inline`?r+=this.renderInline(e[a].children,t,n):i[o]===void 0?r+=this.renderToken(e,a,t):r+=i[o](e,a,t,n,this)}return r}},We=class{constructor(e,t,n){T(this,`tokens`,[]),T(this,`inlineMode`,!1),T(this,`Token`,z),this.src=e,this.env=n,this.md=t}},Ge=/\r\n?|\n/g,Ke=/\0/g;function qe(e){let t;t=e.src.replace(Ge,`
`),t=t.replace(Ke,`�`),e.src=t}function Je(e){let t;e.inlineMode?(t=new e.Token(`inline`,``,0),t.content=e.src,t.map=[0,1],t.children=[],e.tokens.push(t)):e.md.block.parse(e.src,e.md,e.env,e.tokens)}function Ye(e){let t=e.tokens,n=0;for(let e=0;e<t.length;e++)t[e].type!==`reference_definition`&&(e!==n&&(t[n]=t[e]),n++);t.length!==n&&(t.length=n)}function Xe(e){let t=e.tokens;for(let n=0,r=t.length;n<r;n++){let r=t[n];r.type===`inline`&&e.md.inline.parse(r.content,e.md,e.env,r.children)}}function Ze(e){return/^<a[>\s]/i.test(e)}function Qe(e){return/^<\/a\s*>/i.test(e)}function $e(e){let t=e.tokens;if(e.md.options.linkify)for(let n=0,r=t.length;n<r;n++){if(t[n].type!==`inline`||!e.md.linkify.test(t[n].content))continue;let r=t[n].children,i=0;for(let a=r.length-1;a>=0;a--){let o=r[a];if(o.type===`link_close`){for(a--;r[a].level!==o.level&&r[a].type!==`link_open`;)a--;continue}if(o.type===`html_inline`&&(Ze(o.content)&&i>0&&i--,Qe(o.content)&&i++),!(i>0)&&o.type===`text`&&e.md.linkify.test(o.content)){let i=o.content,s=e.md.linkify.match(i),c=[],l=o.level,u=0;s.length>0&&s[0].index===0&&a>0&&r[a-1].type===`text_special`&&(s=s.slice(1));for(let t=0;t<s.length;t++){let n=s[t].url,r=e.md.normalizeLink(n);if(!e.md.validateLink(r))continue;let a=s[t].text;a=s[t].schema?s[t].schema===`mailto:`&&!/^mailto:/i.test(a)?e.md.normalizeLinkText(`mailto:${a}`).replace(/^mailto:/,``):e.md.normalizeLinkText(a):e.md.normalizeLinkText(`http://${a}`).replace(/^http:\/\//,``);let o=s[t].index;if(o>u){let t=new e.Token(`text`,``,0);t.content=i.slice(u,o),t.level=l,c.push(t)}let d=new e.Token(`link_open`,`a`,1);d.attrs=[[`href`,r]],d.level=l++,d.markup=`linkify`,d.info=`auto`,c.push(d);let f=new e.Token(`text`,``,0);f.content=a,f.level=l,c.push(f);let p=new e.Token(`link_close`,`a`,-1);p.level=--l,p.markup=`linkify`,p.info=`auto`,c.push(p),u=s[t].lastIndex}if(u<i.length){let t=new e.Token(`text`,``,0);t.content=i.slice(u),t.level=l,c.push(t)}t[n].children=r=Ce(r,a,c)}}}}var et=/\+-|\.\.|\?\?\?\?|!!!!|,,|--/,tt=/\((c|tm|r)\)/i,nt=/\((c|tm|r)\)/gi,rt={c:`©`,r:`®`,tm:`™`};function it(e,t){return rt[t.toLowerCase()]}function at(e){let t=0;for(let n=e.length-1;n>=0;n--){let r=e[n];r.type===`text`&&!t&&(r.content=r.content.replace(nt,it)),r.type===`link_open`&&r.info===`auto`&&t--,r.type===`link_close`&&r.info===`auto`&&t++}}function ot(e){let t=0;for(let n=e.length-1;n>=0;n--){let r=e[n];r.type===`text`&&!t&&et.test(r.content)&&(r.content=r.content.replace(/\+-/g,`±`).replace(/\.{2,}/g,`…`).replace(/([?!])…/g,`$1..`).replace(/([?!]){4,}/g,`$1$1$1`).replace(/,{2,}/g,`,`).replace(/(^|[^-])---(?=[^-]|$)/gm,`$1—`).replace(/(^|\s)--(?=\s|$)/gm,`$1–`).replace(/(^|[^-\s])--(?=[^-\s]|$)/gm,`$1–`)),r.type===`link_open`&&r.info===`auto`&&t--,r.type===`link_close`&&r.info===`auto`&&t++}}function st(e){let t;if(e.md.options.typographer)for(t=e.tokens.length-1;t>=0;t--)e.tokens[t].type===`inline`&&(tt.test(e.tokens[t].content)&&at(e.tokens[t].children),et.test(e.tokens[t].content)&&ot(e.tokens[t].children))}var ct=/['"]/,lt=/['"]/g,ut=`’`;function H(e,t,n,r){e[t]||(e[t]=[]),e[t].push({pos:n,ch:r})}function dt(e,t){let n=``,r=0;t.sort((e,t)=>e.pos-t.pos);for(let i=0;i<t.length;i++){let a=t[i];n+=e.slice(r,a.pos)+a.ch,r=a.pos+1}return n+e.slice(r)}function ft(e,t){let n,r=[],i={};for(let a=0;a<e.length;a++){let o=e[a],s=e[a].level;for(n=r.length-1;n>=0&&!(r[n].level<=s);n--);if(r.length=n+1,o.type!==`text`)continue;let c=o.content,l=0,u=c.length;OUTER:for(;l<u;){lt.lastIndex=l;let o=lt.exec(c);if(!o)break;let d=!0,f=!0;l=o.index+1;let p=o[0]===`'`,m=32;if(o.index-1>=0)m=c.charCodeAt(o.index-1);else for(n=a-1;n>=0&&e[n].type!==`softbreak`&&e[n].type!==`hardbreak`;n--)if(e[n].content){m=e[n].content.charCodeAt(e[n].content.length-1);break}let h=32;if(l<u)h=c.charCodeAt(l);else for(n=a+1;n<e.length&&e[n].type!==`softbreak`&&e[n].type!==`hardbreak`;n++)if(e[n].content){h=e[n].content.charCodeAt(0);break}let g=I(m)||F(m),_=I(h)||F(h),v=P(m),y=P(h);if(y?d=!1:_&&(v||g||(d=!1)),v?f=!1:g&&(y||_||(f=!1)),h===34&&o[0]===`"`&&m>=48&&m<=57&&(f=d=!1),d&&f&&(d=g,f=_),!d&&!f){p&&H(i,a,o.index,ut);continue}if(f)for(n=r.length-1;n>=0;n--){let e=r[n];if(r[n].level<s)break;if(e.single===p&&r[n].level===s){e=r[n];let s,c;p?(s=t.md.options.quotes[2],c=t.md.options.quotes[3]):(s=t.md.options.quotes[0],c=t.md.options.quotes[1]),H(i,a,o.index,c),H(i,e.token,e.pos,s),r.length=n;continue OUTER}}d?r.push({token:a,pos:o.index,single:p,level:s}):f&&p&&H(i,a,o.index,ut)}}Object.keys(i).forEach(function(t){let n=Number(t);e[n].content=dt(e[n].content,i[t])})}function pt(e){if(e.md.options.typographer)for(let t=e.tokens.length-1;t>=0;t--)e.tokens[t].type!==`inline`||!ct.test(e.tokens[t].content)||ft(e.tokens[t].children,e)}function mt(e){let t,n,r=e.length;for(t=0;t<r;t++)e[t].type===`text_special`&&(e[t].type=`text`);for(t=n=0;t<r;t++)e[t].type===`text`&&t+1<r&&e[t+1].type===`text`?e[t+1].content=e[t].content+e[t+1].content:(t!==n&&(e[n]=e[t]),n++);t!==n&&(e.length=n)}function ht(e){let t,n,r=e.tokens,i=r.length;for(let e=0;e<i;e++){if(r[e].type!==`inline`)continue;let i=r[e].children,a=i.length;for(t=0;t<a;t++)i[t].type===`text_special`&&(i[t].type=`text`),i[t].children&&mt(i[t].children);for(t=n=0;t<a;t++)i[t].type===`text`&&t+1<a&&i[t+1].type===`text`?i[t+1].content=i[t].content+i[t+1].content:(t!==n&&(i[n]=i[t]),n++);t!==n&&(i.length=n)}}var U=[[`normalize`,qe],[`block`,Je],[`strip_references`,Ye],[`inline`,Xe],[`linkify`,$e],[`replacements`,st],[`smartquotes`,pt],[`text_join`,ht]],gt=class{constructor(){T(this,`ruler`,new B),T(this,`State`,We);for(let e=0;e<U.length;e++)this.ruler.push(U[e][0],U[e][1])}process(e){let t=this.ruler.getRules(``);for(let n=0,r=t.length;n<r;n++)t[n](e)}},_t=class{constructor(e,t,n,r){T(this,`bMarks`,[]),T(this,`eMarks`,[]),T(this,`tShift`,[]),T(this,`sCount`,[]),T(this,`bsCount`,[]),T(this,`blkIndent`,0),T(this,`line`,0),T(this,`lineMax`,0),T(this,`tight`,!1),T(this,`listIndent`,-1),T(this,`parentType`,`root`),T(this,`level`,0),T(this,`Token`,z),this.src=e,this.md=t,this.env=n,this.tokens=r;let i=this.src;for(let e=0,t=0,n=0,r=0,a=i.length,o=!1;t<a;t++){let s=i.charCodeAt(t);if(!o)if(N(s)){n++,s===9?r+=4-r%4:r++;continue}else o=!0;(s===10||t===a-1)&&(s!==10&&t++,this.bMarks.push(e),this.eMarks.push(t),this.tShift.push(n),this.sCount.push(r),this.bsCount.push(0),o=!1,n=0,r=0,e=t+1)}this.bMarks.push(i.length),this.eMarks.push(i.length),this.tShift.push(0),this.sCount.push(0),this.bsCount.push(0),this.lineMax=this.bMarks.length-1}push(e,t,n){let r=new z(e,t,n);return r.block=!0,n<0&&this.level--,r.level=this.level,n>0&&this.level++,this.tokens.push(r),r}isEmpty(e){return this.bMarks[e]+this.tShift[e]>=this.eMarks[e]}skipEmptyLines(e){for(let t=this.lineMax;e<t&&!(this.bMarks[e]+this.tShift[e]<this.eMarks[e]);e++);return e}skipSpaces(e){for(let t=this.src.length;e<t&&N(this.src.charCodeAt(e));e++);return e}skipSpacesBack(e,t){if(e<=t)return e;for(;e>t;)if(!N(this.src.charCodeAt(--e)))return e+1;return e}skipChars(e,t){for(let n=this.src.length;e<n&&this.src.charCodeAt(e)===t;e++);return e}skipCharsBack(e,t,n){if(e<=n)return e;for(;e>n;)if(t!==this.src.charCodeAt(--e))return e+1;return e}getLines(e,t,n,r){if(e>=t)return``;let i=Array(t-e);for(let a=0,o=e;o<t;o++,a++){let e=0,s=this.bMarks[o],c=s,l;for(l=o+1<t||r?this.eMarks[o]+1:this.eMarks[o];c<l&&e<n;){let t=this.src.charCodeAt(c);if(N(t))t===9?e+=4-(e+this.bsCount[o])%4:e++;else if(c-s<this.tShift[o])e++;else break;c++}e>n?i[a]=Array(e-n+1).join(` `)+this.src.slice(c,l):i[a]=this.src.slice(c,l)}return i.join(``)}},vt=65536;function W(e,t){let n=e.bMarks[t]+e.tShift[t],r=e.eMarks[t];return e.src.slice(n,r)}function yt(e){let t=[],n=e.length,r=0,i=e.charCodeAt(r),a=!1,o=0,s=``;for(;r<n;)i===124&&(a?(s+=e.substring(o,r-1),o=r):(t.push(s+e.substring(o,r)),s=``,o=r+1)),a=i===92,r++,i=e.charCodeAt(r);return t.push(s+e.substring(o)),t}function bt(e,t,n,r){if(t+2>n)return!1;let i=t+1;if(e.sCount[i]<e.blkIndent||e.sCount[i]-e.blkIndent>=4)return!1;let a=e.bMarks[i]+e.tShift[i];if(a>=e.eMarks[i])return!1;let o=e.src.charCodeAt(a++);if(o!==124&&o!==45&&o!==58||a>=e.eMarks[i])return!1;let s=e.src.charCodeAt(a++);if(s!==124&&s!==45&&s!==58&&!N(s)||o===45&&N(s))return!1;for(;a<e.eMarks[i];){let t=e.src.charCodeAt(a);if(t!==124&&t!==45&&t!==58&&!N(t))return!1;a++}let c=W(e,t+1),l=c.split(`|`),u=[];for(let e=0;e<l.length;e++){let t=l[e].trim();if(!t){if(e===0||e===l.length-1)continue;return!1}if(!/^:?-+:?$/.test(t))return!1;t.charCodeAt(t.length-1)===58?u.push(t.charCodeAt(0)===58?`center`:`right`):t.charCodeAt(0)===58?u.push(`left`):u.push(``)}if(c=W(e,t).trim(),c.indexOf(`|`)===-1||e.sCount[t]-e.blkIndent>=4)return!1;l=yt(c),l.length&&l[0]===``&&l.shift(),l.length&&l[l.length-1]===``&&l.pop();let d=l.length;if(d===0||d!==u.length)return!1;if(r)return!0;let f=e.parentType;e.parentType=`table`;let p=e.md.block.ruler.getRules(`blockquote`),m=e.push(`table_open`,`table`,1),h=[t,0];m.map=h;let g=e.push(`thead_open`,`thead`,1);g.map=[t,t+1];let _=e.push(`tr_open`,`tr`,1);_.map=[t,t+1];for(let t=0;t<l.length;t++){let n=e.push(`th_open`,`th`,1);u[t]&&(n.attrs=[[`style`,`text-align:${u[t]}`]]);let r=e.push(`inline`,``,0);r.content=l[t].trim(),r.children=[],e.push(`th_close`,`th`,-1)}e.push(`tr_close`,`tr`,-1),e.push(`thead_close`,`thead`,-1);let v,y=0;for(i=t+2;i<n&&!(e.sCount[i]<e.blkIndent);i++){let r=!1;for(let t=0,a=p.length;t<a;t++)if(p[t](e,i,n,!0)){r=!0;break}if(r||(c=W(e,i).trim(),!c)||e.sCount[i]-e.blkIndent>=4||(l=yt(c),l.length&&l[0]===``&&l.shift(),l.length&&l[l.length-1]===``&&l.pop(),y+=d-l.length,y>vt))break;if(i===t+2){let n=e.push(`tbody_open`,`tbody`,1);n.map=v=[t+2,0]}let a=e.push(`tr_open`,`tr`,1);a.map=[i,i+1];for(let t=0;t<d;t++){let n=e.push(`td_open`,`td`,1);u[t]&&(n.attrs=[[`style`,`text-align:${u[t]}`]]);let r=e.push(`inline`,``,0);r.content=l[t]?l[t].trim():``,r.children=[],e.push(`td_close`,`td`,-1)}e.push(`tr_close`,`tr`,-1)}return v&&(e.push(`tbody_close`,`tbody`,-1),v[1]=i),e.push(`table_close`,`table`,-1),h[1]=i,e.parentType=f,e.line=i,!0}function xt(e,t,n){if(e.sCount[t]-e.blkIndent<4)return!1;let r=t+1,i=r;for(;r<n;){if(e.isEmpty(r)){r++;continue}if(e.sCount[r]-e.blkIndent>=4){r++,i=r;continue}break}e.line=i;let a=e.push(`code_block`,`code`,0);return a.content=e.getLines(t,i,4+e.blkIndent,!1)+`
`,a.map=[t,e.line],!0}function St(e,t,n,r){let i=e.bMarks[t]+e.tShift[t],a=e.eMarks[t];if(e.sCount[t]-e.blkIndent>=4||i+3>a)return!1;let o=e.src.charCodeAt(i);if(o!==126&&o!==96)return!1;let s=i;i=e.skipChars(i,o);let c=i-s;if(c<3)return!1;let l=e.src.slice(s,i),u=e.src.slice(i,a);if(o===96&&u.indexOf(String.fromCharCode(o))>=0)return!1;if(r)return!0;let d=t,f=!1;for(;d++,!(d>=n||(i=s=e.bMarks[d]+e.tShift[d],a=e.eMarks[d],i<a&&e.sCount[d]<e.blkIndent));)if(e.src.charCodeAt(i)===o&&!(e.sCount[d]-e.blkIndent>=4)&&(i=e.skipChars(i,o),!(i-s<c)&&(i=e.skipSpaces(i),!(i<a)))){f=!0;break}c=e.sCount[t],e.line=d+ +!!f;let p=e.push(`fence`,`code`,0);return p.info=u,p.content=e.getLines(t+1,d,c,!0),p.markup=l,p.map=[t,e.line],!0}function Ct(e,t,n,r){let i=e.bMarks[t]+e.tShift[t],a=e.eMarks[t],o=e.lineMax;if(e.sCount[t]-e.blkIndent>=4||e.src.charCodeAt(i)!==62)return!1;if(r)return!0;let s=[],c=[],l=[],u=[],d=e.md.block.ruler.getRules(`blockquote`),f=e.parentType;e.parentType=`blockquote`;let p=!1,m;for(m=t;m<n;m++){let t=e.sCount[m]<e.blkIndent;if(i=e.bMarks[m]+e.tShift[m],a=e.eMarks[m],i>=a)break;if(e.src.charCodeAt(i++)===62&&!t){let t=e.sCount[m]+1,n,r;e.src.charCodeAt(i)===32?(i++,t++,r=!1,n=!0):e.src.charCodeAt(i)===9?(n=!0,(e.bsCount[m]+t)%4==3?(i++,t++,r=!1):r=!0):n=!1;let o=t;for(s.push(e.bMarks[m]),e.bMarks[m]=i;i<a;){let t=e.src.charCodeAt(i);if(N(t))t===9?o+=4-(o+e.bsCount[m]+ +!!r)%4:o++;else break;i++}p=i>=a,c.push(e.bsCount[m]),e.bsCount[m]=e.sCount[m]+1+ +!!n,l.push(e.sCount[m]),e.sCount[m]=o-t,u.push(e.tShift[m]),e.tShift[m]=i-e.bMarks[m];continue}if(p)break;let r=!1;for(let t=0,i=d.length;t<i;t++)if(d[t](e,m,n,!0)){r=!0;break}if(r){e.lineMax=m,e.blkIndent!==0&&(s.push(e.bMarks[m]),c.push(e.bsCount[m]),u.push(e.tShift[m]),l.push(e.sCount[m]),e.sCount[m]-=e.blkIndent);break}s.push(e.bMarks[m]),c.push(e.bsCount[m]),u.push(e.tShift[m]),l.push(e.sCount[m]),e.sCount[m]=-1}let h=e.blkIndent;e.blkIndent=0;let g=e.push(`blockquote_open`,`blockquote`,1);g.markup=`>`;let _=[t,0];g.map=_,e.md.block.tokenize(e,t,m);let v=e.push(`blockquote_close`,`blockquote`,-1);v.markup=`>`,e.lineMax=o,e.parentType=f,_[1]=e.line;for(let n=0;n<u.length;n++)e.bMarks[n+t]=s[n],e.tShift[n+t]=u[n],e.sCount[n+t]=l[n],e.bsCount[n+t]=c[n];return e.blkIndent=h,!0}function wt(e,t,n,r){let i=e.eMarks[t];if(e.sCount[t]-e.blkIndent>=4)return!1;let a=e.bMarks[t]+e.tShift[t],o=e.src.charCodeAt(a++);if(o!==42&&o!==45&&o!==95)return!1;let s=1;for(;a<i;){let t=e.src.charCodeAt(a++);if(t!==o&&!N(t))return!1;t===o&&s++}if(s<3)return!1;if(r)return!0;e.line=t+1;let c=e.push(`hr`,`hr`,0);return c.map=[t,e.line],c.markup=Array(s+1).join(String.fromCharCode(o)),!0}function Tt(e,t){let n=e.eMarks[t],r=e.bMarks[t]+e.tShift[t],i=e.src.charCodeAt(r++);return i!==42&&i!==45&&i!==43||r<n&&!N(e.src.charCodeAt(r))?-1:r}function Et(e,t){let n=e.bMarks[t]+e.tShift[t],r=e.eMarks[t],i=n;if(i+1>=r)return-1;let a=e.src.charCodeAt(i++);if(a<48||a>57)return-1;for(;;){if(i>=r)return-1;if(a=e.src.charCodeAt(i++),a>=48&&a<=57){if(i-n>=10)return-1;continue}if(a===41||a===46)break;return-1}return i<r&&(a=e.src.charCodeAt(i),!N(a))?-1:i}function Dt(e,t){let n=e.level+2;for(let r=t+2,i=e.tokens.length-2;r<i;r++)e.tokens[r].level===n&&e.tokens[r].type===`paragraph_open`&&(e.tokens[r+2].hidden=!0,e.tokens[r].hidden=!0,r+=2)}function Ot(e,t,n,r){let i,a,o,s,c=t,l=!0;if(e.sCount[c]-e.blkIndent>=4||e.listIndent>=0&&e.sCount[c]-e.listIndent>=4&&e.sCount[c]<e.blkIndent)return!1;let u=!1;r&&e.parentType===`paragraph`&&e.sCount[c]>=e.blkIndent&&(u=!0);let d,f,p;if((p=Et(e,c))>=0){if(d=!0,o=e.bMarks[c]+e.tShift[c],f=Number(e.src.slice(o,p-1)),u&&f!==1)return!1}else if((p=Tt(e,c))>=0)d=!1;else return!1;if(u&&e.skipSpaces(p)>=e.eMarks[c])return!1;if(r)return!0;let m=e.src.charCodeAt(p-1),h=e.tokens.length;d?(s=e.push(`ordered_list_open`,`ol`,1),f!==1&&(s.attrs=[[`start`,f]])):s=e.push(`bullet_list_open`,`ul`,1);let g=[c,0];s.map=g,s.markup=String.fromCharCode(m);let _=!1,v=e.md.block.ruler.getRules(`list`),y=e.parentType;for(e.parentType=`list`;c<n;){a=p,i=e.eMarks[c];let t=e.sCount[c]+p-(e.bMarks[c]+e.tShift[c]),r=t;for(;a<i;){let t=e.src.charCodeAt(a);if(t===9)r+=4-(r+e.bsCount[c])%4;else if(t===32)r++;else break;a++}let u=a,f;f=u>=i?1:r-t,f>4&&(f=1);let h=t+f;s=e.push(`list_item_open`,`li`,1),s.markup=String.fromCharCode(m);let g=[c,0];s.map=g,d&&(s.info=e.src.slice(o,p-1));let y=e.tight,b=e.tShift[c],ee=e.sCount[c],te=e.listIndent;if(e.listIndent=e.blkIndent,e.blkIndent=h,e.tight=!0,e.tShift[c]=u-e.bMarks[c],e.sCount[c]=r,u>=i&&e.isEmpty(c+1)?e.line=Math.min(e.line+2,n):e.md.block.tokenize(e,c,n),(!e.tight||_)&&(l=!1),_=e.line-c>1&&e.isEmpty(e.line-1),e.blkIndent=e.listIndent,e.listIndent=te,e.tShift[c]=b,e.sCount[c]=ee,e.tight=y,s=e.push(`list_item_close`,`li`,-1),s.markup=String.fromCharCode(m),c=e.line,g[1]=c,c>=n||e.sCount[c]<e.blkIndent||e.sCount[c]-e.blkIndent>=4)break;let x=!1;for(let t=0,r=v.length;t<r;t++)if(v[t](e,c,n,!0)){x=!0;break}if(x)break;if(d){if(p=Et(e,c),p<0)break;o=e.bMarks[c]+e.tShift[c]}else if(p=Tt(e,c),p<0)break;if(m!==e.src.charCodeAt(p-1))break}return s=d?e.push(`ordered_list_close`,`ol`,-1):e.push(`bullet_list_close`,`ul`,-1),s.markup=String.fromCharCode(m),g[1]=c,e.line=c,e.parentType=y,l&&Dt(e,h),!0}function kt(e,t,n,r){let i=e.bMarks[t]+e.tShift[t],a=e.eMarks[t],o=t+1;if(e.sCount[t]-e.blkIndent>=4||e.src.charCodeAt(i)!==91)return!1;function s(t){let n=e.lineMax;if(t>=n||e.isEmpty(t))return null;let r=!1;if(e.sCount[t]-e.blkIndent>3&&(r=!0),e.sCount[t]<0&&(r=!0),!r){let r=e.md.block.ruler.getRules(`reference`),i=e.parentType;e.parentType=`reference`;let a=!1;for(let i=0,o=r.length;i<o;i++)if(r[i](e,t,n,!0)){a=!0;break}if(e.parentType=i,a)return null}let i=e.bMarks[t]+e.tShift[t],a=e.eMarks[t];return e.src.slice(i,a+1)}let c=e.src.slice(i,a+1);a=c.length;let l=-1;for(i=1;i<a;i++){let e=c.charCodeAt(i);if(e===91)return!1;if(e===93){l=i;break}if(e===10){let e=s(o);e!==null&&(c+=e,a=c.length,o++)}else if(e===92&&(i++,i<a&&c.charCodeAt(i)===10)){let e=s(o);e!==null&&(c+=e,a=c.length,o++)}}if(l<0||c.charCodeAt(l+1)!==58)return!1;for(i=l+2;i<a;i++){let e=c.charCodeAt(i);if(e===10){let e=s(o);e!==null&&(c+=e,a=c.length,o++)}else if(!N(e))break}let u=e.md.helpers.parseLinkDestination(c,i,a);if(!u.ok)return!1;let d=e.md.normalizeLink(u.str);if(!e.md.validateLink(d))return!1;i=u.pos;let f=i,p=o,m=i;for(;i<a;i++){let e=c.charCodeAt(i);if(e===10){let e=s(o);e!==null&&(c+=e,a=c.length,o++)}else if(!N(e))break}let h=e.md.helpers.parseLinkTitle(c,i,a);for(;h.can_continue;){let t=s(o);if(t===null)break;c+=t,i=a,a=c.length,o++,h=e.md.helpers.parseLinkTitle(c,i,a,h)}let g;for(i<a&&m!==i&&h.ok?(g=h.str,i=h.pos):(g=``,i=f,o=p);i<a&&N(c.charCodeAt(i));)i++;if(i<a&&c.charCodeAt(i)!==10&&g)for(g=``,i=f,o=p;i<a&&N(c.charCodeAt(i));)i++;if(i<a&&c.charCodeAt(i)!==10)return!1;let _=L(c.slice(1,l));if(!_)return!1;if(r)return!0;e.env.references===void 0&&(e.env.references={}),e.env.references[_]===void 0&&(e.env.references[_]={title:g,href:d});let v=e.push(`reference_definition`,``,0);v.map=[t,o],v.hidden=!0;let y=Object.create(null);return y.label=_,v.meta=y,e.line=o,!0}var At=`address.article.aside.base.basefont.blockquote.body.caption.center.col.colgroup.dd.details.dialog.dir.div.dl.dt.fieldset.figcaption.figure.footer.form.frame.frameset.h1.h2.h3.h4.h5.h6.head.header.hr.html.iframe.legend.li.link.main.menu.menuitem.nav.noframes.ol.optgroup.option.p.param.search.section.summary.table.tbody.td.tfoot.th.thead.title.tr.track.ul`.split(`.`),jt=`<[A-Za-z][A-Za-z0-9\\-]*(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?)*\\s*\\/?>`,Mt=`<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>`,Nt=RegExp(`^(?:${jt}|${Mt}|<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->|<[?][\\s\\S]*?[?]>|<![A-Za-z][^>]*>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)`),Pt=RegExp(`^(?:${jt}|${Mt})`),G=[[/^<(script|pre|style|textarea)(?=(\s|>|$))/i,/<\/(script|pre|style|textarea)>/i,!0],[/^<!--/,/-->/,!0],[/^<\?/,/\?>/,!0],[/^<![A-Za-z]/,/>/,!0],[/^<!\[CDATA\[/,/\]\]>/,!0],[RegExp(`^</?(${At.join(`|`)})(?=(\\s|/?>|$))`,`i`),/^$/,!0],[RegExp(`${Pt.source}\\s*$`),/^$/,!1]];function Ft(e,t,n,r){let i=e.bMarks[t]+e.tShift[t],a=e.eMarks[t];if(e.sCount[t]-e.blkIndent>=4||!e.md.options.html||e.src.charCodeAt(i)!==60)return!1;let o=e.src.slice(i,a),s=0;for(;s<G.length&&!G[s][0].test(o);s++);if(s===G.length)return!1;if(r)return G[s][2];let c=t+1,l=G[s][1].test(``);if(!G[s][1].test(o)){for(;c<n&&!(e.sCount[c]<e.blkIndent&&(l||!e.isEmpty(c)));c++)if(i=e.bMarks[c]+e.tShift[c],a=e.eMarks[c],o=e.src.slice(i,a),G[s][1].test(o)){o.length!==0&&c++;break}}e.line=c;let u=e.push(`html_block`,``,0);return u.map=[t,c],u.content=e.getLines(t,c,e.blkIndent,!0),!0}function It(e,t,n,r){let i=e.bMarks[t]+e.tShift[t],a=e.eMarks[t];if(e.sCount[t]-e.blkIndent>=4)return!1;let o=e.src.charCodeAt(i);if(o!==35||i>=a)return!1;let s=1;for(o=e.src.charCodeAt(++i);o===35&&i<a&&s<=6;)s++,o=e.src.charCodeAt(++i);if(s>6||i<a&&!N(o))return!1;if(r)return!0;a=e.skipSpacesBack(a,i);let c=e.skipCharsBack(a,35,i);c>i&&N(e.src.charCodeAt(c-1))&&(a=c),e.line=t+1;let l=e.push(`heading_open`,`h${s}`,1);l.markup=`########`.slice(0,s),l.map=[t,e.line];let u=e.push(`inline`,``,0);u.content=R(e.src.slice(i,a)),u.map=[t,e.line],u.children=[];let d=e.push(`heading_close`,`h${s}`,-1);return d.markup=`########`.slice(0,s),!0}function Lt(e,t,n){let r=e.md.block.ruler.getRules(`paragraph`);if(e.sCount[t]-e.blkIndent>=4)return!1;let i=e.parentType;e.parentType=`paragraph`;let a=0,o,s=t+1;for(;s<n&&!e.isEmpty(s);s++){if(e.sCount[s]-e.blkIndent>3)continue;if(e.sCount[s]>=e.blkIndent){let t=e.bMarks[s]+e.tShift[s],n=e.eMarks[s];if(t<n&&(o=e.src.charCodeAt(t),(o===45||o===61)&&(t=e.skipChars(t,o),t=e.skipSpaces(t),t>=n))){a=o===61?1:2;break}}if(e.sCount[s]<0)continue;let t=!1;for(let i=0,a=r.length;i<a;i++)if(r[i](e,s,n,!0)){t=!0;break}if(t)break}if(!a)return e.parentType=i,!1;let c=R(e.getLines(t,s,e.blkIndent,!1));e.line=s+1;let l=e.push(`heading_open`,`h${a}`,1);l.markup=String.fromCharCode(o),l.map=[t,e.line];let u=e.push(`inline`,``,0);u.content=c,u.map=[t,e.line-1],u.children=[];let d=e.push(`heading_close`,`h${a}`,-1);return d.markup=String.fromCharCode(o),e.parentType=i,!0}function Rt(e,t,n){let r=e.md.block.ruler.getRules(`paragraph`),i=e.parentType,a=t+1;for(e.parentType=`paragraph`;a<n&&!e.isEmpty(a);a++){if(e.sCount[a]-e.blkIndent>3||e.sCount[a]<0)continue;let t=!1;for(let i=0,o=r.length;i<o;i++)if(r[i](e,a,n,!0)){t=!0;break}if(t)break}let o=R(e.getLines(t,a,e.blkIndent,!1));e.line=a;let s=e.push(`paragraph_open`,`p`,1);s.map=[t,e.line];let c=e.push(`inline`,``,0);return c.content=o,c.map=[t,e.line],c.children=[],e.push(`paragraph_close`,`p`,-1),e.parentType=i,!0}var K=[[`table`,bt,[`paragraph`,`reference`]],[`code`,xt],[`fence`,St,[`paragraph`,`reference`,`blockquote`,`list`]],[`blockquote`,Ct,[`paragraph`,`reference`,`blockquote`,`list`]],[`hr`,wt,[`paragraph`,`reference`,`blockquote`,`list`]],[`list`,Ot,[`paragraph`,`reference`,`blockquote`]],[`reference`,kt],[`html_block`,Ft,[`paragraph`,`reference`,`blockquote`]],[`heading`,It,[`paragraph`,`reference`,`blockquote`]],[`lheading`,Lt],[`paragraph`,Rt]],zt=class{constructor(){T(this,`ruler`,new B),T(this,`State`,_t);for(let e=0;e<K.length;e++)this.ruler.push(K[e][0],K[e][1],{alt:(K[e][2]||[]).slice()})}tokenize(e,t,n){let r=this.ruler.getRules(``),i=r.length,a=e.md.options.maxNesting,o=t,s=!1;for(;o<n&&(e.line=o=e.skipEmptyLines(o),!(o>=n||e.sCount[o]<e.blkIndent));){if(e.level>=a){e.line=n;break}let t=e.line,c=!1;for(let a=0;a<i;a++)if(c=r[a](e,o,n,!1),c){if(t>=e.line)throw Error(`block rule didn't increment state.line`);break}if(!c)throw Error(`none of the block rules matched`);e.tight=!s,e.isEmpty(e.line-1)&&(s=!0),o=e.line,o<n&&e.isEmpty(o)&&(s=!0,o++,e.line=o)}}parse(e,t,n,r){if(!e)return;let i=new this.State(e,t,n,r);this.tokenize(i,i.line,i.lineMax)}},Bt=class{constructor(e,t,n,r){T(this,`pos`,0),T(this,`level`,0),T(this,`pending`,``),T(this,`pendingLevel`,0),T(this,`cache`,{}),T(this,`backticks`,{}),T(this,`backticksScanned`,!1),T(this,`linkLevel`,0),T(this,`delimiters`,[]),T(this,`_prev_delimiters`,[]),T(this,`Token`,z),this.src=e,this.env=n,this.md=t,this.tokens=r,this.tokens_meta=Array(r.length),this.posMax=this.src.length}pushPending(){let e=new z(`text`,``,0);return e.content=this.pending,e.level=this.pendingLevel,this.tokens.push(e),this.pending=``,e}push(e,t,n){this.pending&&this.pushPending();let r=new z(e,t,n),i;return n<0&&(this.level--,this.delimiters=this._prev_delimiters.pop()),r.level=this.level,n>0&&(this.level++,this._prev_delimiters.push(this.delimiters),this.delimiters=[],i={delimiters:this.delimiters}),this.pendingLevel=this.level,this.tokens.push(r),this.tokens_meta.push(i),r}scanDelims(e,t){let n=this.posMax,r=this.src.charCodeAt(e),i;if(e===0)i=32;else if(e===1)i=this.src.charCodeAt(0),(i&63488)==55296&&(i=65533);else if(i=this.src.charCodeAt(e-1),(i&64512)==56320){let t=this.src.charCodeAt(e-2);i=(t&64512)==55296?65536+(t-55296<<10)+(i-56320):65533}else(i&64512)==55296&&(i=65533);let a=e;for(;a<n&&this.src.charCodeAt(a)===r;)a++;let o=a-e,s=a<n?this.src.charCodeAt(a):32;if((s&64512)==55296){let e=this.src.charCodeAt(a+1);s=(e&64512)==56320?65536+(s-55296<<10)+(e-56320):65533}else(s&64512)==56320&&(s=65533);let c=I(i)||F(i),l=I(s)||F(s),u=P(i),d=P(s),f=!d&&(!l||u||c),p=!u&&(!c||d||l);return{can_open:f&&(t||!p||c),can_close:p&&(t||!f||l),length:o}}};function Vt(e){switch(e){case 10:case 33:case 35:case 36:case 37:case 38:case 42:case 43:case 45:case 58:case 60:case 61:case 62:case 64:case 91:case 92:case 93:case 94:case 95:case 96:case 123:case 125:case 126:return!0;default:return!1}}function Ht(e,t){let n=e.pos;for(;n<e.posMax&&!Vt(e.src.charCodeAt(n));)n++;return n!==e.pos&&(t||(e.pending+=e.src.slice(e.pos,n)),e.pos=n,!0)}var Ut=/(?:^|[^a-z0-9.+-])([a-z][a-z0-9.+-]*)$/i;function Wt(e,t){if(!e.md.options.linkify||e.linkLevel>0)return!1;let n=e.pos,r=e.posMax;if(n+3>r||e.src.charCodeAt(n)!==58||e.src.charCodeAt(n+1)!==47||e.src.charCodeAt(n+2)!==47)return!1;let i=e.pending.match(Ut);if(!i)return!1;let a=i[1],o=e.md.linkify.matchAtStart(e.src.slice(n-a.length));if(!o)return!1;let s=o.url;if(s.length<=a.length)return!1;let c=s.length;for(;c>0&&s.charCodeAt(c-1)===42;)c--;c!==s.length&&(s=s.slice(0,c));let l=e.md.normalizeLink(s);if(!e.md.validateLink(l))return!1;if(!t){e.pending=e.pending.slice(0,-a.length);let t=e.push(`link_open`,`a`,1);t.attrs=[[`href`,l]],t.markup=`linkify`,t.info=`auto`;let n=e.push(`text`,``,0);n.content=e.md.normalizeLinkText(s);let r=e.push(`link_close`,`a`,-1);r.markup=`linkify`,r.info=`auto`}return e.pos+=s.length-a.length,!0}function Gt(e,t){let n=e.pos;if(e.src.charCodeAt(n)!==10)return!1;let r=e.pending.length-1,i=e.posMax;if(!t)if(r>=0&&e.pending.charCodeAt(r)===32)if(r>=1&&e.pending.charCodeAt(r-1)===32){let t=r-1;for(;t>=1&&e.pending.charCodeAt(t-1)===32;)t--;e.pending=e.pending.slice(0,t),e.push(`hardbreak`,`br`,0)}else e.pending=e.pending.slice(0,-1),e.push(`softbreak`,`br`,0);else e.push(`softbreak`,`br`,0);for(n++;n<i&&N(e.src.charCodeAt(n));)n++;return e.pos=n,!0}var Kt=[];for(let e=0;e<256;e++)Kt.push(0);`\\!"#$%&'()*+,./:;<=>?@[]^_\`{|}~-`.split(``).forEach(function(e){Kt[e.charCodeAt(0)]=1});function qt(e,t){let n=e.pos,r=e.posMax;if(e.src.charCodeAt(n)!==92||(n++,n>=r))return!1;let i=e.src.charCodeAt(n);if(i===10){for(t||e.push(`hardbreak`,`br`,0),n++;n<r&&(i=e.src.charCodeAt(n),N(i));)n++;return e.pos=n,!0}if(i===32){if(!t){let t=e.push(`text_special`,``,0);t.content=`\\`,t.markup=`\\`,t.info=`escape`}return e.pos=n,!0}let a=e.src[n];if(i>=55296&&i<=56319&&n+1<r){let t=e.src.charCodeAt(n+1);t>=56320&&t<=57343&&(a+=e.src[n+1],n++)}let o=`\\`+a;if(!t){let t=e.push(`text_special`,``,0);t.content=i<256&&Kt[i]!==0?a:o,t.markup=o,t.info=`escape`}return e.pos=n+1,!0}function Jt(e,t){let n=e.pos;if(e.src.charCodeAt(n)!==96)return!1;let r=n;n++;let i=e.posMax;for(;n<i&&e.src.charCodeAt(n)===96;)n++;let a=e.src.slice(r,n),o=a.length;if(e.backticksScanned&&(e.backticks[o]||0)<=r)return t||(e.pending+=a),e.pos+=o,!0;let s=n,c;for(;(c=e.src.indexOf("`",s))!==-1;){for(s=c+1;s<i&&e.src.charCodeAt(s)===96;)s++;let r=s-c;if(r===o){if(!t){let t=e.push(`code_inline`,`code`,0);t.markup=a,t.content=e.src.slice(n,c).replace(/\n/g,` `).replace(/^ (.+) $/,`$1`)}return e.pos=s,!0}e.backticks[r]=c}return e.backticksScanned=!0,t||(e.pending+=a),e.pos+=o,!0}function Yt(e,t){let n=e.pos,r=e.src.charCodeAt(n);if(t||r!==126)return!1;let i=e.scanDelims(e.pos,!0),a=i.length,o=String.fromCharCode(r);if(a<2)return!1;let s;a%2&&(s=e.push(`text`,``,0),s.content=o,a--);for(let t=0;t<a;t+=2)s=e.push(`text`,``,0),s.content=o+o,e.delimiters.push({marker:r,length:0,token:e.tokens.length-1,end:-1,open:i.can_open,close:i.can_close});return e.pos+=i.length,!0}function Xt(e,t){let n,r=[],i=t.length;for(let a=0;a<i;a++){let i=t[a];if(i.marker!==126||i.end===-1)continue;let o=t[i.end];n=e.tokens[i.token],n.type=`s_open`,n.tag=`s`,n.nesting=1,n.markup=`~~`,n.content=``,n=e.tokens[o.token],n.type=`s_close`,n.tag=`s`,n.nesting=-1,n.markup=`~~`,n.content=``,e.tokens[o.token-1].type===`text`&&e.tokens[o.token-1].content===`~`&&r.push(o.token-1)}for(;r.length;){let t=r.pop(),i=t+1;for(;i<e.tokens.length&&e.tokens[i].type===`s_close`;)i++;i--,t!==i&&(n=e.tokens[i],e.tokens[i]=e.tokens[t],e.tokens[t]=n)}}function Zt(e){let t=e.tokens_meta,n=e.tokens_meta.length;Xt(e,e.delimiters);for(let i=0;i<n;i++){var r;let n=(r=t[i])==null?void 0:r.delimiters;n&&Xt(e,n)}}var Qt={tokenize:Yt,postProcess:Zt};function $t(e,t){let n=e.pos,r=e.src.charCodeAt(n);if(t||r!==95&&r!==42)return!1;let i=e.scanDelims(e.pos,r===42);for(let t=0;t<i.length;t++){let t=e.push(`text`,``,0);t.content=String.fromCharCode(r),e.delimiters.push({marker:r,length:i.length,token:e.tokens.length-1,end:-1,open:i.can_open,close:i.can_close})}return e.pos+=i.length,!0}function en(e,t){let n=t.length;for(let r=n-1;r>=0;r--){let n=t[r];if(n.marker!==95&&n.marker!==42||n.end===-1)continue;let i=t[n.end],a=r>0&&t[r-1].end===n.end+1&&t[r-1].marker===n.marker&&t[r-1].token===n.token-1&&t[n.end+1].token===i.token+1,o=String.fromCharCode(n.marker),s=e.tokens[n.token];s.type=a?`strong_open`:`em_open`,s.tag=a?`strong`:`em`,s.nesting=1,s.markup=a?o+o:o,s.content=``;let c=e.tokens[i.token];c.type=a?`strong_close`:`em_close`,c.tag=a?`strong`:`em`,c.nesting=-1,c.markup=a?o+o:o,c.content=``,a&&(e.tokens[t[r-1].token].content=``,e.tokens[t[n.end+1].token].content=``,r--)}}function tn(e){let t=e.tokens_meta,n=e.tokens_meta.length;en(e,e.delimiters);for(let i=0;i<n;i++){var r;let n=(r=t[i])==null?void 0:r.delimiters;n&&en(e,n)}}var nn={tokenize:$t,postProcess:tn};function rn(e,t){let n,r,i,a,o=``,s=``,c=e.pos,l=!0;if(e.src.charCodeAt(e.pos)!==91)return!1;let u=e.pos,d=e.posMax,f=e.pos+1,p=e.md.helpers.parseLinkLabel(e,e.pos,!0);if(p<0)return!1;let m=p+1;if(m<d&&e.src.charCodeAt(m)===40){for(l=!1,m++;m<d&&(n=e.src.charCodeAt(m),!(!N(n)&&n!==10));m++);if(m>=d)return!1;if(c=m,i=e.md.helpers.parseLinkDestination(e.src,m,e.posMax),i.ok){for(o=e.md.normalizeLink(i.str),e.md.validateLink(o)?m=i.pos:o=``,c=m;m<d&&(n=e.src.charCodeAt(m),!(!N(n)&&n!==10));m++);if(i=e.md.helpers.parseLinkTitle(e.src,m,e.posMax),m<d&&c!==m&&i.ok)for(s=i.str,m=i.pos;m<d&&(n=e.src.charCodeAt(m),!(!N(n)&&n!==10));m++);}(m>=d||e.src.charCodeAt(m)!==41)&&(l=!0),m++}if(l){if(e.env.references===void 0)return!1;if(m<d&&e.src.charCodeAt(m)===91?(c=m+1,m=e.md.helpers.parseLinkLabel(e,m),m>=0?r=e.src.slice(c,m++):m=p+1):m=p+1,r||(r=e.src.slice(f,p)),r=L(r),a=e.env.references[r],!a)return e.pos=u,!1;o=a.href,s=a.title}if(!t){e.pos=f,e.posMax=p;let t=e.push(`link_open`,`a`,1),n=[[`href`,o]];if(t.attrs=n,s&&n.push([`title`,s]),r){let e=Object.create(null);e.label=r,t.meta=e}e.linkLevel++,e.md.inline.tokenize(e),e.linkLevel--,e.push(`link_close`,`a`,-1)}return e.pos=m,e.posMax=d,!0}function an(e,t){let n,r,i,a,o,s,c,l,u=``,d=e.pos,f=e.posMax;if(e.src.charCodeAt(e.pos)!==33||e.src.charCodeAt(e.pos+1)!==91)return!1;let p=e.pos+2,m=e.md.helpers.parseLinkLabel(e,e.pos+1,!1);if(m<0)return!1;if(a=m+1,a<f&&e.src.charCodeAt(a)===40){for(a++;a<f&&(n=e.src.charCodeAt(a),!(!N(n)&&n!==10));a++);if(a>=f)return!1;for(l=a,s=e.md.helpers.parseLinkDestination(e.src,a,e.posMax),s.ok&&(u=e.md.normalizeLink(s.str),e.md.validateLink(u)?a=s.pos:u=``),l=a;a<f&&(n=e.src.charCodeAt(a),!(!N(n)&&n!==10));a++);if(s=e.md.helpers.parseLinkTitle(e.src,a,e.posMax),a<f&&l!==a&&s.ok)for(c=s.str,a=s.pos;a<f&&(n=e.src.charCodeAt(a),!(!N(n)&&n!==10));a++);else c=``;if(a>=f||e.src.charCodeAt(a)!==41)return e.pos=d,!1;a++}else{if(e.env.references===void 0)return!1;if(a<f&&e.src.charCodeAt(a)===91?(l=a+1,a=e.md.helpers.parseLinkLabel(e,a),a>=0?i=e.src.slice(l,a++):a=m+1):a=m+1,i||(i=e.src.slice(p,m)),i=L(i),o=e.env.references[i],!o)return e.pos=d,!1;u=o.href,c=o.title}if(!t){r=e.src.slice(p,m);let t=[];e.md.inline.parse(r,e.md,e.env,t);let n=e.push(`image`,`img`,0),a=[[`src`,u],[`alt`,``]];if(n.attrs=a,n.children=t,n.content=r,c&&a.push([`title`,c]),i){let e=Object.create(null);e.label=i,n.meta=e}}return e.pos=a,e.posMax=f,!0}var on=/^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/,sn=/^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^<>\x00-\x20]*)$/;function cn(e,t){let n=e.pos;if(e.src.charCodeAt(n)!==60)return!1;let r=e.pos,i=e.posMax;for(;;){if(++n>=i)return!1;let t=e.src.charCodeAt(n);if(t===60)return!1;if(t===62)break}let a=e.src.slice(r+1,n);if(sn.test(a)){let n=e.md.normalizeLink(a);if(!e.md.validateLink(n))return!1;if(!t){let t=e.push(`link_open`,`a`,1);t.attrs=[[`href`,n]],t.markup=`autolink`,t.info=`auto`;let r=e.push(`text`,``,0);r.content=e.md.normalizeLinkText(a);let i=e.push(`link_close`,`a`,-1);i.markup=`autolink`,i.info=`auto`}return e.pos+=a.length+2,!0}if(on.test(a)){let n=e.md.normalizeLink(`mailto:${a}`);if(!e.md.validateLink(n))return!1;if(!t){let t=e.push(`link_open`,`a`,1);t.attrs=[[`href`,n]],t.markup=`autolink`,t.info=`auto`;let r=e.push(`text`,``,0);r.content=e.md.normalizeLinkText(a);let i=e.push(`link_close`,`a`,-1);i.markup=`autolink`,i.info=`auto`}return e.pos+=a.length+2,!0}return!1}function ln(e){return/^<a[>\s]/i.test(e)}function un(e){return/^<\/a\s*>/i.test(e)}function dn(e){let t=e|32;return t>=97&&t<=122}function fn(e,t){if(!e.md.options.html)return!1;let n=e.posMax,r=e.pos;if(e.src.charCodeAt(r)!==60||r+2>=n)return!1;let i=e.src.charCodeAt(r+1);if(i!==33&&i!==63&&i!==47&&!dn(i))return!1;let a=e.src.slice(r).match(Nt);if(!a)return!1;if(!t){let t=e.push(`html_inline`,``,0);t.content=a[0],ln(t.content)&&e.linkLevel++,un(t.content)&&e.linkLevel--}return e.pos+=a[0].length,!0}var pn=/^&#((?:x[a-f0-9]{1,6}|[0-9]{1,7}));/i,mn=/^&([a-z][a-z0-9]{1,31});/i;function hn(e,t){let n=e.pos,r=e.posMax;if(e.src.charCodeAt(n)!==38||n+1>=r)return!1;if(e.src.charCodeAt(n+1)===35){let r=e.src.slice(n).match(pn);if(r){if(!t){let t=r[1][0].toLowerCase()===`x`?parseInt(r[1].slice(1),16):parseInt(r[1],10),n=e.push(`text_special`,``,0);n.content=we(t)?A(t):A(65533),n.markup=r[0],n.info=`entity`}return e.pos+=r[0].length,!0}}else{let r=e.src.slice(n).match(mn);if(r){let n=be(r[0]);if(n!==r[0]){if(!t){let t=e.push(`text_special`,``,0);t.content=n,t.markup=r[0],t.info=`entity`}return e.pos+=r[0].length,!0}}}return!1}function gn(e){let t={},n=e.length;if(!n)return;let r=0,i=-2,a=[];for(let o=0;o<n;o++){let n=e[o];if(a.push(0),(e[r].marker!==n.marker||i!==n.token-1)&&(r=o),i=n.token,n.length=n.length||0,!n.close)continue;t.hasOwnProperty(n.marker)||(t[n.marker]=[-1,-1,-1,-1,-1,-1]);let s=t[n.marker][(n.open?3:0)+n.length%3],c=r-a[r]-1,l=c;for(;c>s;c-=a[c]+1){let t=e[c];if(t.marker===n.marker&&t.open&&t.end<0){let r=!1;if((t.close||n.open)&&(t.length+n.length)%3==0&&(t.length%3!=0||n.length%3!=0)&&(r=!0),!r){let r=c>0&&!e[c-1].open?a[c-1]+1:0;a[o]=o-c+r,a[c]=r,n.open=!1,t.end=o,t.close=!1,l=-1,i=-2;break}}}l!==-1&&(t[n.marker][(n.open?3:0)+(n.length||0)%3]=l)}}function _n(e){let t=e.tokens_meta,n=e.tokens_meta.length;gn(e.delimiters);for(let e=0;e<n;e++){var r;let n=(r=t[e])==null?void 0:r.delimiters;n&&gn(n)}}function vn(e){let t,n,r=0,i=e.tokens,a=e.tokens.length;for(t=n=0;t<a;t++)i[t].nesting<0&&r--,i[t].level=r,i[t].nesting>0&&r++,i[t].type===`text`&&t+1<a&&i[t+1].type===`text`?i[t+1].content=i[t].content+i[t+1].content:(t!==n&&(i[n]=i[t]),n++);t!==n&&(i.length=n)}var yn=[[`text`,Ht],[`linkify`,Wt],[`newline`,Gt],[`escape`,qt],[`backticks`,Jt],[`strikethrough`,Qt.tokenize],[`emphasis`,nn.tokenize],[`link`,rn],[`image`,an],[`autolink`,cn],[`html_inline`,fn],[`entity`,hn]],bn=[[`balance_pairs`,_n],[`strikethrough`,Qt.postProcess],[`emphasis`,nn.postProcess],[`fragments_join`,vn]],xn=class{constructor(){T(this,`ruler`,new B),T(this,`ruler2`,new B),T(this,`State`,Bt);for(let e=0;e<yn.length;e++)this.ruler.push(yn[e][0],yn[e][1]);for(let e=0;e<bn.length;e++)this.ruler2.push(bn[e][0],bn[e][1])}skipToken(e){let t=e.pos,n=this.ruler.getRules(``),r=n.length,i=e.md.options.maxNesting,a=e.cache;if(a[t]!==void 0){e.pos=a[t];return}let o=!1;if(e.level<i){for(let i=0;i<r;i++)if(e.level++,o=n[i](e,!0),e.level--,o){if(t>=e.pos)throw Error(`inline rule didn't increment state.pos`);break}}else e.pos=e.posMax;o||e.pos++,a[t]=e.pos}tokenize(e){let t=this.ruler.getRules(``),n=t.length,r=e.posMax,i=e.md.options.maxNesting;for(;e.pos<r;){let a=e.pos,o=!1;if(e.level<i){for(let r=0;r<n;r++)if(o=t[r](e,!1),o){if(a>=e.pos)throw Error(`inline rule didn't increment state.pos`);break}}if(o){if(e.pos>=r)break;continue}e.pending+=e.src[e.pos++]}e.pending&&e.pushPending()}parse(e,t,n,r){let i=new this.State(e,t,n,r);this.tokenize(i);let a=this.ruler2.getRules(``),o=a.length;for(let e=0;e<o;e++)a[e](i)}};function Sn(e,t){var n=Object.keys(e);if(Object.getOwnPropertySymbols){var r=Object.getOwnPropertySymbols(e);t&&(r=r.filter(function(t){return Object.getOwnPropertyDescriptor(e,t).enumerable})),n.push.apply(n,r)}return n}function q(e){for(var t=1;t<arguments.length;t++){var n=arguments[t]==null?{}:arguments[t];t%2?Sn(Object(n),!0).forEach(function(t){T(e,t,n[t])}):Object.getOwnPropertyDescriptors?Object.defineProperties(e,Object.getOwnPropertyDescriptors(n)):Sn(Object(n)).forEach(function(t){Object.defineProperty(e,t,Object.getOwnPropertyDescriptor(n,t))})}return e}function Cn(e,t){if(e==null)return{};var n={};for(var r in e)if({}.hasOwnProperty.call(e,r)){if(t.includes(r))continue;n[r]=e[r]}return n}function wn(e,t){if(e==null)return{};var n,r,i=Cn(e,t);if(Object.getOwnPropertySymbols){var a=Object.getOwnPropertySymbols(e);for(r=0;r<a.length;r++)n=a[r],t.includes(n)||{}.propertyIsEnumerable.call(e,n)&&(i[n]=e[n])}return i}var Tn=[`rebuilder`],En=class{constructor(e={}){T(this,`src_Any`,x.source),T(this,`src_Cc`,ne.source),T(this,`src_Z`,ae.source),T(this,`src_P`,S.source),T(this,`src_ZPCc`,[this.src_Z,this.src_P,this.src_Cc].join(`|`)),T(this,`src_ZCc`,[this.src_Z,this.src_Cc].join(`|`)),T(this,`cache`,{}),T(this,`opts`,{maxLength:1e4,urlAuth:!1,schema_names:[]}),this.opts=q(q({},this.opts),e)}set(e={}){return this.opts=q(q({},this.opts),e),this.cache={},this}escapeRE(e){return e.replace(/[.?*+^$[\]\\(){}|-]/g,`\\$&`)}nestedPairRE(e,t,n=4){let r=this.escapeRE(e),i=this.escapeRE(t),a=`(?:(?!${this.src_ZCc}|${r}|${i}).)`,o=`${r}${a}{0,1000}${i}`;for(let e=2;e<=n;e++)o=`${r}(?:${a}|${o}){0,1000}${i}`;return o}get_text_separators(){var e,t;return(t=(e=this.cache).text_separators)==null?e.text_separators=/[><\uff5c]/:t}get_pseudo_letter(){var e,t;return(t=(e=this.cache).src_pseudo_letter)==null?e.src_pseudo_letter=RegExp(`(?:(?!${this.get_text_separators().source}|${this.src_ZPCc})${this.src_Any})`):t}get_ipv4_addr(){var e,t;return(t=(e=this.cache).src_ip4)==null?e.src_ip4=RegExp(`(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])[.]){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])`):t}get_ipv6_addr(){var e,t;let n=`[0-9A-Fa-f]{1,4}`,r=`(?:(?:${n}:${n})|${this.get_ipv4_addr().source})`;return(t=(e=this.cache).src_ip6_addr)==null?e.src_ip6_addr=RegExp(`(?:(?:${n}:){6}${r}|::(?:${n}:){5}${r}|(?:${n})?::(?:${n}:){4}${r}|(?:(?:${n}:){0,1}${n})?::(?:${n}:){3}${r}|(?:(?:${n}:){0,2}${n})?::(?:${n}:){2}${r}|(?:(?:${n}:){0,3}${n})?::${n}:${r}|(?:(?:${n}:){0,4}${n})?::${r}|(?:(?:${n}:){0,5}${n})?::${n}|(?:(?:${n}:){0,6}${n})?::)`):t}get_ipv6_url_host(){var e,t;return(t=(e=this.cache).src_ip6_host)==null?e.src_ip6_host=RegExp(`\\[${this.get_ipv6_addr().source}\\]`):t}get_ipv6_mail_host(){var e,t;return(t=(e=this.cache).src_ipv6_mail_host)==null?e.src_ipv6_mail_host=RegExp(`\\[IPv6:${this.get_ipv6_addr().source}\\]`):t}get_auth(){var e,t;return(t=(e=this.cache).src_auth)==null?e.src_auth=RegExp(`(?:(?:(?!${this.src_ZCc}|[@/\\[\\]()]).){1,50}@)?`):t}get_port(){var e,t;return(t=(e=this.cache).src_port)==null?e.src_port=RegExp(`(?::(?:6(?:[0-4]\\d{3}|5(?:[0-4]\\d{2}|5(?:[0-2]\\d|3[0-5])))|[1-5]?\\d{1,4}))?`):t}get_host_terminator(){var e,t;return(t=(e=this.cache).src_host_terminator)==null?e.src_host_terminator=RegExp(`(?=$|${this.get_text_separators().source}|${this.src_ZPCc})(?!${this.opts[`---`]?`-(?!--)|`:`-|`}_|:\\d|\\.-|\\.(?!$|${this.src_ZPCc}))`):t}get_path_terminator(){var e,t;return(t=(e=this.cache).src_path_terminator)==null?e.src_path_terminator=RegExp(`${this.src_ZPCc}|${this.get_text_separators().source}`):t}get_path(){var e,t;return(t=(e=this.cache).src_path)==null?e.src_path=RegExp(`(?:[/?#](?:${this.nestedPairRE(`[`,`]`)}|${this.nestedPairRE(`(`,`)`)}|${this.nestedPairRE(`{`,`}`)}|\\"(?:(?!${this.src_ZCc}|["]).){1,100}\\"|\\'(?:(?!${this.src_ZCc}|[']).){1,100}\\'|\\'(?=${this.get_pseudo_letter().source}|[-])|\\.{2,20}[:]?[a-zA-Z0-9%/&]|\\.(?!${this.src_ZCc}|[.]|$)|`+(this.opts[`---`]?`\\-(?!--(?:[^-]|$))(?:-{0,19})|`:`\\-{1,20}|`)+`,(?!${this.src_ZCc}|$)|;(?!${this.src_ZCc}|$)|\\!{1,20}(?!${this.src_ZCc}|[!]|$)|\\?(?!${this.src_ZCc}|[?]|$)|`+this.get_path_extra().source+`[\\\\/:%@#&=_~*]|(?!${this.get_path_terminator().source}).){1,${this.opts.maxLength}}|\\/)?`):t}get_mail_name(){var e,t;return(t=(e=this.cache).src_mail_name)==null?e.src_mail_name=RegExp("[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9](?:[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9]|[.](?=[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9])){0,63}"):t}get_xn(){var e,t;return(t=(e=this.cache).src_xn)==null?e.src_xn=RegExp(`xn--[a-z0-9\\-]{1,59}`):t}get_tld(){if(this.cache.tld)return this.cache.tld;let e=[...new Set(this.opts.tlds||[])].sort().reverse().join(`|`);return this.cache.tld=RegExp(`${e||`$#none#$`}|${this.get_xn().source}`),this.cache.tld}get_domain_root(){var e,t;return(t=(e=this.cache).src_domain_root)==null?e.src_domain_root=RegExp(`(?:`+this.get_xn().source+`|${this.get_pseudo_letter().source}{1,63})`):t}get_domain(){var e,t;return(t=(e=this.cache).src_domain)==null?e.src_domain=RegExp(`(?:`+this.get_xn().source+`|(?:${this.get_pseudo_letter().source})|(?:${this.get_pseudo_letter().source}(?:-|${this.get_pseudo_letter().source}){0,61}${this.get_pseudo_letter().source}))`):t}get_url_host_port(){var e,t;return(t=(e=this.cache).url_host_port)==null?e.url_host_port=RegExp(`(?:`+this.get_ipv6_url_host().source+`|(?:(?:(?:${this.get_domain().source})\\.){0,10}${this.get_domain().source}))`+this.get_port().source+this.get_host_terminator().source):t}get_fuzzy_url_host_port(){var e,t;return(t=(e=this.cache).fuzzy_url_host_port)==null?e.fuzzy_url_host_port=RegExp(`(?:`+(this.opts.fuzzyIP?this.get_ipv4_addr().source+`|`:``)+`(?:(?:(?:${this.get_domain().source})\\.){1,10}(?:${this.get_tld().source})))`+this.get_host_terminator().source):t}get_mail_host(){var e,t;return(t=(e=this.cache).src_mail_host)==null?e.src_mail_host=RegExp(`(?:`+this.get_ipv6_mail_host().source+`|(?:(?:(?:${this.get_domain().source})\\.){0,4}${this.get_domain().source}))`+this.get_host_terminator().source):t}get_fuzzy_mail_host(){var e,t;return(t=(e=this.cache).src_fuzzy_mail_host)==null?e.src_fuzzy_mail_host=RegExp(`(?:`+this.get_ipv6_mail_host().source+`|(?:(?:(?:${this.get_domain().source})[.]){1,4}${this.get_domain_root().source}))`+this.get_host_terminator().source):t}get_path_extra(){var e,t;return(t=(e=this.cache).src_path_extra)==null?e.src_path_extra=RegExp(``):t}get_fuzzy_mail_host_search(){var e,t;return(t=(e=this.cache).mail_fuzzy_host_search)==null?e.mail_fuzzy_host_search=RegExp(`@${this.get_fuzzy_mail_host().source}`,`ig`):t}get_fuzzy_link_search(){var e,t;return(t=(e=this.cache).link_fuzzy_search)==null?e.link_fuzzy_search=RegExp(`(^|(?![.:/\\-_@])(?:[$+<=>^\`|\uff5c]|${this.src_ZPCc}))(?:(?![$+<=>^\`|\uff5c])${this.get_fuzzy_url_host_port().source}${this.get_path().source})`,`ig`):t}get_http_validator(){var e,t;return(t=(e=this.cache).http_validator)==null?e.http_validator=RegExp(`\\/\\/`+(this.opts.urlAuth?this.get_auth().source:``)+this.get_url_host_port().source+this.get_path().source,`iy`):t}get_relative_proto_validator(){var e,t;return(t=(e=this.cache).relative_proto_validator)==null?e.relative_proto_validator=RegExp((this.opts.urlAuth?this.get_auth().source:``)+`(?:localhost|${this.get_ipv6_url_host().source}|(?:(?:${this.get_domain().source})[.]){1,10}${this.get_domain_root().source})`+this.get_port().source+this.get_host_terminator().source+this.get_path().source,`iy`):t}get_mail_name_validator(){var e,t;return(t=(e=this.cache).mail_name_validator)==null?e.mail_name_validator=RegExp(`(?:^|${this.get_text_separators().source}|"|\\(|${this.src_ZCc})(${this.get_mail_name().source})$`):t}get_mailto_validator(){var e,t;return(t=(e=this.cache).mailto_validator)==null?e.mailto_validator=RegExp(`${this.get_mail_name().source}@${this.get_mail_host().source}`,`iy`):t}get_schema_names(){var e,t;return(t=(e=this.cache).schema_names)==null?e.schema_names=new RegExp((this.opts.schema_names||[]).map(e=>this.escapeRE(e)).join(`|`)):t}get_schema_search(){var e,t;return(t=(e=this.cache).schema_search)==null?e.schema_search=RegExp(`(^|(?!_)(?:[><\uff5c]|${this.src_ZPCc}))(${this.get_schema_names().source})`,`ig`):t}get_schema_at_start(){var e,t;return(t=(e=this.cache).schema_at_start)==null?e.schema_at_start=RegExp(`^${this.get_schema_search().source}`,`i`):t}},Dn={validate:(e,t,n)=>{let r=n.re.get_http_validator();r.lastIndex=t;let i=r.exec(e);return i?i[0].length:0},normalize:(e,t)=>t.normalize(e)},On={"http:":Dn,"https:":Dn,"ftp:":Dn,"//":{validate:function(e,t,n){let r=n.re.get_relative_proto_validator();r.lastIndex=t;let i=r.exec(e);return i?t>=3&&e[t-3]===`:`||t>=3&&e[t-3]===`/`?0:i[0].length:0},normalize:(e,t)=>t.normalize(e)},"mailto:":{validate:function(e,t,n){let r=n.re.get_mailto_validator();r.lastIndex=t;let i=r.exec(e);return i?i[0].length:0},normalize:(e,t)=>t.normalize(e)}},kn=`a:cdefgilmnoqrstuwxz|b:abdefghijmnorstvwyz|c:acdfghiklmnoruvwxyz|d:ejkmoz|e:cegrstu|f:ijkmor|g:abdefghilmnpqrstuwy|h:kmnrtu|i:delmnoqrst|j:emop|k:eghimnprwyz|l:abcikrstuvy|m:acdeghklmnopqrstuvwxyz|n:acefgilopruz|o:m|p:aefghklmnrstwy|q:a|r:eosuw|s:abcdeghijklmnortuvxyz|t:cdfghjklmnortvwz|u:agksyz|v:aceginu|w:fs|y:et|z:amw`,An=`biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|рф`;function jn(){let e=An.split(`|`);return kn.split(`|`).forEach(t=>{let n=t.indexOf(`:`),r=t.slice(0,n);for(let i of t.slice(n+1))e.push(r+i)}),e}var Mn={fuzzyLink:!1,fuzzyEmail:!0,fuzzyIP:!1,"---":!1,tlds:jn(),urlAuth:!1,maxLength:1e4},Nn=class{constructor(e,t,n,r){T(this,`schema`,void 0),T(this,`index`,void 0),T(this,`lastIndex`,void 0),T(this,`raw`,void 0),T(this,`text`,void 0),T(this,`url`,void 0);let i=e.slice(n,r);this.schema=t.toLowerCase(),this.index=n,this.lastIndex=r,this.raw=i,this.text=i,this.url=i}},Pn=class{constructor(e={}){T(this,`__opts__`,void 0),T(this,`__schemas__`,void 0),T(this,`re`,void 0);let{rebuilder:t}=e,n=wn(e,Tn);this.__opts__=q(q({},Mn),n),this.__schemas__=q({},On),this.re=t||new En,this.re.set(q(q({},this.__opts__),{},{schema_names:Object.keys(this.__schemas__)}))}add(e,t=null){if(!t)delete this.__schemas__[e];else{let n=q({normalize:(e,t)=>t.normalize(e)},t);this.__schemas__[e]=n}return this.re.set(q(q({},this.__opts__),{},{schema_names:Object.keys(this.__schemas__)})),this}set(e={}){return this.__opts__=q(q({},this.__opts__),e),this.re.set(q(q({},this.__opts__),{},{schema_names:Object.keys(this.__schemas__)})),this}test(e){if(!e.length)return!1;let t,n;for(n=this.re.get_schema_search(),n.lastIndex=0;(t=n.exec(e))!==null;)if(this.testSchemaAt(e,t[2],n.lastIndex))return!0;if(this.__opts__.fuzzyLink&&this.__schemas__[`http:`]&&(n=this.re.get_fuzzy_link_search(),n.lastIndex=0,n.exec(e)!==null))return!0;if(this.__opts__.fuzzyEmail&&this.__schemas__[`mailto:`]&&e.indexOf(`@`)>=0){let n=this.re.get_fuzzy_mail_host_search(),r=this.re.get_mail_name_validator();for(n.lastIndex=0;(t=n.exec(e))!==null;){let n=e.slice(Math.max(0,t.index-65),t.index);if(r.test(n))return!0}}return!1}testSchemaAt(e,t,n){return this.__schemas__[t.toLowerCase()]?this.__schemas__[t.toLowerCase()].validate(e.slice(0,n+this.__opts__.maxLength),n,this):0}match(e){let t=[],n=this.re.get_schema_search(),r,i,a,o,s,c,l=!1,u=!1,d=!1,f=0;if(!e.length)return null;for(n.lastIndex=0,this.__opts__.fuzzyLink&&this.__schemas__[`http:`]&&(r=this.re.get_fuzzy_link_search(),r.lastIndex=0),this.__opts__.fuzzyEmail&&this.__schemas__[`mailto:`]&&(i=this.re.get_fuzzy_mail_host_search(),i.lastIndex=0,a=this.re.get_mail_name_validator());;){let p=Math.max(f-1,0);if(i&&a&&!d&&(!s||s.index<f))for(i.lastIndex<p&&(i.lastIndex=p);;){let t=i.exec(e);if(!t){d=!0,s=void 0;break}let n=a.exec(e.slice(Math.max(0,t.index-65),t.index));if(n){if(s={schema:`mailto:`,index:t.index-n[1].length,lastIndex:t.index+t[0].length},s.index>=f)break;i.lastIndex<p&&(i.lastIndex=p)}}if(r&&!u&&(!o||o.index<f))for(r.lastIndex<p&&(r.lastIndex=p);;){let t=r.exec(e);if(!t){u=!0,o=void 0;break}if(o={schema:``,index:t.index+t[1].length,lastIndex:t.index+t[0].length},o.index>=f)break;r.lastIndex<p&&(r.lastIndex=p)}let m=s;(!m||o&&(o.index<m.index||o.index===m.index&&o.lastIndex>m.lastIndex))&&(m=o);let h;if(!l)for(;;){if(!c){n.lastIndex<p&&(n.lastIndex=p);let t=n.exec(e);if(!t){l=!0;break}c={schema:t[2],index:t.index+t[1].length,lastIndex:t.index+t[0].length}}if(c.index<f){c=void 0;continue}if(m&&c.index>m.index)break;let t=c;c=void 0;let r=this.testSchemaAt(e,t.schema,t.lastIndex);if(r){h={schema:t.schema,index:t.index,lastIndex:t.lastIndex+r};break}}let g=h;if((!g||s&&(s.index<g.index||s.index===g.index&&s.lastIndex>g.lastIndex))&&(g=s),(!g||o&&(o.index<g.index||o.index===g.index&&o.lastIndex>g.lastIndex))&&(g=o),!g)break;g===s?s=void 0:g===o&&(o=void 0);let _=new Nn(e,g.schema,g.index,g.lastIndex);_.schema?this.__schemas__[_.schema].normalize(_,this):this.normalize(_),t.push(_),f=g.lastIndex}return t.length?t:null}matchAtStart(e){if(!e.length)return null;let t=this.re.get_schema_at_start().exec(e);if(!t)return null;let n=this.testSchemaAt(e,t[2],t[0].length);if(!n)return null;let r=new Nn(e,t[2],t.index+t[1].length,t.index+t[0].length+n);return this.__schemas__[r.schema].normalize(r,this),r}tlds(e,t=!1){return e=Array.isArray(e)?e:[e],t?this.__opts__.tlds=this.__opts__.tlds.concat(e):this.__opts__.tlds=e,this.re.set(q(q({},this.__opts__),{},{schema_names:Object.keys(this.__schemas__)})),this}normalize(e){e.schema||(e.url=`http://${e.url}`),e.schema===`mailto:`&&!/^mailto:/i.test(e.url)&&(e.url=`mailto:${e.url}`)}},J=2147483647,Y=36,Fn=1,X=26,In=38,Ln=700,Rn=72,zn=128,Bn=`-`,Vn=/^xn--/,Hn=/[^\0-\x7F]/,Un=/[\x2E\u3002\uFF0E\uFF61]/g,Wn={overflow:`Overflow: input needs wider integers to process`,"not-basic":`Illegal input >= 0x80 (not a basic code point)`,"invalid-input":`Invalid input`},Gn=35,Z=Math.floor,Kn=String.fromCharCode;function Q(e){throw RangeError(Wn[e])}function qn(e,t){let n=[],r=e.length;for(;r--;)n[r]=t(e[r]);return n}function Jn(e,t){let n=e.split(`@`),r=``;n.length>1&&(r=n[0]+`@`,e=n[1]),e=e.replace(Un,`.`);let i=qn(e.split(`.`),t).join(`.`);return r+i}function Yn(e){let t=[],n=0,r=e.length;for(;n<r;){let i=e.charCodeAt(n++);if(i>=55296&&i<=56319&&n<r){let r=e.charCodeAt(n++);(r&64512)==56320?t.push(((i&1023)<<10)+(r&1023)+65536):(t.push(i),n--)}else t.push(i)}return t}var Xn=e=>String.fromCodePoint(...e),Zn=function(e){return e>=48&&e<58?26+(e-48):e>=65&&e<91?e-65:e>=97&&e<123?e-97:Y},Qn=function(e,t){return e+22+75*(e<26)-((t!=0)<<5)},$n=function(e,t,n){let r=0;for(e=n?Z(e/Ln):e>>1,e+=Z(e/t);e>455;r+=Y)e=Z(e/Gn);return Z(r+36*e/(e+In))},er=function(e){let t=[],n=e.length,r=0,i=zn,a=Rn,o=e.lastIndexOf(Bn);o<0&&(o=0);for(let n=0;n<o;++n)e.charCodeAt(n)>=128&&Q(`not-basic`),t.push(e.charCodeAt(n));for(let s=o>0?o+1:0;s<n;){let o=r;for(let t=1,i=Y;;i+=Y){s>=n&&Q(`invalid-input`);let o=Zn(e.charCodeAt(s++));o>=Y&&Q(`invalid-input`),o>Z((J-r)/t)&&Q(`overflow`),r+=o*t;let c=i<=a?Fn:i>=a+X?X:i-a;if(o<c)break;let l=Y-c;t>Z(J/l)&&Q(`overflow`),t*=l}let c=t.length+1;a=$n(r-o,c,o==0),Z(r/c)>J-i&&Q(`overflow`),i+=Z(r/c),r%=c,t.splice(r++,0,i)}return String.fromCodePoint(...t)},tr=function(e){let t=[];e=Yn(e);let n=e.length,r=zn,i=0,a=Rn;for(let n of e)n<128&&t.push(Kn(n));let o=t.length,s=o;for(o&&t.push(Bn);s<n;){let n=J;for(let t of e)t>=r&&t<n&&(n=t);let c=s+1;n-r>Z((J-i)/c)&&Q(`overflow`),i+=(n-r)*c,r=n;for(let n of e)if(n<r&&++i>J&&Q(`overflow`),n===r){let e=i;for(let n=Y;;n+=Y){let r=n<=a?Fn:n>=a+X?X:n-a;if(e<r)break;let i=e-r,o=Y-r;t.push(Kn(Qn(r+i%o,0))),e=Z(i/o)}t.push(Kn(Qn(e,0))),a=$n(i,c,s===o),i=0,++s}++i,++r}return t.join(``)},nr={version:`2.3.1`,ucs2:{decode:Yn,encode:Xn},decode:er,encode:tr,toASCII:function(e){return Jn(e,function(e){return Hn.test(e)?`xn--`+tr(e):e})},toUnicode:function(e){return Jn(e,function(e){return Vn.test(e)?er(e.slice(4).toLowerCase()):e})}},rr={default:{options:{html:!1,xhtmlOut:!1,breaks:!1,langPrefix:`language-`,linkify:!1,typographer:!1,quotes:`“”‘’`,highlight:null,maxNesting:100},components:{core:{},block:{},inline:{}}},zero:{options:{html:!1,xhtmlOut:!1,breaks:!1,langPrefix:`language-`,linkify:!1,typographer:!1,quotes:`“”‘’`,highlight:null,maxNesting:20},components:{core:{rules:[`normalize`,`block`,`strip_references`,`inline`,`text_join`]},block:{rules:[`paragraph`]},inline:{rules:[`text`],rules2:[`balance_pairs`,`fragments_join`]}}},commonmark:{options:{html:!0,xhtmlOut:!0,breaks:!1,langPrefix:`language-`,linkify:!1,typographer:!1,quotes:`“”‘’`,highlight:null,maxNesting:20},components:{core:{rules:[`normalize`,`block`,`strip_references`,`inline`,`text_join`]},block:{rules:[`blockquote`,`code`,`fence`,`heading`,`hr`,`html_block`,`lheading`,`list`,`reference`,`paragraph`]},inline:{rules:[`autolink`,`backticks`,`emphasis`,`entity`,`escape`,`html_inline`,`image`,`link`,`newline`,`text`],rules2:[`balance_pairs`,`emphasis`,`fragments_join`]}}}},ir=/^(vbscript|javascript|file|data):/,ar=/^data:image\/(gif|png|jpeg|webp);/,or=[`http:`,`https:`,`mailto:`],$=class{validateLink(e){let t=e.trim().toLowerCase();return!ir.test(t)||ar.test(t)}normalizeLink(e){let t=b(e,!0);if(t.hostname&&(!t.protocol||or.indexOf(t.protocol)>=0))try{t.hostname=nr.toASCII(t.hostname)}catch(e){}return s(c(t))}normalizeLinkText(e){let t=b(e,!0);if(t.hostname&&(!t.protocol||or.indexOf(t.protocol)>=0))try{t.hostname=nr.toUnicode(t.hostname)}catch(e){}return i(c(t),i.defaultChars+`%`)}constructor(...e){T(this,`inline`,new xn),T(this,`block`,new zt),T(this,`core`,new gt),T(this,`renderer`,new Ue),T(this,`linkify`,new Pn),T(this,`utils`,xe),T(this,`helpers`,Object.assign({},He));let[t,n]=e;typeof t==`string`?(this.configure(t),n&&this.set(n)):(this.configure(`default`),this.set(t||{}))}set(e){return Object.assign(this.options,e),this}configure(e){let t;if(typeof e==`string`){let n=e;if(t=rr[n],!t)throw Error(`Wrong 'markdown-it' preset "${n}", check name`)}else t=e;if(!t)throw Error("Wrong `markdown-it` preset, can't be empty");t.options&&(this.options=q({},t.options));let n=t.components;if(n){var r;[`core`,`block`,`inline`].forEach(e=>{var t;let r=(t=n[e])==null?void 0:t.rules;r&&this[e].ruler.enableOnly(r)});let e=(r=n.inline)==null?void 0:r.rules2;e&&this.inline.ruler2.enableOnly(e)}return this}enable(e,t=!1){let n=[];Array.isArray(e)||(e=[e]),[`core`,`block`,`inline`].forEach(t=>{n=n.concat(this[t].ruler.enable(e,!0))}),n=n.concat(this.inline.ruler2.enable(e,!0));let r=e.filter(e=>n.indexOf(e)<0);if(r.length&&!t)throw Error(`MarkdownIt. Failed to enable unknown rule(s): ${r}`);return this}disable(e,t=!1){let n=[];Array.isArray(e)||(e=[e]),[`core`,`block`,`inline`].forEach(t=>{n=n.concat(this[t].ruler.disable(e,!0))}),n=n.concat(this.inline.ruler2.disable(e,!0));let r=e.filter(e=>n.indexOf(e)<0);if(r.length&&!t)throw Error(`MarkdownIt. Failed to disable unknown rule(s): ${r}`);return this}use(e,...t){return e.apply(e,[this,...t]),this}parse(e,t){if(typeof e!=`string`)throw Error(`Input data should be a String`);let n=new this.core.State(e,this,t);return this.core.process(n),n.tokens}render(e,t={}){return this.renderer.render(this.parse(e,t),this.options,t)}parseInline(e,t){let n=new this.core.State(e,this,t);return n.inlineMode=!0,this.core.process(n),n.tokens}renderInline(e,t={}){return this.renderer.render(this.parseInline(e,t),this.options,t)}};return T($,`Token`,z),T($,`Ruler`,B),T($,`Renderer`,Ue),T($,`ParserCore`,gt),T($,`StateCore`,We),T($,`ParserBlock`,zt),T($,`StateBlock`,_t),T($,`ParserInline`,xn),T($,`StateInline`,Bt),Se($)});
//# sourceMappingURL=markdown-it.umd.min.js.map
          return module.exports
        })()
        // ==== end markdown-it vendored ====
        // Fenced-code languages: aliases users actually write in ```info
        // strings, mapped onto the shared LANG_BY_EXT ids.
        const MD_LANG_ALIAS = { python:'python', py:'python', javascript:'javascript', js:'javascript', typescript:'typescript', ts:'typescript', 'c++':'cpp', cpp:'cpp', csharp:'csharp', cs:'csharp', 'c#':'csharp', golang:'go', go:'go', rust:'rust', rs:'rust', ruby:'ruby', rb:'ruby', php:'php', swift:'swift', kotlin:'kotlin', kt:'kotlin', bash:'bash', shell:'bash', sh:'bash', zsh:'bash', powershell:'powershell', ps1:'powershell', sql:'sql', json:'json', yaml:'yaml', yml:'yaml', toml:'toml', xml:'xml', html:'html', css:'css', markdown:'markdown', md:'markdown', java:'java', r:'r' }
        const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        // Code fences reuse the code view's line tokenizer (24 languages,
        // theme-token palette) — no second highlighter to maintain.
        const mdHighlight = (str, lang) => {
          const l = (lang && (MD_LANG_ALIAS[String(lang).toLowerCase()] || LANG_BY_EXT[String(lang).toLowerCase()])) || null
          if (!l) return '' // markdown-it falls back to its default escaped <pre><code>
          const state = { mode: null }
          const lines = String(str).replace(/\n$/, '').split('\n')
          let out = ''
          for (const line of lines) {
            const toks = lineTokensCached(line, l, state)
            if (toks) out += toks.map((t) => '<span class="dsh-fe-tk' + (t.c ? ' dsh-fe-tk-' + t.c : '') + '">' + escHtml(t.t) + '</span>').join('')
            else out += escHtml(line)
            out += '\n'
          }
          return '<pre class="dsh-fe-md-pre"><code class="dsh-fe-md-code">' + out + '</code></pre>'
        }
        const mdParser = new MarkdownIt({ html: false, linkify: true, highlight: mdHighlight })
        const renderMarkdown = (text) => mdParser.render(text || '')

        // Route A: every clean text file is one real document editor.  The
        // same CodeMirror instance serves read-only browsing and editing, so
        // selections, IME, undo/redo and line operations all share one model.
        const cmLanguage = (lang) => {
          try {
            if (lang === 'javascript') return javascript({ jsx: true })
            if (lang === 'typescript') return javascript({ typescript: true, jsx: true })
            if (lang === 'python') return python()
            if (lang === 'markdown') return markdown()
            if (lang === 'json') return json()
            if (lang === 'html' || lang === 'xml') return html()
            if (lang === 'css') return css()
            if (lang === 'sql') return sql()
            if (lang === 'cpp' || lang === 'csharp') return cpp()
            if (lang === 'java' || lang === 'kotlin') return java()
            if (lang === 'rust') return rust()
            if (lang === 'php') return php()
            if (lang === 'yaml') return yaml()
            if (lang === 'go') return StreamLanguage.define(go)
            if (lang === 'bash') return StreamLanguage.define(shell)
            if (lang === 'powershell') return StreamLanguage.define(powerShell)
            if (lang === 'ruby') return StreamLanguage.define(ruby)
            if (lang === 'swift') return StreamLanguage.define(swift)
            if (lang === 'toml') return StreamLanguage.define(toml)
            if (lang === 'r') return StreamLanguage.define(rLanguage)
          } catch (e) {}
          return []
        }
        const cmTheme = EditorView.theme({
          '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--dsw-alias-label-primary)' },
          '.cm-scroller': { overflow: 'auto', fontFamily: "ui-monospace,'Cascadia Code',Consolas,monospace", fontSize: '12.5px', lineHeight: '1.5' },
          '.cm-content': { minHeight: '100%', paddingBottom: 'var(--dsh-fe-dock-h, 0px)', caretColor: 'var(--dsw-alias-label-primary)' },
          '.cm-gutters': { backgroundColor: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)', borderRight: '1px solid var(--dsw-alias-border-l1)' },
          '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--dsw-alias-label-secondary) 8%, transparent)' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)) 32%, transparent) !important' },
          '&.cm-focused': { outline: 'none' },
        })
        // The stock CodeMirror highlighter is tuned for a light surface and
        // becomes muddy in Harness dark mode (Markdown heading marks were a
        // particularly low-contrast green). Mix every accent with Harness's
        // theme-aware primary label: accents become lighter on dark surfaces
        // and darker on light surfaces without maintaining two brittle themes.
        const cmSyntax = {
          purple: 'color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #bd78ff 66%)',
          blue: 'color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #4f8cff 66%)',
          cyan: 'color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #28c8d7 66%)',
          green: 'color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #55c878 66%)',
          yellow: 'color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #e6a83f 66%)',
          orange: 'color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #f28c45 66%)',
          red: 'color-mix(in srgb, var(--dsw-alias-label-primary) 34%, #ef5d78 66%)',
          muted: 'color-mix(in srgb, var(--dsw-alias-label-secondary) 78%, var(--dsw-alias-label-primary))',
          punctuation: 'color-mix(in srgb, var(--dsw-alias-label-secondary) 55%, var(--dsw-alias-label-primary))',
        }
        const cmSyntaxHighlight = HighlightStyle.define([
          { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.modifier], color: cmSyntax.purple, fontWeight: '600' },
          { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName], color: cmSyntax.blue },
          { tag: [tags.typeName, tags.className, tags.namespace], color: cmSyntax.yellow, fontWeight: '600' },
          { tag: [tags.string, tags.docString, tags.character, tags.attributeValue], color: cmSyntax.green },
          { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom, tags.unit], color: cmSyntax.orange },
          { tag: [tags.regexp, tags.escape, tags.color], color: cmSyntax.cyan },
          { tag: [tags.operator, tags.derefOperator, tags.arithmeticOperator, tags.logicOperator, tags.bitwiseOperator, tags.compareOperator, tags.updateOperator, tags.definitionOperator, tags.typeOperator, tags.controlOperator], color: cmSyntax.cyan },
          { tag: [tags.propertyName, tags.attributeName], color: cmSyntax.blue },
          { tag: [tags.tagName, tags.macroName], color: cmSyntax.red, fontWeight: '600' },
          { tag: [tags.meta, tags.documentMeta, tags.annotation, tags.processingInstruction], color: cmSyntax.yellow },
          { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: cmSyntax.muted, fontStyle: 'italic' },
          { tag: [tags.punctuation, tags.separator, tags.bracket, tags.angleBracket, tags.squareBracket, tags.paren, tags.brace], color: cmSyntax.punctuation },
          { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: cmSyntax.blue, fontWeight: '700' },
          { tag: [tags.link, tags.url], color: cmSyntax.cyan, textDecoration: 'underline' },
          { tag: tags.strong, color: cmSyntax.yellow, fontWeight: '700' },
          { tag: tags.emphasis, color: cmSyntax.purple, fontStyle: 'italic' },
          { tag: tags.monospace, color: cmSyntax.cyan },
          { tag: tags.quote, color: cmSyntax.muted, fontStyle: 'italic' },
          { tag: tags.contentSeparator, color: cmSyntax.punctuation },
          { tag: tags.inserted, color: cmSyntax.green },
          { tag: [tags.deleted, tags.changed, tags.invalid], color: cmSyntax.red },
        ])
        function WholeDocumentEditor(props) {
          const hostRef = React.useRef(null)
          const viewRef = React.useRef(null)
          const callbacksRef = React.useRef(props)
          const readOnlyCompartment = React.useRef(new Compartment()).current
          callbacksRef.current = props

          React.useEffect(() => {
            if (!hostRef.current) return undefined
            const referenceSelection = (view) => {
              const sel = view.state.selection.main
              if (sel.empty) return false
              const startLine = view.state.doc.lineAt(sel.from).number
              let endLine = view.state.doc.lineAt(sel.to).number
              if (sel.to > sel.from && view.state.doc.sliceString(sel.to - 1, sel.to) === '\n') endLine--
              callbacksRef.current.onReference(startLine, Math.max(startLine, endLine))
              return true
            }
            const save = () => {
              if (callbacksRef.current.readOnly) return false
              callbacksRef.current.onSave(viewRef.current ? viewRef.current.state.doc.toString() : '')
              return true
            }
            const state = EditorState.create({
              doc: props.value,
              extensions: [
                basicSetup,
                EditorView.lineWrapping,
                cmTheme,
                syntaxHighlighting(cmSyntaxHighlight),
                cmLanguage(props.lang),
                readOnlyCompartment.of([
                  EditorState.readOnly.of(!!props.readOnly),
                  // Keep the DOM editing surface focusable in browse mode so
                  // CodeMirror can own pointer/keyboard selections. The state
                  // readOnly facet blocks document changes on its own.
                  EditorView.editable.of(true),
                ]),
                Prec.highest(keymap.of([
                  { key: 'Mod-u', run: referenceSelection },
                  { key: 'Mod-s', run: save },
                  indentWithTab,
                ])),
                EditorView.updateListener.of((update) => {
                  if (update.docChanged && !callbacksRef.current.readOnly) callbacksRef.current.onChange(update.state.doc.toString())
                }),
              ],
            })
            const view = new EditorView({ state: state, parent: hostRef.current })
            viewRef.current = view
            return () => { view.destroy(); if (viewRef.current === view) viewRef.current = null }
          }, [props.path])

          React.useEffect(() => {
            const view = viewRef.current
            if (!view) return
            view.dispatch({ effects: readOnlyCompartment.reconfigure([
              EditorState.readOnly.of(!!props.readOnly),
              EditorView.editable.of(true),
            ]) })
          }, [props.readOnly])

          React.useEffect(() => {
            const view = viewRef.current
            if (!view) return
            const current = view.state.doc.toString()
            if (current !== props.value) {
              view.dispatch({ changes: { from: 0, to: current.length, insert: props.value } })
            }
          }, [props.value])

          return React.createElement('div', { className: 'dsh-fe-document-editor', ref: hostRef })
        }

        // ---------- file view ----------
        function DiffPane(props) {
          const sid = props.sid
          const path = props.path
          const displayPath = props.displayPath || path
          const [diff, setDiff] = React.useState(null)
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState(null)
          const [documentMode, setDocumentMode] = React.useState('browse')
          const [draftText, setDraftText] = React.useState('')
          const [savingDocument, setSavingDocument] = React.useState(false)
          const [reviewAction, setReviewAction] = React.useState(null)
          // v1.7.1: hunk heads (行号范围 + 接受/拒绝) are PERMANENT — the
          // old hover-show/hover-hide made adjacent hunks jitter while the
          // pointer moved between them.
          // v1.7: diff jump controls — index of the currently focused hunk
          // (null = none yet; the counter then reads the first hunk).
          const [focusIdx, setFocusIdx] = React.useState(null)
          const hunkRefs = React.useState({})[0]
          const diffRef = React.useState({ node: null })[0]
          const scrollGate = React.useState({ pending: false })[0]
          // Navigation is an explicit hunk cursor. Do not derive button
          // clicks from selection/visibility: several hunks may be visible at
          // once, and route A's review rows are intentionally read-only, so a
          // caret anchor is neither unique nor reliably movable.
          const hunkCursor = React.useState({ path: null, idx: null, programmatic: false, unlockTimer: null })[0]
          const editingRef = React.useState({ idx: null })[0]
          React.useEffect(() => () => {
            if (hunkCursor.unlockTimer) clearTimeout(hunkCursor.unlockTimer)
          }, [])
          // v1.13.4: the CURRENT request identity, mirrored every render.
          // Path alone is insufficient: two tasks can open the same path, so
          // a late response from the previous task must also be rejected.
          const requestRef = React.useState({ sid: null, path: null })[0]
          requestRef.sid = sid
          requestRef.path = path
          const requestSeq = React.useState({ next: 0, latest: 0 })[0]
          const lang = langOf(displayPath)
          React.useEffect(() => {
            editingRef.idx = null
            hunkCursor.path = path
            hunkCursor.idx = null
            hunkCursor.programmatic = false
            if (hunkCursor.unlockTimer) clearTimeout(hunkCursor.unlockTimer)
            hunkCursor.unlockTimer = null
            setFocusIdx(null)
            setDocumentMode(lang === 'markdown' ? 'preview' : 'browse')
            setDraftText('')
            setSavingDocument(false)
          }, [path, sid])
          // v1.8.1: sticky header measurements — the toolbar pins below the
          // tabs bar; its height feeds the jump control's sticky offset
          // (CSS var) and the jump scroll math (store).
          const paneRef = React.useState({ node: null })[0]
          const toolbarRef = React.useState({ node: null })[0]
          React.useEffect(() => {
            const el = toolbarRef.node
            if (el && el.offsetHeight > 0) {
              store.toolH = el.offsetHeight
              if (paneRef.node) paneRef.node.style.setProperty('--dsh-fe-toolbar-h', el.offsetHeight + 'px')
            }
          })
          // v1.9.4: `forceFull` (tab switch / path change) ignores the stale
          // `diff.rev` and fetches the whole payload. The rev short-circuit
          // is only valid when the rev belongs to the SAME file: the pane is
          // ONE component instance reused across tabs, so after a switch
          // `diff.rev` is the PREVIOUS file's counter. Files that lived the
          // same lifecycle share the same rev (every new file is 1 after its
          // first scan, 2 after a reject) — the host answers `same` for the
          // NEW path and the stale content would stick forever.
          const fetch = async (forceFull) => {
            if (!sid || !path) return
            const reqSid = sid
            const reqPath = path
            const seq = ++requestSeq.next
            requestSeq.latest = seq
            setBusy(true)
            const r = await call('getDiff', { sessionId: reqSid, path: reqPath, rev: (forceFull || !diff) ? null : diff.rev })
            // Stale response guard: the user switched files or tasks while
            // this request was in flight. Drop it entirely (setBusy(false)
            // would also race the newer request's spinner).
            if (requestRef.sid !== reqSid || requestRef.path !== reqPath || requestSeq.latest !== seq) return
            if (r.ok) {
              // While a line is being edited, defer payload replacement so the
              // poll does not clobber the in-progress DOM edit.
              if (!r.same && editingRef.idx === null) {
                setDiff(r)
                if (r.deleted) store.markDeleted(reqPath)
                else store.clearDeleted(reqPath)
              } else if (r.same && diff) {
                if (diff.deleted) store.markDeleted(reqPath)
                else store.clearDeleted(reqPath)
              }
              setError(null)
            } else if (r.missing) {
              setDiff(null)
            } else {
              setError(r.error || r.message || '加载失败')
            }
            setBusy(false)
          }
          usePoll(fetch, () => pollDelayFor(sid))
          // v1.9.4: on path change, clear the previous file's payload FIRST
          // (the pane shows 加载中… instead of the wrong file's content) and
          // force a full fetch without the stale rev.
          React.useEffect(() => { setDiff(null); void fetch(true) }, [path, sid])
          // Bar-side accept/reject bumps the shared tick: refetch right away
          // so this pane's toolbar stats stay in sync with the modified bar.
          useStore()
          const refreshTick = store.refreshTick
          React.useEffect(() => { if (refreshTick) void fetch() }, [refreshTick])
          // [文件引用] Command+U：在行结构视图中选中文本 → 定位行号范围并触发引用。
          // 只对带 .dsh-fe-line[data-n] 的视图生效（diff 视图 / 代码浏览）；
          // markdown 渲染视图是 HTML，无行号，此处自然跳过。
          React.useEffect(() => {
            const closestLine = (node) => {
              if (!node) return null
              const el = node.nodeType === 1 ? node : node.parentElement
              return el && el.closest ? el.closest('.dsh-fe-line') : null
            }
            const onKey = (ev) => {
              if (!(ev.metaKey || ev.ctrlKey)) return
              if (ev.key !== 'u' && ev.key !== 'U') return
              const sel = window.getSelection ? window.getSelection() : null
              if (!sel || sel.isCollapsed) return
              const aLine = closestLine(sel.anchorNode)
              const fLine = closestLine(sel.focusNode)
              if (!aLine || !fLine) return
              const an = parseInt(aLine.getAttribute('data-n') || '0', 10)
              const fn = parseInt(fLine.getAttribute('data-n') || '0', 10)
              if (!an || !fn) return
              const start = Math.min(an, fn)
              const end = Math.max(an, fn)
              ev.preventDefault()
              ev.stopPropagation()
              if (typeof window !== 'undefined' && window.__dshFileRef) {
                window.__dshFileRef({ path: path, startLine: start, endLine: end })
              } else {
                console.info('[dsh-file-edit] 引用选中行:', path, 'L' + start + '-' + 'L' + end)
              }
            }
            document.addEventListener('keydown', onKey)
            return () => document.removeEventListener('keydown', onKey)
          }, [path, sid])
          // v1.9: markdown files render directly (no toggle, no preview cap).
          // Pending review (`changed`) keeps the diff/accept-reject view so
          // edits stay visible; once clean, the tab shows the rendered doc.
          const isMd = lang === 'markdown'
          const cleanDocument = !!diff && !diff.deleted && !diff.zero && diff.changed !== true && !diff.note && Array.isArray(diff.current)
          const sourceText = cleanDocument
            ? diff.current.join('\n') + (diff.trailingNL && diff.current.length > 0 ? '\n' : '')
            : ''
          const draftDirty = cleanDocument && documentMode === 'edit' && draftText !== sourceText
          React.useEffect(() => {
            store.setDraftDirty(path, draftDirty)
            return () => store.setDraftDirty(path, false)
          }, [sid, path, draftDirty])
          if (!diff) {
            return React.createElement('div', { className: 'dsh-fe-msg' }, busy ? '加载中…' : '文件不存在或无法读取')
          }
          const mdRender = isMd && cleanDocument && documentMode === 'preview'
          const beginEdit = () => {
            setDraftText(sourceText)
            editingRef.idx = -1
            setDocumentMode('edit')
            setError(null)
          }
          const cancelEdit = () => {
            editingRef.idx = null
            setDraftText('')
            setDocumentMode(isMd ? 'preview' : 'browse')
            setError(null)
          }
          const saveDocument = async (nextText) => {
            if (!cleanDocument || savingDocument) return
            const content = typeof nextText === 'string' ? nextText : draftText
            setSavingDocument(true)
            setError(null)
            const r = await call('applyDocument', { sessionId: sid, path: path, rev: diff.rev, content: content })
            setSavingDocument(false)
            if (!r.ok) {
              setError(r.message || r.error || '保存失败')
              if (r.code === 'stale' || r.code === 'pending-review') await fetch(true)
              return
            }
            editingRef.idx = null
            setDraftText('')
            setDocumentMode(isMd ? 'preview' : 'browse')
            setDiff(r)
            store.requestRefresh()
          }
          const referenceDocumentSelection = (startLine, endLine) => {
            if (typeof window !== 'undefined' && window.__dshFileRef) {
              window.__dshFileRef({ path: path, startLine: startLine, endLine: endLine })
            }
          }
          const onHunk = async (h, action) => {
            if (reviewAction) return
            const token = 'hunk:' + h.id + ':' + action
            setReviewAction(token)
            setError(null)
            try {
              const r = await call('applyHunk', { sessionId: sid, path: path, rev: diff.rev, hunkId: h.id, action: action })
              if (r.ok) { setDiff(r); setError(null); store.requestRefresh() }
              else { setError(r.message || r.error || '操作失败'); await fetch(true) }
            } finally {
              setReviewAction((current) => current === token ? null : current)
            }
          }
          const onFile = async (method) => {
            if (reviewAction) return
            const token = 'file:' + method
            setReviewAction(token)
            setError(null)
            try {
              const r = await call(method, { sessionId: sid, path: path })
              if (!r.ok) {
                setError(r.error || r.message || '操作失败')
                await fetch(true)
              } else {
                // New hosts return the completed diff directly, avoiding the
                // old second RPC + recomputation. Keep a compatibility fetch
                // for older hosts during rolling plugin updates.
                if (r.rev !== undefined) {
                  setDiff(r)
                  if (r.deleted) store.markDeleted(path)
                  else store.clearDeleted(path)
                }
                else await fetch(true)
                setError(null)
                store.requestRefresh()
              }
            } finally {
              setReviewAction((current) => current === token ? null : current)
            }
          }
          const statusText = mdRender ? 'Markdown' : (documentMode === 'edit' ? '编辑中' : (diff.createdThenDeleted ? '新建后删除' : (diff.status === 'added' ? '新增' : diff.status === 'deleted' ? '删除' : '修改')))
          // Accept-all / reject-all / refresh only exist while there is a
          // reviewable diff (the host stamps `changed` on the payload).
          const showActions = diff.changed === true
          const actionButtons = showActions ? [
            React.createElement(IconBtn, { key: 'ok', tone: 'ok', title: reviewAction ? '处理中…' : (diff.createdThenDeleted ? '确认文件保持删除并结束整条变化' : (diff.deleted ? '确认删除' : '接受全部')), disabled: !!reviewAction, busy: reviewAction === 'file:acceptFile', onClick: () => onFile('acceptFile'), icon: IconDoubleCheck }),
            React.createElement(IconBtn, { key: 'no', tone: 'no', className: 'dsh-fe-pair', title: diff.restorable === false ? '修改前内容不可恢复，只能接受或手动处理' : (reviewAction ? '处理中…' : (diff.createdThenDeleted ? '恢复文件并继续保留新增审核' : (diff.deleted ? '恢复文件（还原基线内容）' : '拒绝全部'))), disabled: !!reviewAction || diff.restorable === false, busy: reviewAction === 'file:rejectFile', onClick: () => onFile('rejectFile'), icon: IconRejectAll }),
            React.createElement(IconBtn, { key: 'rf', title: '刷新', onClick: () => fetch(), icon: IconRefresh }),
          ] : (cleanDocument ? [
            isMd && documentMode === 'browse' ? React.createElement('button', { key: 'preview', type: 'button', className: 'dsh-fe-btn', onClick: () => { editingRef.idx = null; setDocumentMode('preview') } }, '预览') : null,
            isMd && documentMode === 'preview' ? React.createElement('button', { key: 'source', type: 'button', className: 'dsh-fe-btn', onClick: () => setDocumentMode('browse') }, '源码') : null,
            documentMode === 'edit' ? React.createElement('button', { key: 'cancel', type: 'button', className: 'dsh-fe-btn', disabled: savingDocument, onClick: cancelEdit }, '取消') : null,
            documentMode === 'edit' ? React.createElement('button', { key: 'save', type: 'button', className: 'dsh-fe-btn dsh-fe-btn-ok', disabled: savingDocument, onClick: () => saveDocument(draftText) }, savingDocument ? '保存中…' : '保存') : null,
            !diff.readOnly && documentMode !== 'edit' && documentMode !== 'preview' ? React.createElement('button', { key: 'edit', type: 'button', className: 'dsh-fe-btn', onClick: beginEdit }, '编辑') : null,
            !diff.readOnly && documentMode === 'preview' ? React.createElement('button', { key: 'edit', type: 'button', className: 'dsh-fe-btn', onClick: beginEdit }, '编辑源码') : null,
          ].filter(Boolean) : null)
          const toolbar = React.createElement('div', { className: 'dsh-fe-toolbar', ref: (node) => { toolbarRef.node = node } },
            // The active browser-style file tab already owns the filename.
            // Start the content toolbar directly with its semantic status so
            // Markdown/edit/review badges align to the toolbar's left inset.
            React.createElement('span', { className: 'dsh-fe-chip' }, statusText),
            React.createElement('span', { className: 'dsh-fe-stats' },
              mdRender ? ('渲染视图 · ' + diff.current.length + ' 行') : (cleanDocument ? ((documentMode === 'edit' ? '可编辑' : (diff.readOnly ? '工作区外 · 只读浏览' : '只读浏览')) + ' · ' + diff.current.length + ' 行') : (diff.createdThenDeleted ? '本会话新建后删除' : (diff.deleted ? '文件已删除' : (diff.note ? (diff.note === 'binary' ? '二进制文件' : (diff.note === 'shell-unknown' ? '脚本修改' : (diff.note === 'write-before-unknown' ? '修改前内容未知' : '文件过大'))) : (diff.hunks && diff.hunks.length > 0
                ? [
                  React.createElement('span', { key: 'a', className: 'dsh-fe-stat-add' }, '+' + diff.hunks.reduce((s, h) => s + h.newLen, 0)),
                  ' ',
                  React.createElement('span', { key: 'd', className: 'dsh-fe-stat-del' }, '−' + diff.hunks.reduce((s, h) => s + h.oldLen, 0)),
                  ' · ' + diff.hunks.length + ' 处未决定',
                ]
                : '无未决定修改')))))),
            React.createElement('span', { className: 'dsh-fe-spacer' }, null),
            actionButtons,
          )
          // Deleted files: banner instead of a misleading red-line diff. The
          // toolbar still offers accept (confirm deletion) / reject (restore),
          // while a verified pre-delete snapshot remains browseable below.
          if (diff.deleted) {
            const previewLines = Array.isArray(diff.deletedPreview) ? diff.deletedPreview : null
            const previewText = previewLines
              ? previewLines.join('\n') + (diff.deletedPreviewTrailingNL && previewLines.length > 0 ? '\n' : '')
              : null
            const previewMessage = diff.deletedPreviewNote === 'binary'
              ? '删除前内容为二进制文件，无法在文本文件视图中浏览。'
              : (diff.deletedPreviewNote === 'large'
                ? '删除前文件超过文本预览大小限制，无法在此处浏览。'
                : '删除前内容不可用或隔离副本已不存在。')
            return React.createElement('div', { className: 'dsh-fe-pane' },
              toolbar,
              React.createElement('div', { className: 'dsh-fe-msg dsh-fe-deleted-hint' },
                diff.createdThenDeleted
                  ? '文件已从磁盘删除，以下为删除前内容。可确认保持删除，或恢复文件并继续保留新增审核。'
                  : (diff.changed ? '文件已从磁盘删除，以下为删除前内容。可在工具栏确认删除或恢复文件。' : '文件已从磁盘删除，以下保留删除前内容供只读浏览。')),
              error ? React.createElement('div', { className: 'dsh-fe-err' }, String(error)) : null,
              previewText === null
                ? React.createElement('div', { className: 'dsh-fe-msg' }, previewMessage)
                : React.createElement('div', { className: 'dsh-fe-document-wrap dsh-fe-deleted-document' },
                  React.createElement(WholeDocumentEditor, {
                    path: path + ':deleted',
                    lang: lang,
                    value: previewText,
                    readOnly: true,
                    onChange: () => {},
                    onSave: () => {},
                    onReference: () => {},
                  }),
                ),
            )
          }
          // Created then deleted within the session: net zero vs the baseline.
          if (diff.zero) {
            return React.createElement('div', { className: 'dsh-fe-pane' },
              toolbar,
              React.createElement('div', { className: 'dsh-fe-msg' },
                '此文件在会话中新增后又被删除，相对基线没有净变化。'),
              error ? React.createElement('div', { className: 'dsh-fe-err' }, String(error)) : null,
            )
          }
          // v1.9: rendered markdown view (read-only document). The toolbar
          // stays; accept/reject are hidden because nothing is pending.
          if (mdRender) {
            const html = renderMarkdown(sourceText)
            return React.createElement('div', { className: 'dsh-fe-pane' },
              toolbar,
              error ? React.createElement('div', { className: 'dsh-fe-err' }, String(error)) : null,
              React.createElement('div', { className: 'dsh-fe-mdwrap' },
                React.createElement('div', { className: 'dsh-fe-md', dangerouslySetInnerHTML: { __html: html } }),
              ),
            )
          }
          if (cleanDocument) {
            return React.createElement('div', { className: 'dsh-fe-pane' },
              toolbar,
              error ? React.createElement('div', { className: 'dsh-fe-err' }, String(error)) : null,
              React.createElement('div', { className: 'dsh-fe-document-wrap' },
                React.createElement(WholeDocumentEditor, {
                  path: path,
                  lang: lang,
                  value: documentMode === 'edit' ? draftText : sourceText,
                  readOnly: documentMode !== 'edit',
                  onChange: setDraftText,
                  onSave: saveDocument,
                  onReference: referenceDocumentSelection,
                }),
              ),
            )
          }
          // Inline line editor bookkeeping: map each editable cur-line index
          // to its rendered text so commits can detect real changes.
          const lineText = new Map()
          const commitEdit = async (idx, el) => {
            editingRef.idx = null
            const text = (el.textContent || '').replace(/\n/g, '')
            if (text === lineText.get(idx)) return
            setError(null)
            const r = await call('applyEdit', { sessionId: sid, path: path, idx: idx, text: text, rev: diff.rev })
            if (r.ok) { if (!r.same) setDiff(r); setError(null); store.requestRefresh() }
            else { setError(r.message || r.error || '编辑失败'); await fetch() }
          }
          // Per-line highlight state for the three line domains. Multiline
          // strings/comments carry their mode across rows in render order.
          const hlStateCur = { mode: null }
          const hlStateBase = { mode: null }
          const tokSpans = (text, hlState) => {
            const toks = lineTokensCached(text, lang, hlState)
            if (!toks) return text
            return toks.map((t, i) => React.createElement('span', { key: i, className: 'dsh-fe-tk' + (t.c ? ' dsh-fe-tk-' + t.c : '') }, t.t))
          }
          const row = (key, cls, r, editable, idx, hlState) => {
            const text = r.text === undefined ? '' : r.text
            if (editable && idx !== null && idx !== undefined) lineText.set(idx, text)
            const isOld = cls.indexOf('dsh-fe-old') >= 0
            if (!editable) {
              return React.createElement('div', { key: key, className: 'dsh-fe-line ' + cls, 'data-n': String(r.n) },
                // Deleted rows belong to the baseline, not to the resulting
                // document. Keep their internal data-n for selection/diff
                // bookkeeping, but do not present that obsolete number as a
                // current-file line number. Added/context rows remain numbered.
                React.createElement('span', { className: 'dsh-fe-ln', 'aria-hidden': isOld ? 'true' : undefined }, isOld ? '' : String(r.n)),
                React.createElement('span', { className: 'dsh-fe-txwrap' },
                  React.createElement('span', {
                    className: 'dsh-fe-tx' + (isOld ? ' dsh-fe-tx-ro' : ''),
                    title: isOld ? '已删除的行：可复制，不可编辑' : undefined,
                  }, tokSpans(text, hlState))),
              )
            }
            // Editable line: the contentEditable holds the REAL text (with
            // transparent glyphs — caret/selection/copy all work on it), while
            // the colored token layer below shows through. React manages the
            // initial text; keystrokes mutate the DOM and syncHl re-tokenizes
            // the layer imperatively; React only rewrites the span when its
            // React-side text changes (commit/poll), which always matches the
            // committed DOM text.
            return React.createElement('div', { key: key, className: 'dsh-fe-line ' + cls, 'data-n': String(r.n) },
              React.createElement('span', { className: 'dsh-fe-ln' }, String(r.n)),
              React.createElement('span', {
                className: 'dsh-fe-txwrap',
                onClick: (ev) => {
                  if (ev.target !== ev.currentTarget) return
                  const ed = ev.currentTarget.querySelector('.dsh-fe-tx-edit')
                  if (ed && ed.focus) ed.focus()
                },
              },
                React.createElement('span', { className: 'dsh-fe-hl', 'data-hl': '1', 'data-lang': lang || '', 'aria-hidden': 'true' }, tokSpans(text, hlState)),
                React.createElement('span', {
                  className: 'dsh-fe-tx dsh-fe-tx-edit',
                  contentEditable: true,
                  suppressContentEditableWarning: true,
                  spellCheck: false,
                  title: '可编辑：Enter 提交，Esc 取消',
                  onFocus: () => { editingRef.idx = idx },
                  onBlur: (ev) => { commitEdit(idx, ev.currentTarget) },
                  onInput: (ev) => { syncHl(ev.currentTarget) },
                  onKeyDown: (ev) => {
                    if (ev.key === 'Enter') { ev.preventDefault(); ev.currentTarget.blur() }
                    else if (ev.key === 'Escape') { ev.preventDefault(); ev.currentTarget.textContent = lineText.get(idx); syncHl(ev.currentTarget); ev.currentTarget.blur() }
                  },
                }, text)))
          }
          // Large-but-text files: host ships a read-only preview head instead of hunks.
          if (diff.note === 'large' && diff.preview) {
            const hlPrev = { mode: null }
            return React.createElement('div', { className: 'dsh-fe-pane' },
              toolbar,
              React.createElement('div', { className: 'dsh-fe-msg' },
                '文件过大，无法逐块审阅；仅显示前 ' + diff.preview.length + ' 行' + (diff.lineCount ? '（共 ' + diff.lineCount + ' 行）' : '') + '。'),
              error ? React.createElement('div', { className: 'dsh-fe-err' }, String(error)) : null,
              React.createElement('div', { className: 'dsh-fe-diff' },
                React.createElement('div', { className: 'dsh-fe-code' },
                  diff.preview.map((t, i) => row('p' + i, '', { n: i + 1, text: t }, false, null, hlPrev)),
                ),
              ),
            )
          }
          if (diff.note) {
            return React.createElement('div', { className: 'dsh-fe-pane' },
              toolbar,
              React.createElement('div', { className: 'dsh-fe-msg' },
                diff.note === 'binary' ? '二进制文件无法预览，可在修改列表中直接接受或拒绝' : (diff.note === 'shell-unknown' ? '已检测到脚本修改，但修改前内容无法恢复；请接受或手动检查文件。' : (diff.note === 'write-before-unknown' ? '已检测到文件被覆盖，但工具未返回修改前内容；为避免误判，不能自动拒绝，请接受或手动检查文件。' : '文件过大无法预览'))),
              error ? React.createElement('div', { className: 'dsh-fe-err' }, String(error)) : null,
            )
          }
          const current = diff.current || []
          const baseline = diff.baseline || []
          const hunks = diff.hunks || []
          const hunkOrdinal = {}
          for (let hi = 0; hi < hunks.length; hi++) hunkOrdinal[hunks[hi].id] = hi
          const blocks = []
          let cursor = 0
          for (const h of hunks) {
            if (h.newStart > cursor) {
              blocks.push({ kind: 'ctx', rows: range(cursor, h.newStart).map((i) => ({ n: i + 1, text: current[i], idx: i })) })
            }
            blocks.push({
              kind: 'hunk', h: h,
              oldRows: range(0, h.oldLen).map((i) => ({ n: h.oldStart + i + 1, text: baseline[h.oldStart + i] })),
              newRows: range(0, h.newLen).map((i) => ({ n: h.newStart + i + 1, text: current[h.newStart + i], idx: h.newStart + i })),
            })
            cursor = h.newStart + h.newLen
          }
          if (cursor < current.length) {
            blocks.push({ kind: 'ctx', rows: range(cursor, current.length).map((i) => ({ n: i + 1, text: current[i], idx: i })) })
          }
          if (current.length === 0) {
            // Empty file: one placeholder editable line so typing creates line 1.
            blocks.push({ kind: 'ctx', rows: [{ n: 1, text: '', idx: 0 }] })
          }
          // Diff jump controls use a stable cyclic cursor. The counter can
          // still follow deliberate manual scrolling, but smooth scrolling
          // initiated by a jump is temporarily locked so intermediate hunks
          // passing through the viewport cannot steal the cursor.
          const jumpTo = (k) => {
            const total = hunks.length
            if (total === 0) return
            const idx = ((k % total) + total) % total
            hunkCursor.path = path
            hunkCursor.idx = idx
            hunkCursor.programmatic = true
            if (hunkCursor.unlockTimer) clearTimeout(hunkCursor.unlockTimer)
            // Fallback for browsers that do not emit scroll events (for
            // example when the target is already aligned).
            hunkCursor.unlockTimer = setTimeout(() => {
              hunkCursor.programmatic = false
              hunkCursor.unlockTimer = null
            }, 1000)
            setFocusIdx(idx)
            const node = hunkRefs[idx]
            if (!node) return
            let scroller = null
            let el = node.parentElement
            while (el && el !== document.body) {
              const oy = getComputedStyle(el).overflowY
              if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1) { scroller = el; break }
              el = el.parentElement
            }
            if (!scroller) scroller = document.scrollingElement || document.documentElement
            const box = node.getBoundingClientRect()
            const sb = scroller.getBoundingClientRect()
            // Inside the diff's own viewport the sticky headers live OUTSIDE
            // the scroller, so no offset. For any outer scroller (the chat
            // column) the stuck tabs+toolbar cover the top — offset by them.
            const internal = scroller === diffRef.node
            const headerH = internal ? 0 : ((store.tabH || 32) + (store.toolH || 35) + 2)
            const target = scroller.scrollTop + (box.top - sb.top) - headerH
            try {
              scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
            } catch (e) {
              try { scroller.scrollTop = Math.max(0, target) } catch (e2) { try { node.scrollIntoView() } catch (e3) {} }
            }
          }
          const jumpRel = (dir) => {
            const total = hunks.length
            if (total === 0) return
            let base = hunkCursor.path === path ? hunkCursor.idx : null
            if (!Number.isInteger(base) || base < 0 || base >= total) base = null
            // With no current item, next starts at the first hunk and prev at
            // the last. Every later click advances exactly one hunk.
            jumpTo(base === null ? (dir === 'next' ? 0 : total - 1) : base + (dir === 'next' ? 1 : -1))
          }
          const onDiffScroll = () => {
            if (hunkCursor.programmatic) {
              // Keep extending the quiet period until smooth scrolling has
              // actually stopped. Intermediate hunks must never become the
              // button cursor merely because they crossed the viewport.
              if (hunkCursor.unlockTimer) clearTimeout(hunkCursor.unlockTimer)
              hunkCursor.unlockTimer = setTimeout(() => {
                hunkCursor.programmatic = false
                hunkCursor.unlockTimer = null
              }, 140)
              return
            }
            if (scrollGate.pending) return
            scrollGate.pending = true
            setTimeout(() => {
              scrollGate.pending = false
              const el = diffRef.node
              if (!el || hunks.length === 0) return
              const cbox = el.getBoundingClientRect()
              const mid = el.scrollTop + el.clientHeight * 0.35
              let best = -1
              for (let k = 0; k < hunks.length; k++) {
                const node = hunkRefs[k]
                if (!node) continue
                const top = node.getBoundingClientRect().top - cbox.top + el.scrollTop
                if (top <= mid) best = k
                else break
              }
              if (best >= 0 && best !== hunkCursor.idx) {
                hunkCursor.path = path
                hunkCursor.idx = best
                setFocusIdx(best)
              }
            }, 30)
          }
          const curFocus = hunks.length > 0 ? Math.min(focusIdx === null ? 0 : focusIdx, hunks.length - 1) : 0
          // Only exists while the file has diff changes; disappears with them.
          const jump = hunks.length > 0 ? React.createElement('div', { className: 'dsh-fe-jump' },
            React.createElement('span', { className: 'dsh-fe-jump-count' }, (curFocus + 1) + ' / ' + hunks.length),
            React.createElement('button', { type: 'button', className: 'dsh-fe-jump-btn', title: '上一处变更（按修改块顺序循环）', onClick: () => jumpRel('prev') }, IconChevUp(), '上一处'),
            React.createElement('button', { type: 'button', className: 'dsh-fe-jump-btn', title: '下一处变更（按修改块顺序循环）', onClick: () => jumpRel('next') }, '下一处', IconChevDown()),
          ) : null
          return React.createElement('div', { className: 'dsh-fe-pane', ref: (node) => { paneRef.node = node } },
            toolbar,
            error ? React.createElement('div', { className: 'dsh-fe-err' }, String(error)) : null,
            React.createElement('div', { className: 'dsh-fe-diffwrap' },
              // v1.8.1: zero-height sticky strip — the jump pill stays pinned
              // below the sticky header stack while the page scrolls, and is
              // simply absent when the file has no hunks.
              jump ? React.createElement('div', { className: 'dsh-fe-jumprow' }, jump) : null,
              React.createElement('div', {
                className: 'dsh-fe-diff',
                ref: (node) => { diffRef.node = node },
                onScroll: onDiffScroll,
              },
                blocks.map((b, i) => {
                  if (b.kind === 'ctx') {
                    return React.createElement('div', { key: 'c' + i, className: 'dsh-fe-code' },
                      b.rows.map((r) => row('c' + i + ':' + r.n, '', r, false, null, hlStateCur)))
                  }
                  const hIdx = hunkOrdinal[b.h.id]
                  const isFocus = focusIdx !== null && hIdx === curFocus
                  const hunkActing = !!(reviewAction && reviewAction.indexOf('hunk:' + b.h.id + ':') === 0)
                  return React.createElement('div', {
                    key: 'h' + i,
                    className: 'dsh-fe-hunk' + (isFocus ? ' dsh-fe-hunk-cur' : '') + (hunkActing ? ' dsh-fe-hunk-pending' : ''),
                    ref: (node) => { hunkRefs[hIdx] = node },
                  },
                    React.createElement('div', { className: 'dsh-fe-hunk-head' },
                      React.createElement('span', null,
                        (b.h.oldLen === 0 ? ('第 ' + (b.h.oldStart + 1) + ' 行前') : ('第 ' + (b.h.oldStart + 1) + '–' + (b.h.oldStart + b.h.oldLen) + ' 行'))
                        + ' → ' +
                        (b.h.newLen === 0 ? ('第 ' + (b.h.newStart + 1) + ' 行前') : ('第 ' + (b.h.newStart + 1) + '–' + (b.h.newStart + b.h.newLen) + ' 行'))),
                      React.createElement('span', { className: 'dsh-fe-spacer' }, null),
                      React.createElement(IconBtn, { tone: 'ok', small: true, title: hunkActing ? '处理中…' : '接受此块修改', disabled: !!reviewAction, busy: reviewAction === 'hunk:' + b.h.id + ':accept', onClick: () => onHunk(b.h, 'accept'), icon: IconCheck }),
                      React.createElement(IconBtn, { tone: 'no', small: true, className: 'dsh-fe-pair', title: hunkActing ? '处理中…' : '拒绝此块修改', disabled: !!reviewAction, busy: reviewAction === 'hunk:' + b.h.id + ':reject', onClick: () => onHunk(b.h, 'reject'), icon: IconCross }),
                    ),
                    React.createElement('div', { className: 'dsh-fe-code' },
                      b.oldRows.map((r) => row('o' + i + ':' + r.n, 'dsh-fe-old', r, false, null, hlStateBase)),
                      b.newRows.map((r) => row('n' + i + ':' + r.n, 'dsh-fe-new', r, false, null, hlStateCur)),
                    ),
                  )
                }),
                blocks.length === 0 ? React.createElement('div', { className: 'dsh-fe-msg' }, '没有未决定的修改') : null,
              ),
            ),
          )
        }

        function FileView(props) {
          const sid = props.sessionId
          useStore()
          React.useEffect(() => { if (sid) store.setSessionId(sid) }, [sid])
          // v1.12: the shell renders ONLY the active conversation view
          // (ConversationSession's renderSlot passes `only: active.id`), so
          // this component's mount ⟺ the 文件 view is active. The flag drives
          // the modified bar's overlay posture — floating over the editor's
          // bottom edge here, classic in-flow layout on 对话/轨迹.
          React.useEffect(() => { store.setFileViewActive(true); return () => store.setFileViewActive(false) }, [])
          const [dragIdx, setDragIdx] = React.useState(null)
          const [menuOpen, setMenuOpen] = React.useState(false)
          const [closingProcessed, setClosingProcessed] = React.useState(false)
          const [menuError, setMenuError] = React.useState(null)
          const menuRef = React.useState({ node: null })[0]
          const moreRef = React.useState({ node: null })[0]
          const firstMenuRef = React.useState({ node: null })[0]
          React.useEffect(() => {
            if (!menuOpen) return
            const onPointerDown = (event) => {
              if (!menuRef.node || !menuRef.node.contains(event.target)) setMenuOpen(false)
            }
            const onKeyDown = (event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              setMenuOpen(false)
              if (moreRef.node) moreRef.node.focus()
            }
            document.addEventListener('pointerdown', onPointerDown, true)
            document.addEventListener('keydown', onKeyDown, true)
            const timer = setTimeout(() => { if (firstMenuRef.node) firstMenuRef.node.focus() }, 0)
            return () => {
              clearTimeout(timer)
              document.removeEventListener('pointerdown', onPointerDown, true)
              document.removeEventListener('keydown', onKeyDown, true)
            }
          }, [menuOpen])
          // v1.8.1: sticky header heights. The tabs bar pins to the top of
          // the scrollport; its measured height feeds the toolbar/jump
          // sticky offsets (CSS var on the viewer root + store for JS math).
          const viewerRef = React.useState({ node: null })[0]
          const tabsRef = React.useState({ node: null })[0]
          React.useEffect(() => {
            const el = tabsRef.node
            if (el && el.offsetHeight > 0) {
              store.tabH = el.offsetHeight
              if (viewerRef.node) viewerRef.node.style.setProperty('--dsh-fe-tabs-h', el.offsetHeight + 'px')
            }
          })
          // v1.12.1: write the clearance var directly from the dockH channel
          // — no React re-render of this thousand-line view involved. The
          // v1.12.0 render-driven effect made every bar resize reconcile the
          // whole DiffPane tree (and the padding change reflow the editor),
          // which is the toggle CPU spike being fixed.
          React.useEffect(() => {
            const apply = () => { if (viewerRef.node) viewerRef.node.style.setProperty('--dsh-fe-dock-h', (store.dockH || 0) + 'px') }
            apply()
            return store.onDockH(apply)
          }, [])
          const tabs = store.tabs
          const active = store.active
          const modified = store.modified
          const draftDirty = store.draftDirty
          const closeProcessed = async () => {
            if (closingProcessed || !sid) return
            setClosingProcessed(true)
            setMenuError(null)
            const result = await call('getModified', { sessionId: sid })
            if (!result.ok) {
              setMenuError(result.error || result.message || '无法刷新待审核状态，未关闭任何文件')
              setClosingProcessed(false)
              return
            }
            const pending = (result.files || []).map((item) => item.id || item.path)
            store.setModified(pending)
            store.closeProcessed(pending)
            setClosingProcessed(false)
            setMenuOpen(false)
          }
          if (tabs.length === 0) {
            return React.createElement('div', { className: 'dsh-fe-viewer' },
              React.createElement('div', { className: 'dsh-fe-msg' }, '没有打开的文件：在左侧工作区的「项目文件」中点击/双击文件，或点击修改文件列表中的路径。'))
          }
          return React.createElement('div', { className: 'dsh-fe-viewer', ref: (node) => { viewerRef.node = node } },
            React.createElement('div', { className: 'dsh-fe-filetabs', ref: (node) => { tabsRef.node = node } },
              React.createElement('div', { className: 'dsh-fe-filetabs-scroll' }, tabs.map((t, i) => React.createElement('span', {
                key: t,
                className: 'dsh-fe-filetab' + (t === active ? ' dsh-fe-filetab-on' : '') + (dragIdx === i ? ' dsh-fe-tab-drag' : ''),
                title: store.deleted.has(t) ? ((reviewLabels.get(t) || t) + '（文件已删除，当前显示删除前内容）') : (reviewLabels.get(t) || t),
                draggable: true,
                onClick: () => store.activate(t),
                onDragStart: (ev) => { setDragIdx(i); if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move' },
                onDragEnter: (ev) => { ev.preventDefault(); if (dragIdx !== null && dragIdx !== i) { store.moveTab(dragIdx, i); setDragIdx(i) } },
                onDragOver: (ev) => ev.preventDefault(),
                onDragEnd: () => setDragIdx(null),
              },
                React.createElement('span', { className: 'dsh-fe-tab-ic' }, IconFile()),
                React.createElement('span', { className: 'dsh-fe-tab-name' + (store.deleted.has(t) ? ' dsh-fe-tab-name-deleted' : '') }, (reviewLabels.get(t) || t).split(/[\\/]/).pop()),
                modified.has(t) ? React.createElement('span', { className: 'dsh-fe-tab-dot', title: '有待决定的修改' }, null) : null,
                React.createElement(IconBtn, {
                  small: true,
                  className: 'dsh-fe-tab-x',
                  title: '关闭标签',
                  onClick: (ev) => { ev.stopPropagation(); store.closeTab(t) },
                  icon: IconClose,
                }),
              ))),
              React.createElement('div', { className: 'dsh-fe-tab-actions', ref: (node) => { menuRef.node = node } },
                React.createElement('button', {
                  type: 'button',
                  className: 'dsh-fe-iconbtn dsh-fe-tab-more',
                  title: '更多文件操作',
                  'aria-label': '更多文件操作',
                  'aria-haspopup': 'menu',
                  'aria-expanded': menuOpen ? 'true' : 'false',
                  ref: (node) => { moreRef.node = node },
                  onClick: () => { setMenuError(null); setMenuOpen((open) => !open) },
                }, IconMore()),
                menuOpen ? React.createElement('div', { className: 'dsh-fe-tab-menu', role: 'menu', 'aria-label': '文件标签操作' },
                  React.createElement('button', {
                    type: 'button',
                    className: 'dsh-fe-tab-menuitem',
                    role: 'menuitem',
                    ref: (node) => { firstMenuRef.node = node },
                    onClick: () => { setMenuOpen(false); store.closeAll() },
                  }, '关闭所有文件'),
                  React.createElement('button', {
                    type: 'button',
                    className: 'dsh-fe-tab-menuitem',
                    role: 'menuitem',
                    disabled: closingProcessed,
                    onClick: closeProcessed,
                  }, closingProcessed ? '正在检查…' : '关闭已处理文件'),
                  menuError ? React.createElement('div', { className: 'dsh-fe-tab-menuerror', role: 'status' }, menuError) : null,
                ) : null,
              ),
            ),
            React.createElement(DiffPane, { sid: sid, path: active, displayPath: reviewLabels.get(active) || active }),
          )
        }

        // ---------- registrations ----------
        ensureStyle()
        ctx.effect(() => removeStyle, 'dsh-file-edit: stylesheet')
        // [禁用] 项目树：改用 better-sidebar 的 Explorer，不再注册 sidebar.workspaces。
        // 审核栏(ModifiedBar)与 diff 视图(FileView)保留，修改检测不受影响。
        // ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
        //   { name: 'sidebar.workspaces', priority: -100 },
        //   WorkspaceSidebar,
        // ))
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
          { name: 'conversation.input.dock', id: 'dsh-file-edit-bar', order: 30 },
          ModifiedBar,
        ))
        ctx.slots.inject('conversation.view', () => ctx.slots.register(
          { name: 'conversation.view', id: 'dsh-file-edit', order: 20, label: '文件' },
          FileView,
        ))
      },
    }
  },
})
