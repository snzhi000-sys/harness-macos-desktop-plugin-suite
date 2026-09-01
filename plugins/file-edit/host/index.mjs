// dsh-file-edit — static host plugin.
// Persisted across DSH restarts: mounted from ~/.dsh/profiles/web/cordis.patch.yml.
// Browser RPC arrives at POST /dsh-file-edit/api (registered on ctx.webServer).
// Per-session review state (baseline + pending decisions) is persisted under
// ~/.dsh/dsh-file-edit-state/<sessionId>.json so accept/reject survives restarts.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, rmSync, lstatSync, realpathSync, statSync, watch as watchFs, copyFileSync, readlinkSync, symlinkSync, openSync, closeSync, readSync, fsyncSync } from 'node:fs'
import { join, dirname, basename, relative as relativePath, resolve as resolvePath, parse as parsePath, isAbsolute as isAbsolutePath } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'

const STATE_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-file-edit-state')
// v1.10.0 rename migration: the plugin used to live under dsh-files with its
// state in dsh-files-state/. Carry the old per-session review state (pending
// decisions, baselines, lastReject) over once so the rename does not reset
// every session's review state.
{
  const legacy = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-files-state')
  if (!existsSync(STATE_DIR) && existsSync(legacy)) {
    try { renameSync(legacy, STATE_DIR) } catch (e) {
      console.error('[dsh-file-edit] state migration failed:', e && e.message ? e.message : e)
    }
  }
}
mkdirSync(STATE_DIR, { recursive: true })

export default {
  // Hard dependencies: the loader waits for these host services to become
  // ACTIVE before apply runs (ctx.get is strict about fiber state and can
  // return undefined when the bundle layer is still settling).
  inject: ['fs', 'sandboxPolicy', 'sessions', 'webServer', 'shell', 'tools', 'systemPrompt'],
  apply(ctx) {
    const fs = ctx.fs
    const sandboxPolicy = ctx.sandboxPolicy
    const sessions = ctx.sessions
    const shell = ctx.shell
    const tools = ctx.tools
    const systemPrompt = ctx.systemPrompt
    const webServer = ctx.webServer
    if (!fs || !sandboxPolicy || !sessions || !webServer || !tools || !systemPrompt) {
      console.error('[dsh-file-edit] missing host services (fs, sandboxPolicy, sessions, webServer, tools, systemPrompt)')
      return
    }

    const MAX_CONTENT_BYTES = 512 * 1024
    const MAX_DIFF_LINES = 8000
    const MAX_ENTRIES = 8000
    const MAX_DEPTH = 16
    const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.dsh', '.idea', '.vscode', '.cache', '.turbo', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.eslintcache', '.DS_Store'])
    // Raw shell-family tools cannot express "allow writes, deny unlink" in
    // Harness' current sandbox vocabulary. They are therefore denied before
    // dispatch and replaced by shell_readonly below. This is intentionally a
    // tool-name gate, not command parsing: dynamic Python/Node scripts,
    // background jobs and sandbox escalation arguments all hit the same gate.
    const DIRECT_CONTENT_TOOLS = new Set(['write', 'edit'])
    const SHELL_TOOLS = new Set(['bash', 'shell', 'pwsh'])
    const RAW_SHELL_TOOLS = new Set([
      ...SHELL_TOOLS,
      'powershell',
      'shell_command',
      'terminal_open',
      'terminal_send',
    ])
    const RAW_SHELL_DENIAL = '严格文件审核已禁止 AI 使用可写原始 Shell。只读检查请使用 shell_readonly；文本创建或修改请使用 write/edit；删除文件或目录请使用 file_delete。'
    const SHELL_EVENT_SETTLE_MS = 140
    const knownSessions = new Set()
    // Undo safety: reject overwrites disk with baseline content, so every
    // reject snapshots the pre-reject bytes first (one undo level per
    // session). Binary baseline blobs and undo backups skip bigger files.
    const MAX_BACKUP_BYTES = 4 * 1024 * 1024
    // A structured delete is never destructive-first. Files and directories
    // are moved into a persistent per-session quarantine before the review
    // ledger is changed. These ceilings make it possible to fail closed when
    // a directory is too broad to inventory and verify safely.
    const MAX_DELETE_ENTRIES = 50000
    const MAX_DELETE_BYTES = 8 * 1024 * 1024 * 1024
    const MAX_DELETE_DEPTH = 64
    // v1.9: markdown files render fully in the viewer (no line cap, no
    // preview truncation). Content beyond the 512KB scan cap is read ON
    // DEMAND when the file is opened, bounded by this payload ceiling
    // (32MB — shipping more than that as JSON would defeat the purpose).
    const MAX_MD_RENDER_BYTES = 32 * 1024 * 1024
    // External review entries never use their absolute path as an RPC
    // authority. The host issues an opaque ledger key; the client may display
    // the absolute path, but every mutation must come back with this key.
    const EXTERNAL_KEY_PREFIX = '\u001edsh-external:'

    // ---------- text / path helpers ----------
    function splitLines(text) {
      if (!text) return []
      const t = text.replace(/\r\n/g, '\n')
      const parts = t.split('\n')
      if (t.endsWith('\n')) parts.pop()
      return parts
    }
    function joinLines(lines, trailingNL, crlf) {
      if (lines.length === 0) return ''
      const sep = crlf ? '\r\n' : '\n'
      return lines.join(sep) + (trailingNL ? sep : '')
    }
    function joinPath(root, rel) {
      const sep = root.indexOf('\\') >= 0 ? '\\' : '/'
      return root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep)
    }
    // Normalize a tool-provided path (write/edit `file_path`) to a workspace-
    // relative path. Absolute paths must live under the session root;
    // relative paths are cleaned (`./` stripped, backslashes unified) and
    // `..`/empty segments rejected. Returns null when the path cannot be
    // attributed to a workspace file (caller falls back to window mode).
    function normalizeRelPath(root, raw) {
      if (!root || typeof raw !== 'string' || raw === '') return null
      let p = raw.replace(/\\/g, '/')
      if (/^[A-Za-z]:\//.test(p) || p.startsWith('/')) {
        const r = String(root).replace(/\\/g, '/').replace(/\/+$/, '')
        const cmp = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s
        if (cmp(p) === cmp(r)) p = ''
        else if (cmp(p).startsWith(cmp(r) + '/')) p = p.slice(r.length + 1)
        else return null
      } else {
        p = p.replace(/^\.\//, '')
      }
      if (p === '' || p.split('/').some((s) => s === '' || s === '.' || s === '..')) return null
      return p
    }
    function isAbsoluteDiskPath(raw) {
      const p = String(raw || '').replace(/\\/g, '/')
      return p.startsWith('/') || /^[A-Za-z]:\//.test(p)
    }
    function isExternalKey(key) {
      return typeof key === 'string' && key.startsWith(EXTERNAL_KEY_PREFIX)
    }
    function canonicalExternalPath(raw) {
      const disk = resolvePath(String(raw))
      try { return realpathSync(disk) } catch (e) {
        // A create/delete event may name a path whose immediate parent also
        // does not exist. Resolve the nearest existing ancestor so macOS
        // aliases such as /var -> /private/var and directory symlinks cannot
        // disguise the real target.
        const tail = []
        let cursor = disk
        while (true) {
          const parent = dirname(cursor)
          if (parent === cursor) return disk
          tail.unshift(basename(cursor))
          cursor = parent
          try { return join(realpathSync(cursor), ...tail) } catch (e2) {}
        }
      }
    }
    function externalKey(absPath) {
      return EXTERNAL_KEY_PREFIX + Buffer.from(absPath, 'utf8').toString('base64url')
    }
    function absoluteFromExternalKey(key) {
      if (!isExternalKey(key)) return null
      try {
        const value = Buffer.from(key.slice(EXTERNAL_KEY_PREFIX.length), 'base64url').toString('utf8')
        return isAbsoluteDiskPath(value) ? value : null
      } catch (e) { return null }
    }
    function reviewKeyFromRaw(st, raw) {
      if (isAbsoluteDiskPath(raw)) {
        const canonical = canonicalExternalPath(raw)
        let canonicalRoot = st.root
        try { canonicalRoot = realpathSync(st.root) } catch (e) {}
        const rel = normalizeRelPath(canonicalRoot, canonical)
        return rel || externalKey(canonical)
      }
      const rel = normalizeRelPath(st.root, raw)
      if (rel) return rel
      return null
    }
    function reviewKeyFromApi(st, raw) {
      const value = typeof raw === 'string' ? raw : ''
      if (st.files.has(value)) return value
      if (isExternalKey(value) || isAbsoluteDiskPath(value)) return null
      // Workspace files remain openable from Explorer by relative path. An
      // external target is usable only after a trusted tool event created its
      // opaque key in this session's ledger.
      return normalizeRelPath(st.root, value)
    }
    // Opening and mutating are deliberately separate capabilities.  A user
    // may browse an arbitrary absolute regular file, but the client receives
    // only an opaque key and that key never grants whole-document editing.
    async function resolveOpenTarget(st, sid, args) {
      if (!st.root) await hydrateReviewLedger(sid)
      if (st.error) return { ok: false, error: st.error }
      const raw = args && typeof args.absolutePath === 'string' && args.absolutePath
        ? args.absolutePath
        : (args && typeof args.path === 'string' ? args.path : '')
      if (!raw) return { ok: false, error: 'invalid-path' }
      let diskPath
      try {
        diskPath = isAbsoluteDiskPath(raw) ? canonicalExternalPath(raw) : canonicalExternalPath(joinPath(st.root, raw))
      } catch (e) {
        return { ok: false, error: 'not-found' }
      }
      const key = reviewKeyFromRaw(st, diskPath)
      if (!key) return { ok: false, error: 'invalid-path' }
      let f = st.files.get(key)
      // A missing path is normally rejected. The only exception is a
      // session-owned deletion tombstone whose bytes are still available
      // through the quarantine/open-snapshot authority. This lets artifact
      // and chat links reopen reviewed deletions without granting arbitrary
      // missing paths or exposing the quarantine pathname to the client.
      let info
      try { info = lstatSync(diskPath) } catch (error) { info = null }
      if (!info) {
        if (!f || !f.cur || f.cur.present || (!f.deletion && !f.deletedPreview)) {
          return { ok: false, error: 'not-found' }
        }
        const preview = deletedPreviewPayload(st, f)
        if (reviewTargetIsExternal(key)) f.externalReadOnly = true
        return {
          ok: true,
          id: key,
          path: reviewDisplayPath(st, key),
          external: reviewTargetIsExternal(key),
          readOnly: true,
          deleted: true,
          kind: preview.deletedPreviewNote === 'binary' ? 'binary' : 'text',
        }
      }
      if (!info.isFile()) return { ok: false, error: 'not-a-file' }
      if (!f || !f.cur) {
        const entry = await loadFileEntry(st, key)
        if (!entry.present) return { ok: false, error: 'not-found' }
        f = { base: cloneEntry(entry), cur: entry, rev: 1, decisions: new Map() }
        st.files.set(key, f)
      }
      if (reviewTargetIsExternal(key)) f.externalReadOnly = true
      return {
        ok: true,
        id: key,
        path: reviewDisplayPath(st, key),
        external: reviewTargetIsExternal(key),
        readOnly: reviewTargetIsExternal(key),
        kind: f.cur && f.cur.note === 'binary' ? 'binary' : 'text',
      }
    }
    function reviewDiskPath(st, key) {
      if (isExternalKey(key)) {
        const abs = absoluteFromExternalKey(key)
        if (!abs) throw new Error('无效的外部审核目标')
        return abs
      }
      return joinPath(st.root, key)
    }
    function reviewDisplayPath(st, key) {
      return isExternalKey(key) ? absoluteFromExternalKey(key) : key
    }
    function reviewTargetIsExternal(key) { return isExternalKey(key) }
    // v1.9: markdown files get a full rendered view in the client. The flag
    // rides the entry so diffPayload can ship the whole document (no line
    // cap) without knowing the path at every call site.
    function isMarkdownPath(rel) {
      const base = String(rel || '').split('/').pop().toLowerCase()
      return base.endsWith('.md') || base.endsWith('.markdown')
    }
    function cloneEntry(e) {
      return { present: e.present, content: e.content, eol: e.eol, crlf: e.crlf === true, version: e.version, size: e.size, note: e.note, binRef: e.binRef ?? null, binSize: e.binSize ?? 0, md: e.md === true }
    }
    // "File was not in the baseline" as an explicit ABSENT entry instead of
    // null: every consumer (modifiedFiles / diffPayload / reject paths) then
    // treats it as a regular entry with present:false, which is what makes
    // newly created files render as one big "added" hunk and lets reject
    // restore the pre-file state (delete it).
    function absentEntry() {
      return { present: false, content: null, eol: false, crlf: false, version: null, size: 0, note: undefined, binRef: null, binSize: 0, md: false }
    }
    function textEntry(text, rel, version) {
      const raw = String(text)
      return {
        present: true,
        content: raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
        eol: /(?:\r\n|\r|\n)$/.test(raw),
        crlf: /\r\n/.test(raw),
        version,
        size: Buffer.byteLength(raw, 'utf8'),
        note: undefined,
        binRef: null,
        binSize: 0,
        md: isMarkdownPath(rel),
      }
    }
    function unknownShellBefore(rel, callId, size) {
      return {
        present: true,
        content: null,
        eol: false,
        crlf: false,
        version: `shell:${callId}:before-unknown`,
        size: size || 0,
        note: 'shell-unknown',
        binRef: null,
        binSize: 0,
        md: isMarkdownPath(rel),
      }
    }
    function unknownWriteBefore(rel, stamp) {
      return {
        present: true,
        content: null,
        eol: false,
        crlf: false,
        version: `event:${stamp}:before-unknown`,
        size: 0,
        note: 'write-before-unknown',
        binRef: null,
        binSize: 0,
        md: isMarkdownPath(rel),
      }
    }
    function ignoredReviewPath(rel) {
      const display = String(rel || '').replace(/\\/g, '/')
      const state = String(STATE_DIR).replace(/\\/g, '/').replace(/\/+$/, '')
      if (display === state || display.startsWith(state + '/')) return true
      const parts = display.split('/')
      return parts.some((part) => SKIP_DIRS.has(part))
    }

    function normalizedDiskPath(value) {
      const resolved = resolvePath(String(value))
      const withoutTrailing = resolved.replace(/[\\/]+$/, '')
      return withoutTrailing || parsePath(resolved).root
    }
    function sameDiskPath(left, right) {
      const normalizeCase = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value
      return normalizeCase(normalizedDiskPath(left)) === normalizeCase(normalizedDiskPath(right))
    }
    function diskPathInside(parent, candidate) {
      const rel = relativePath(normalizedDiskPath(parent), normalizedDiskPath(candidate))
      return rel === '' || (rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolutePath(rel))
    }
    function deletionId(deletion) {
      if (!deletion || typeof deletion !== 'object') return null
      const value = deletion.deletionBatchId ?? deletion.batchId
      return typeof value === 'string' && value ? value : null
    }
    function normalizeDeletion(deletion, base = null, cur = null) {
      const batchId = deletionId(deletion)
      if (!batchId) return null
      let deletedFrom = deletion.deletedFrom
      if (!['baseline', 'modified-in-session', 'created-in-session'].includes(deletedFrom)) {
        deletedFrom = base && !base.present && cur && !cur.present ? 'created-in-session' : 'baseline'
      }
      return { ...deletion, batchId, deletionBatchId: batchId, deletedFrom }
    }
    function isCreatedThenDeleted(f) {
      return !!(f && f.deletion && f.deletion.deletedFrom === 'created-in-session'
        && f.base && !f.base.present && f.cur && !f.cur.present)
    }
    function reviewStatus(f) {
      if (isCreatedThenDeleted(f)) return 'deleted'
      return !f.base || !f.base.present ? 'added' : (!f.cur.present ? 'deleted' : 'modified')
    }

    // ---------- line diff (Myers) ----------
    function myersOps(a, b) {
      const n = a.length, m = b.length
      let start = 0
      while (start < n && start < m && a[start] === b[start]) start++
      let endA = n, endB = m
      while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
      const na = endA - start, nb = endB - start
      if (na === 0 && nb === 0) return []
      if (na + nb > 6000) return null
      const max = na + nb
      const MAX_D = Math.min(400, max)
      const v = new Array(2 * max + 1).fill(0)
      const trace = []
      let found = -1
      outer: for (let d = 0; d <= MAX_D; d++) {
        trace.push(v.slice())
        for (let k = -d; k <= d; k += 2) {
          const idx = k + max
          let x
          if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) x = v[idx + 1]
          else x = v[idx - 1] + 1
          let y = x - k
          while (x < na && y < nb && a[start + x] === b[start + y]) { x++; y++ }
          v[idx] = x
          if (x >= na && y >= nb) { found = d; break outer }
        }
      }
      if (found < 0) return null
      let x = na, y = nb
      const rev = []
      for (let d = found; d >= 0; d--) {
        const vp = trace[d]
        const k = x - y
        const idx = k + max
        let prevK
        if (k === -d || (k !== d && vp[idx - 1] < vp[idx + 1])) prevK = k + 1
        else prevK = k - 1
        const prevX = vp[prevK + max]
        const prevY = prevX - prevK
        while (x > prevX && y > prevY) { rev.push({ t: 'e', i: start + x - 1, j: start + y - 1 }); x--; y-- }
        if (d > 0) {
          if (x === prevX) rev.push({ t: 'i', j: start + prevY })
          else rev.push({ t: 'd', i: start + prevX })
        }
        x = prevX; y = prevY
      }
      rev.reverse()
      return rev
    }

    function computeHunks(a, b) {
      const ops = myersOps(a, b)
      if (ops === null) {
        return [{ id: 'h0', oldStart: 0, oldLen: a.length, newStart: 0, newLen: b.length, newLines: b.slice() }]
      }
      const hunks = []
      let shift = 0
      let i = 0
      while (i < ops.length) {
        const op = ops[i]
        if (op.t === 'e') { i++; continue }
        const h = { oldStart: -1, oldLen: 0, newStart: -1, newLen: 0, newLines: [] }
        while (i < ops.length && ops[i].t !== 'e') {
          const o = ops[i]
          if (o.t === 'd') { if (h.oldStart < 0) h.oldStart = o.i; h.oldLen++ }
          else { if (h.newStart < 0) h.newStart = o.j; h.newLen++; h.newLines.push(b[o.j]) }
          i++
        }
        // Pure runs borrow the counterpart coordinate, corrected by the
        // CUMULATIVE shift accumulated from every earlier hunk (each prior
        // change moves the new file's indices by newLen − oldLen). The naive
        // mirror (newStart = oldStart) was only right for the FIRST hunk —
        // later pure hunks drifted by one per preceding change (live payload
        // with three deletions reported 101/197 instead of 100/195, which
        // also starved the last hunk of its trailing context block and broke
        // the jump caret chain). Op-derived coordinates (o.i/o.j) are already
        // absolute full-array indices and need no shift.
        if (h.oldStart < 0) h.oldStart = h.newStart - shift
        if (h.newStart < 0) h.newStart = h.oldStart + shift
        shift += h.newLen - h.oldLen
        hunks.push(h)
      }
      for (let k = 0; k < hunks.length; k++) hunks[k].id = 'h' + k
      return hunks
    }

    function mergeHunks(a, hunks, decisions) {
      const out = a.slice()
      for (let i = hunks.length - 1; i >= 0; i--) {
        const h = hunks[i]
        if (decisions.get(h.id) === 'reject') continue
        out.splice(h.oldStart, h.oldLen, ...h.newLines)
      }
      return out
    }

    // ---------- per-session state (with disk persistence) ----------
    function sidSafe(sid) {
      return sid.replace(/[^a-zA-Z0-9._-]/g, '_')
    }
    function stateFile(sid) {
      return join(STATE_DIR, sidSafe(sid) + '.json')
    }
    function undoRoot(sid) { return join(STATE_DIR, sidSafe(sid), 'undo') }
    function blobRoot(sid) { return join(STATE_DIR, sidSafe(sid), 'blobs') }
    function quarantineRoot(sid) { return join(STATE_DIR, sidSafe(sid), 'quarantine') }
    function newUndoRec() {
      return { opId: 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), files: [] }
    }
    // Publish (or drop) the reject-undo record. A reject that produced no
    // backups must also clear a stale previous record, otherwise the undo
    // toast would revert an older operation than the one just performed.
    function commitUndo(st, rec) {
      const root = undoRoot(st.sid)
      if (!rec || rec.files.length === 0) {
        st.lastReject = null
        if (rec) { try { rmSync(join(root, rec.opId), { recursive: true, force: true }) } catch (e) {} }
        return
      }
      st.lastReject = { opId: rec.opId, ts: Date.now(), files: rec.files }
      // Single undo level: drop any older backup dirs for this session.
      try {
        if (existsSync(root)) {
          for (const name of readdirSync(root)) {
            if (name !== rec.opId) { try { rmSync(join(root, name), { recursive: true, force: true }) } catch (e) {} }
          }
        }
      } catch (e) {}
    }
    function saveState(st) {
      try {
        const files = {}
        for (const entry of st.files) {
          const f = entry[1]
          // Persist only review state that must survive a restart. Saving
          // every clean workspace file duplicated both full text snapshots
          // and grew real sessions to ~92 MB; every accept/reject then
          // synchronously stringified and rewrote that entire file. Clean
          // files are rebuilt as the baseline by the first scan after boot.
          const contentEqual = !!(f.base && f.cur && f.base.content !== null && f.base.content === f.cur.content)
          const pending = !!(f.cur && isChanged(f) && !contentEqual)
          const deletion = normalizeDeletion(f.deletion, f.base, f.cur)
          if (!pending && f.decisions.size === 0 && !deletion) continue
          files[entry[0]] = {
            base: f.base,
            cur: f.cur,
            rev: f.rev,
            decisions: Object.fromEntries(f.decisions),
            deletion,
          }
        }
        // A compact persisted map is intentionally incomplete. On restart the
        // Host hydrates only these durable review targets; it must not rebuild
        // a clean-file baseline by walking the whole workspace on the startup
        // path. This has no effect on the live in-memory state.
        writeFileSync(stateFile(st.sid), JSON.stringify({ version: 5, root: st.root, baseReady: false, files, lastReject: st.lastReject ?? null }))
        // GC: drop binary blob files no longer referenced by any entry.
        try {
          const dir = blobRoot(st.sid)
          if (existsSync(dir)) {
            const refs = new Set()
            for (const entry of st.files) {
              const f = entry[1]
              if (f.base && f.base.binRef) refs.add(f.base.binRef)
              if (f.cur && f.cur.binRef) refs.add(f.cur.binRef)
            }
            for (const name of readdirSync(dir)) {
              if (!refs.has(name)) { try { rmSync(join(dir, name), { force: true }) } catch (e) {} }
            }
          }
        } catch (e) {}
      } catch (e) {
        console.error('[dsh-file-edit] saveState failed:', e)
      }
    }
    function loadState(sid) {
      try {
        const raw = readFileSync(stateFile(sid), 'utf8')
        const data = JSON.parse(raw)
        if (!data || typeof data !== 'object') return null
        const files = new Map()
        for (const key of Object.keys(data.files ?? {})) {
          const f = data.files[key]
          // Heal legacy states: base === null meant "not in baseline" but
          // every consumer expected a present:false entry.
          const base = f.base ?? absentEntry()
          if (base.crlf === undefined) base.crlf = false
          if (typeof base.binRef !== 'string') base.binRef = null
          const cur = f.cur ?? null
          if (cur && cur.crlf === undefined) cur.crlf = false
          if (cur && typeof cur.binRef !== 'string') cur.binRef = null
          const deletion = normalizeDeletion(f.deletion, base, cur)
          if (deletion && deletion.rootKind === 'directory' && !Number.isInteger(deletion.deletionFileCount)) {
            try {
              deletion.deletionFileCount = readDeletionBatchManifest({ sid }, deletionId(deletion)).manifest.entries.filter((entry) => entry && entry.kind === 'file').length
            } catch (error) {}
          }
          files.set(key, {
            base: base,
            cur: cur,
            rev: f.rev ?? 0,
            decisions: new Map(Object.entries(f.decisions ?? {})),
            deletion,
          })
        }
        const lr = data.lastReject
        const lastReject = lr && typeof lr.opId === 'string' && Array.isArray(lr.files)
          ? { opId: lr.opId, ts: lr.ts ?? 0, files: lr.files }
          : null
        return { version: Number(data.version) || 1, root: data.root ?? null, baseReady: data.baseReady === true, files, lastReject }
      } catch (e) {
        return null
      }
    }

    function bumpTree(st) { st.treeStamp = (st.treeStamp || 0) + 1 }

    function newState(sid) {
      const restored = loadState(sid)
      return {
        sid,
        root: restored?.root ?? null, policy: null, error: null,
        files: restored?.files ?? new Map(),
        hydrating: null, scanning: null, dirty: false, scannedAt: 0,
        baseReady: restored?.baseReady ?? false,
        lastReject: restored?.lastReject ?? null,
        // v2 persistence keeps pending files only. Compact a legacy full-map
        // state the first time this session is read; no review action needed.
        needsCompact: !!restored && restored.version < 3,
        // Agent changes are written directly into the review ledger from
        // successful tool results. Scanning is now discovery-only: it may
        // refresh Explorer/external disk truth, but may never claim an
        // unrelated file merely because a shell command ran in this session.
        mutationStamp: 0,
        // Monotonic per-session notification counter: bumped whenever the FILE
        // SET (not just content) changed. The client polls it via getModified
        // and reloads the sidebar file tree on change. Process-local only —
        // persistence is unnecessary (a fresh page reload re-fetches the tree).
        treeStamp: 0,
      }
    }
    const states = new Map()
    function stateFor(sid) {
      let s = states.get(sid)
      if (!s) { s = newState(sid); states.set(sid, s) }
      return s
    }

    // ---------- long-poll change wake-ups ----------
    // The client polls getModified every 6s as its fallback, but an agent
    // tool result only SETS the dirty flag — diff stats then lag until the
    // next poll. These waiters let a long-polled `wait` request resolve the
    // moment a mutation event lands (bursts are coalesced by a short timer),
    // so the client refreshes the stats immediately.
    const waiters = new Map()
    function notify(sid) {
      const set = waiters.get(sid)
      if (!set || set.size === 0) return
      waiters.delete(sid)
      for (const resolve of set) { try { resolve({ ok: true, changed: true }) } catch (e) {} }
    }
    const notifyTimers = new Map()
    function scheduleNotify(sid, delay) {
      const existing = notifyTimers.get(sid)
      if (existing) clearTimeout(existing)
      notifyTimers.set(sid, setTimeout(() => { notifyTimers.delete(sid); notify(sid) }, delay))
    }
    function requireState(args) {
      const sid = args && args.sessionId ? String(args.sessionId) : ''
      if (!sid) return null
      knownSessions.add(sid)
      return stateFor(sid)
    }
    function reviewOwnerSessionId(rawSid) {
      let sid = String(rawSid || '')
      const seen = new Set()
      while (sid && !seen.has(sid)) {
        seen.add(sid)
        const session = sessions.get(sid)
        const header = session && session.header
        if (!header || header.origin !== 'subagent' || typeof header.parentSession !== 'string' || !header.parentSession) return sid
        sid = header.parentSession
      }
      return String(rawSid || '')
    }
    function resolveSession(sid) {
      const session = sessions.get(sid)
      if (!session) return { error: 'session-not-found' }
      const cwd = session.header && session.header.cwd
      if (!cwd) return { error: 'no-workspace' }
      // Policy resolution must never take the scan down: a transient policy
      // failure is a retryable scan error, not a fatal one.
      let policy
      try { policy = sandboxPolicy.resolve({ session }) } catch (e) { policy = {} }
      return { session, policy, root: cwd }
    }

    // A persisted review ledger already contains every AI-attributed before /
    // after image that must survive restart. Re-entering a conversation only
    // needs to bind that ledger to its current Session root and lightly probe
    // the recorded targets; recursively rebuilding a baseline for thousands
    // of unrelated clean files blocks conversation and Explorer first paint.
    //
    // The probes deliberately do not rewrite entries. A path may have changed
    // again while Harness was closed, and the existing single-target paths
    // (getDiff / accept / reject) own the authoritative refresh and stale
    // checks. Keeping the durable image intact also means a missing target or
    // temporarily unavailable external volume can never erase pending review.
    async function hydrateReviewLedger(sid) {
      const st = stateFor(sid)
      if (st.baseReady) return
      if (st.hydrating) return st.hydrating
      const task = (async () => {
        const res = resolveSession(sid)
        if (res.error) {
          st.error = res.error
          return
        }
        if (st.root && st.root !== res.root) {
          st.files.clear()
          st.lastReject = null
        }
        st.root = res.root
        st.policy = res.policy
        st.error = null
        for (const [key, f] of st.files) {
          if (!f || (!f.base && !f.cur)) continue
          try {
            const target = await fs.resolve(reviewDiskPath(st, key))
            await fs.stat(target)
          } catch (e) {
            // Missing/unavailable is review state, not a hydration failure.
            // The target-specific action will classify it without dropping
            // the persisted before image or deletion tombstone.
          }
        }
        st.baseReady = true
      })()
      st.hydrating = task
      try { await task } finally { if (st.hydrating === task) st.hydrating = null }
    }

    function initializeEventState(sid) {
      knownSessions.add(sid)
      const st = stateFor(sid)
      const res = resolveSession(sid)
      if (res.error) throw new Error(res.error)
      if (st.root && st.root !== res.root) {
        st.files.clear()
        st.lastReject = null
      }
      st.root = res.root
      st.policy = res.policy
      st.error = null
      // A later discovery scan can safely baseline every unknown file. The
      // event itself already supplies the authoritative before-image.
      st.baseReady = true
      return st
    }

    function stageEntries(st, rel, beforeEntry, afterEntry, deletion = null) {
      const old = st.files.get(rel)
      const oldPending = !!(old && old.base && old.cur && isChanged(old)
        && !(old.base.content !== null && old.base.content === old.cur.content))
      const f = old ?? { base: null, cur: null, rev: 0, decisions: new Map() }
      if (!oldPending) f.base = cloneEntry(beforeEntry)
      f.cur = cloneEntry(afterEntry)
      f.decisions.clear()
      f.deletion = deletion
      f.rev++
      st.files.set(rel, f)
      if (beforeEntry.present !== afterEntry.present) bumpTree(st)
      return f
    }

    async function stageTextToolResult(exec, result) {
      const sid = reviewOwnerSessionId(exec?.agent?.session?.id)
      const value = result && result.value
      if (!sid || !value || typeof value !== 'object') return false
      if (typeof value.path !== 'string' || typeof value.after !== 'string') return false
      if (!(typeof value.before === 'string' || value.before === null)) return false
      const st = initializeEventState(sid)
      const rel = reviewKeyFromRaw(st, value.path)
      if (!rel) return false
      const stamp = (st.mutationStamp || 0) + 1
      st.mutationStamp = stamp
      const before = value.before === null
        ? (value.operation === 'create' ? absentEntry() : unknownWriteBefore(reviewDisplayPath(st, rel), stamp))
        : textEntry(value.before, reviewDisplayPath(st, rel), `event:${stamp}:before`)
      const after = textEntry(value.after, reviewDisplayPath(st, rel), `event:${stamp}:after`)
      // Tool payloads provide exact text but not the filesystem service's
      // concurrency token. Read only this one target after the successful
      // event so later reject can distinguish the AI version from a newer
      // edit without scanning any directory.
      try {
        const disk = await loadFileEntry(st, rel)
        if (disk.present && disk.content === after.content) {
          after.version = disk.version
          after.size = disk.size
        }
      } catch (e) {}
      stageEntries(st, rel, before, after)
      st.dirty = false
      saveState(st)
      scheduleNotify(sid, 80)
      return true
    }

    // Shell tools can hide workspace writes inside Python/Node scripts,
    // redirects, generators and child processes. Observe the exact lifetime
    // of each foreground call instead of trying to classify command syntax.
    // Explicit path literals are snapshotted before execution when possible;
    // the recursive watcher is the authority for the set of paths that
    // changed. A newly-born file has an exact ABSENT baseline. An overwrite
    // whose path was dynamically computed still enters review with an
    // explicit unrestorable baseline rather than being silently folded into
    // the external-change baseline.
    function explicitShellPaths(exec, st) {
      const root = st.root
      const args = exec && exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
      const command = typeof args.command === 'string' ? args.command : ''
      const workdir = typeof args.workdir === 'string'
        ? (args.workdir.startsWith('/') ? args.workdir : resolvePath(root, args.workdir))
        : root
      const out = new Set()
      const quoted = /(['"])([^'"\n\r]+)\1/g
      let match
      while ((match = quoted.exec(command)) !== null) {
        const raw = match[2].trim()
        if (!raw || raw.includes('\0') || raw.startsWith('-')) continue
        const disk = raw.startsWith('/') ? raw : resolvePath(workdir, raw)
        const key = reviewKeyFromRaw(st, disk)
        const display = key ? reviewDisplayPath(st, key) : null
        if (key && !ignoredReviewPath(display)) out.add(key)
      }
      return out
    }

    async function snapshotKnownShellPath(st, rel) {
      try {
        return await loadFileEntry(st, rel)
      } catch (e) {
        return absentEntry()
      }
    }

    function shellBirthWasInsideCall(st, rel, startedAt) {
      try {
        const info = statSync(reviewDiskPath(st, rel))
        return Number.isFinite(info.birthtimeMs) && info.birthtimeMs >= startedAt - 25
      } catch (e) {
        return false
      }
    }

    async function captureForegroundShell(exec, next) {
      const sid = reviewOwnerSessionId(exec?.agent?.session?.id)
      const args = exec && exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
      // The generic job registry owns background lifetime. Do not close a
      // transaction at the immediate "started job" acknowledgement and claim
      // that later writes were captured; background support is registered
      // separately when an owner-scoped jobs service is available.
      if (!sid || args.run_in_background === true) return next()
      const st = initializeEventState(sid)
      const startedAt = Date.now()
      const callId = String(exec.callId || `call-${startedAt}`)
      const changed = new Set()
      const before = new Map()
      for (const rel of explicitShellPaths(exec, st)) {
        before.set(rel, await snapshotKnownShellPath(st, rel))
      }

      const watchers = []
      let watcherError = null
      try {
        const watcher = watchFs(st.root, { recursive: true }, (_event, filename) => {
          if (filename === null || filename === undefined) {
            watcherError = new Error('shell audit watcher omitted the changed path')
            return
          }
          const rel = normalizeRelPath(st.root, String(filename))
          if (rel && !ignoredReviewPath(rel)) changed.add(rel)
        })
        watcher.on('error', (error) => { watcherError = error })
        watchers.push(watcher)
        const watchedExternal = new Set()
        for (const key of before.keys()) {
          if (!reviewTargetIsExternal(key)) continue
          const diskPath = reviewDiskPath(st, key)
          const parent = dirname(diskPath)
          const watchId = parent + '\0' + basename(diskPath)
          if (watchedExternal.has(watchId)) continue
          watchedExternal.add(watchId)
          const externalWatcher = watchFs(parent, { recursive: false }, (_event, filename) => {
            if (filename === null || filename === undefined || String(filename) === basename(diskPath)) changed.add(key)
          })
          externalWatcher.on('error', (error) => { watcherError = error })
          watchers.push(externalWatcher)
        }
      } catch (error) {
        for (const watcher of watchers) { try { watcher.close() } catch (e) {} }
        throw new Error(`无法建立 Shell 审核事务，命令未执行：${error && error.message ? error.message : error}`)
      }

      let result
      let thrown
      try {
        result = await next()
      } catch (error) {
        thrown = error
      } finally {
        await new Promise((resolve) => setTimeout(resolve, SHELL_EVENT_SETTLE_MS))
        for (const watcher of watchers) { try { watcher.close() } catch (e) {} }
      }

      if (watcherError) {
        console.error('[dsh-file-edit] shell audit watcher degraded:', watcherError && watcherError.message ? watcherError.message : watcherError)
      }
      // Explicitly named targets are cheap to re-check and must not depend on
      // the platform watcher delivering an overwrite event within its settle
      // window. Unchanged entries are filtered by the version/content checks
      // below, while real overwrites retain the exact pre-call snapshot.
      for (const rel of before.keys()) changed.add(rel)
      let staged = 0
      for (const rel of changed) {
        const old = st.files.get(rel)
        const oldPending = !!(old && old.base && old.cur && isChanged(old))
        const after = await loadFileEntry(st, rel)
        if (after.present) {
          try {
            if (!lstatSync(reviewDiskPath(st, rel)).isFile()) continue
          } catch (e) { continue }
        } else if (!before.has(rel) && !old && [...changed].some((candidate) => candidate.startsWith(rel + '/'))) {
          // Recursive watchers also report a deleted directory itself. Its
          // deleted children carry the reviewable file mutations; do not add
          // a fake file row for the directory path.
          continue
        }
        let prior = before.get(rel)
        if (!prior && old && old.cur) prior = cloneEntry(old.cur)
        if (!prior && after.present && shellBirthWasInsideCall(st, rel, startedAt)) prior = absentEntry()
        if (!prior) prior = unknownShellBefore(rel, callId, after.size)
        if (!oldPending && prior.present === after.present && prior.content !== null && after.content !== null && prior.content === after.content) continue
        if (!oldPending && prior.version === after.version) continue
        const stamp = (st.mutationStamp || 0) + 1
        st.mutationStamp = stamp
        stageEntries(st, rel, prior, after)
        staged++
      }
      if (staged > 0) {
        st.dirty = false
        saveState(st)
        scheduleNotify(sid, 80)
      }
      if (watcherError && !thrown) {
        throw new Error(`Shell 命令已结束，但审核监听器发生错误，结果可能不完整：${watcherError && watcherError.message ? watcherError.message : watcherError}`)
      }
      if (thrown) throw thrown
      return result
    }

    // ---------- scanning ----------
    async function loadFileEntry(st, rel) {
      const md = isMarkdownPath(reviewDisplayPath(st, rel))
      const target = await fs.resolve(reviewDiskPath(st, rel))
      let info
      try { info = await fs.stat(target) } catch (e) { info = undefined }
      if (!info) return { present: false, content: null, eol: false, crlf: false, version: null, size: 0, binRef: null, binSize: 0, md: md }
      if (info.size > MAX_CONTENT_BYTES) {
        return { present: true, content: null, eol: false, crlf: false, version: info.version, size: info.size, note: 'large', binRef: null, binSize: 0, md: md }
      }
      try {
        const text = await fs.readText(target)
        return { present: true, content: text.replace(/\r\n/g, '\n'), eol: text.endsWith('\n'), crlf: /\r\n/.test(text), version: info.version, size: info.size, binRef: null, binSize: 0, md: md }
      } catch (e) {
        // Binary content (readText refused it): snapshot the raw bytes (up to
        // MAX_BACKUP_BYTES) into the per-session blob dir so a later reject
        // can restore the baseline. Bigger binaries stay unrestorable.
        let binRef = null
        let binSize = 0
        if (info.size <= MAX_BACKUP_BYTES) {
          try {
            const bytes = await fs.readBytes(target, undefined, MAX_BACKUP_BYTES)
            const hash = createHash('sha1').update(rel).update(String(info.version)).digest('hex')
            const blobPath = join(blobRoot(st.sid), hash)
            if (!existsSync(blobPath)) {
              mkdirSync(blobRoot(st.sid), { recursive: true })
              writeFileSync(blobPath, bytes)
            }
            binRef = hash
            binSize = bytes.length
          } catch (e2) { binRef = null }
        }
        return { present: true, content: null, eol: false, crlf: false, version: info.version, size: info.size, note: 'binary', binRef: binRef, binSize: binSize, md: md }
      }
    }

    async function refreshOne(st, rel, w) {
      let f = st.files.get(rel)
      if (!f) { f = { base: null, cur: null, rev: 0, decisions: new Map() }; st.files.set(rel, f) }
      if (f.cur && f.cur.present && f.cur.version === w.version && f.cur.size === w.size) {
        return f
      }
      if (f.decisions.size > 0) { f.decisions.clear(); f.rev++ }
      f.cur = await loadFileEntry(st, rel)
      if (f.cur.present) {
        if (f.deletion) f.deletion = null
        f.deletedPreview = null
      }
      f.rev++
      return f
    }

    async function scan(sid) {
      const st = stateFor(sid)
      if (st.scanning) return st.scanning
      const task = (async () => {
        try {
          const res = resolveSession(sid)
          if (res.error) {
            // Session/workspace temporarily unavailable (session-not-found,
            // no-workspace, policy hiccup). Record the error and keep dirty
            // set: the pending mutation survives and the next scan retries.
            st.error = res.error
            return
          }
          st.root = res.root
          st.policy = res.policy
          try {
          const stamp = st.mutationStamp || 0
          const rootTarget = await fs.resolve(res.root)
          const walked = []
          await walkFiles(rootTarget, '', walked, 0, { n: 0 })
          const seen = new Set()
          const firstScan = !st.baseReady
          // Files already present in the event ledger keep their pending
          // baseline. Unknown/external changes discovered by this walk are
          // always folded into the current baseline and never become AI work.
          const wasPending = (f) => !!(f && f.base && f.cur &&
            (f.base.present !== f.cur.present || f.base.version !== f.cur.version))
          let treeChanged = false
          for (const w of walked) {
            seen.add(w.rel)
            const before = st.files.get(w.rel)
            // refreshOne mutates the SAME entry object, so the pre-refresh
            // values must be captured first — comparing before.cur against
            // f.cur afterwards would compare the object with itself.
            const beforeCur = before && before.cur ? before.cur : null
            const pending = !!(before && before.base && beforeCur &&
              (before.base.present !== beforeCur.present || before.base.version !== beforeCur.version))
            const f = await refreshOne(st, w.rel, w)
            if (!before || !beforeCur || beforeCur.present !== f.cur.present) treeChanged = true
            // First scan: baseline = current content. On later scans, a new
            // file is reviewable only when this session caused it; otherwise
            // it is an external/other-session change and becomes baseline.
            if (f.base === null) {
              f.base = cloneEntry(f.cur)
            } else if (!firstScan && !pending && isChanged(f)) {
              // Never let another task's disk change become this task's
              // review. Pending work is intentionally preserved, but a clean
              // entry with no local attribution advances to the new baseline.
              f.base = cloneEntry(f.cur)
              if (f.decisions.size > 0) f.decisions.clear()
            }
          }
          for (const entry of st.files) {
            const rel = entry[0], f = entry[1]
            // External entries are event-driven and intentionally outside the
            // workspace discovery walk. Refreshing them here would both make
            // `seen` lie and turn a capped workspace scan into disk scanning.
            if (reviewTargetIsExternal(rel)) continue
            if (!seen.has(rel) && f.cur && f.cur.present) {
              // `walkFiles` is intentionally capped at MAX_ENTRIES. An
              // unseen tracked file therefore does NOT necessarily mean it
              // was deleted: it may simply live beyond the scan window. Ask
              // the filesystem for this exact path before changing its
              // presence state. This keeps on-demand files in large
              // workspaces writable while preserving real deletion detection.
              let stillPresent = false
              try {
                const info = await fs.stat(await fs.resolve(joinPath(st.root, rel)))
                stillPresent = !!info
              } catch (e) {}
              if (stillPresent) continue
              treeChanged = true
              const pending = wasPending(f)
              if (f.decisions.size > 0) { f.decisions.clear(); f.rev++ }
              if (!f.deletion) f.deletedPreview = cloneEntry(f.cur)
              f.cur = absentEntry()
              f.rev++
              if (!firstScan && !pending) {
                // A deletion made outside this session (including by another
                // task in the same workspace) is baseline here, not review.
                f.base = absentEntry()
              }
            }
          }
          st.baseReady = true
          // A mutation that landed while this scan walked must keep the flag
          // so the next scan picks it up (mutationStamp guarded).
          if ((st.mutationStamp || 0) === stamp) {
            st.dirty = false
          }
          st.scannedAt = Date.now()
          st.error = null
          if (treeChanged && !firstScan) bumpTree(st)
          saveState(st)
          } catch (e) {
            st.error = e && e.message ? String(e.message) : String(e)
          }
        } catch (e) {
          st.error = e && e.message ? String(e.message) : String(e)
        }
      })()
      // CRITICAL: assign the promise first, then await it, and only clear the
      // flag when it is still ours. The old `st.scanning = (async () => {...}
      // finally { st.scanning = null })()` form raced: a scan that failed
      // SYNCHRONOUSLY (resolveSession error before the first await) ran its
      // finally BEFORE the assignment landed, so st.scanning ended up holding
      // a settled promise — truthy forever — and every later scan() returned
      // it without scanning. getModified then failed forever (adds/deletes
      // never appeared) while getDiff's single-file path kept working
      // (edits updated instantly).
      st.scanning = task
      try { await task } finally { if (st.scanning === task) st.scanning = null }
      return task
    }

    // Review actions only need an up-to-date view of their target file. The
    // old path called scan() unconditionally, walking up to 8000 workspace
    // entries before every click. A direct stat/read preserves the same stale
    // revision protection without blocking on unrelated files.
    async function refreshReviewTarget(st, sid, path) {
      if (!st.baseReady) await hydrateReviewLedger(sid)
      let f = st.files.get(path)
      if (!f || !f.cur) return f
      let info
      try { info = await fs.stat(await fs.resolve(reviewDiskPath(st, path))) } catch (e) { info = undefined }
      const changed = f.cur.present
        ? (!info || f.cur.version !== info.version || f.cur.size !== info.size)
        : !!info
      if (changed) {
        if (f.decisions.size > 0) f.decisions.clear()
        f.cur = await loadFileEntry(st, path)
        if (f.deletion && f.cur.present) f.deletion = null
        f.rev++
        saveState(st)
      }
      return f
    }

    // Reconcile every durable review target, never unrelated workspace files.
    // This is used by bulk actions and the rare dirty-ledger fallback; ordinary
    // startup hydration remains metadata-only so persisted rows paint first.
    async function reconcileReviewTargets(st, sid) {
      if (!st.baseReady) await hydrateReviewLedger(sid)
      if (st.error) return
      for (const key of [...st.files.keys()]) await refreshReviewTarget(st, sid, key)
      st.dirty = false
    }

    async function walkFiles(dirTarget, rel, out, depth, count) {
      if (depth > MAX_DEPTH || count.n >= MAX_ENTRIES) return
      let entries
      try { entries = await fs.listDir(dirTarget) } catch (e) { return }
      // [rc.5 兼容补丁] 文件优先于目录：先收集本层文件再递归子目录，
      // 避免超大工作区在 MAX_ENTRIES 上限下把浅层（根目录）文件挤到扫描范围外。
      for (const e of entries) {
        if (count.n >= MAX_ENTRIES) break
        if (e.type === 'file') {
          count.n++
          let version = e.version !== undefined ? e.version : null
          let size = e.size !== undefined ? e.size : 0
          if (version === null) {
            try {
              const info = await fs.stat(e.target)
              if (info) { version = info.version; size = info.size !== undefined ? info.size : size }
            } catch (err) {}
          }
          out.push({ rel: rel ? rel + '/' + e.name : e.name, version: version, size: size })
        }
      }
      for (const e of entries) {
        if (count.n >= MAX_ENTRIES) return
        if (e.type === 'directory') {
          if (SKIP_DIRS.has(e.name)) continue
          await walkFiles(e.target, rel ? rel + '/' + e.name : e.name, out, depth + 1, count)
        }
      }
    }

    async function treeNode(dirTarget, rel, depth, count) {
      if (depth > MAX_DEPTH || count.n >= MAX_ENTRIES) return null
      let entries
      try { entries = await fs.listDir(dirTarget) } catch (e) { return null }
      const node = { name: rel === '' ? '.' : rel.split('/').pop(), type: 'directory', children: [] }
      // [rc.5 兼容补丁] 文件优先于目录，保证根目录文件出现在文件树中。
      for (const e of entries) {
        if (count.n >= MAX_ENTRIES) break
        if (e.type === 'file') {
          count.n++
          node.children.push({ name: e.name, type: 'file', size: e.size !== undefined ? e.size : 0, path: rel ? rel + '/' + e.name : e.name })
        }
      }
      for (const e of entries) {
        if (count.n >= MAX_ENTRIES) break
        if (e.type === 'directory') {
          if (SKIP_DIRS.has(e.name)) continue
          const child = await treeNode(e.target, rel ? rel + '/' + e.name : e.name, depth + 1, count)
          if (child) node.children.push(child)
        }
      }
      return node
    }

    // ---------- analysis ----------
    function entryLines(entry) {
      return entry.present && entry.content !== null ? splitLines(entry.content) : []
    }
    function modifiedFiles(st) {
      const files = []
      for (const entry of st.files) {
        const rel = entry[0], f = entry[1]
        // Version-axis listing: content comparison alone cannot see binary
        // changes (content is null on both sides) and misses nothing for
        // text. A fresh mtime with identical text is a touch, not a change.
        if (!f.cur || !isChanged(f)) continue
        if (f.base && f.base.content !== null && f.base.content === f.cur.content) continue
        const status = reviewStatus(f)
        const note = (f.base && f.base.note) || f.cur.note || null
        const displayPath = reviewDisplayPath(st, rel)
        const deletionBatchId = deletionId(f.deletion)
        const deletionMeta = deletionBatchId
          ? {
              deletionBatchId,
              deletionRoot: f.deletion.root,
              deletionRootKind: f.deletion.rootKind,
              deletionFileCount: f.deletion.deletionFileCount,
              deletionRelativePath: f.deletion.manifestRelativePath,
              deletedFrom: f.deletion.deletedFrom,
              deletedAt: f.deletion.deletedAt,
              deleteTarget: f.deletion.deleteTarget,
              ...(isCreatedThenDeleted(f) ? { createdThenDeleted: true } : {}),
            }
          : {}
        const common = { id: rel, path: displayPath, external: reviewTargetIsExternal(rel), ...deletionMeta }
        if (isCreatedThenDeleted(f)) {
          files.push({ ...common, status, restorable: true, pending: 1, added: 0, removed: 0 })
          continue
        }
        if (note) {
          files.push({ ...common, status: status, note: note, restorable: note !== 'shell-unknown' && note !== 'write-before-unknown', pending: 1, added: 0, removed: 0 })
          continue
        }
        const baseLines = entryLines(f.base)
        const curLines = entryLines(f.cur)
        if (baseLines.length > MAX_DIFF_LINES || curLines.length > MAX_DIFF_LINES) {
          files.push({ ...common, status: status, note: 'large', pending: 1, added: 0, removed: 0 })
          continue
        }
        const hunks = computeHunks(baseLines, curLines)
        let added = 0, removed = 0, pending = 0
        for (const h of hunks) {
          if (f.decisions.has(h.id)) continue
          pending++
          added += h.newLen
          removed += h.oldLen
        }
        files.push({ ...common, status: status, pending: pending, added: added, removed: removed })
      }
      files.sort(function (x, y) { return x.path < y.path ? -1 : (x.path > y.path ? 1 : 0) })
      return files
    }

    // "There is a reviewable diff" for the file view: presence or on-disk
    // version differs from the baseline. Content-only comparison cannot see
    // binary/large changes (content is null), so the version axis is the
    // single truth that also covers those.
    function isChanged(f) {
      return isCreatedThenDeleted(f) || !f.base || !f.cur || f.base.present !== f.cur.present || f.base.version !== f.cur.version
    }

    function diffPayload(st, f, prevRev) {
      const deletionBatchId = deletionId(f.deletion)
      const deletionMeta = deletionBatchId
        ? {
            deletionBatchId,
            deletedFrom: f.deletion.deletedFrom,
            deletionRoot: f.deletion.root,
            deletionRootKind: f.deletion.rootKind,
            deletionFileCount: f.deletion.deletionFileCount,
            deletionRelativePath: f.deletion.manifestRelativePath,
            deletedAt: f.deletion.deletedAt,
            deleteTarget: f.deletion.deleteTarget,
            ...(isCreatedThenDeleted(f) ? { createdThenDeleted: true } : {}),
          }
        : {}
      const meta = { ...(f.externalReadOnly === true ? { external: true, readOnly: true } : {}), ...deletionMeta }
      const changed = isChanged(f)
      const retainedDeletion = !changed && f && f.deletedPreview && f.cur && !f.cur.present
      const status = retainedDeletion ? 'deleted' : reviewStatus(f)
      const restorable = !(f.base && (f.base.note === 'shell-unknown' || f.base.note === 'write-before-unknown'))
      if (prevRev !== undefined && prevRev !== null && prevRev === f.rev) {
        return { ok: true, same: true, rev: f.rev, ...meta }
      }
      // Deleted files: no line diff — the whole old content as red hunks was
      // noise. Ship a banner payload; the client offers accept (confirm the
      // deletion) / reject (restore from baseline) instead.
      if (status === 'deleted') {
        return { ok: true, rev: f.rev, status: status, changed: changed, restorable: restorable, deleted: true, readOnly: true, hunks: [], current: null, baseline: null, ...deletedPreviewPayload(st, f), ...meta }
      }
      // Created and deleted again within the session: nothing on disk now,
      // nothing in the baseline — net zero vs the baseline. Banner payload
      // instead of an empty "editable" file.
      if (status === 'added' && !f.cur.present) {
        return { ok: true, rev: f.rev, status: status, changed: false, zero: true, hunks: [], current: null, baseline: null, ...meta }
      }
      // v1.9: a clean markdown file renders in full (no line cap, no preview
      // truncation). Review states (changed) keep the diff/note paths below —
      // pending edits must stay visible for accept/reject.
      const md = (f.base && f.base.md) || (f.cur && f.cur.md)
      if (md && !changed && f.cur.content !== null) {
        const curLines = entryLines(f.cur)
        return { ok: true, rev: f.rev, status: status, changed: false, hunks: [], current: curLines, baseline: null, trailingNL: f.cur.eol === true, crlf: f.cur.crlf === true, ...meta }
      }
      const note = (f.base && f.base.note) || f.cur.note || null
      if (note) {
        // Large-but-text files (≤512KB, >8000 lines): content is already in
        // memory (loadFileEntry reads anything ≤512KB), so ship a read-only
        // preview head instead of nothing. Binary / oversized (>512KB) files
        // keep the plain note payload (no content loaded).
        if (note === 'large' && f.cur.content !== null) {
          const curLines = entryLines(f.cur)
          if (curLines.length > 0) {
            return {
              ok: true, rev: f.rev, status: status, changed: changed, note: note,
              hunks: [], current: null, baseline: null,
              preview: curLines.slice(0, 4000),
              lineCount: curLines.length,
              ...meta,
            }
          }
        }
        return { ok: true, rev: f.rev, status: status, changed: changed, note: note, restorable: note !== 'shell-unknown' && note !== 'write-before-unknown', hunks: [], current: null, baseline: null, ...meta }
      }
      const baseLines = entryLines(f.base)
      const curLines = entryLines(f.cur)
      if (baseLines.length > MAX_DIFF_LINES || curLines.length > MAX_DIFF_LINES) {
        return { ok: true, rev: f.rev, status: status, changed: changed, note: 'large', hunks: [], current: null, baseline: null, ...meta }
      }
      const all = computeHunks(baseLines, curLines)
      const hunks = []
      for (const h of all) if (!f.decisions.has(h.id)) hunks.push(h)
      return {
        ok: true, rev: f.rev, status: status, changed: changed, hunks: hunks,
        baseline: hunks.length > 0 ? baseLines : null,
        current: curLines, trailingNL: f.cur.eol === true, crlf: f.cur.crlf === true,
        ...meta,
      }
    }

    // ---------- mutations ----------
    async function writeFile(st, rel, content) {
      const target = await fs.resolve(reviewDiskPath(st, rel))
      const outcome = await fs.writeText(target, content, undefined, undefined, st.policy)
      return outcome
    }
    async function deleteFile(st, rel) {
      if (reviewTargetIsExternal(rel)) {
        const diskPath = reviewDiskPath(st, rel)
        let info
        try { info = lstatSync(diskPath) } catch (e) { return }
        if (!info.isFile()) throw new Error('删除失败：外部审核目标不再是普通文件')
        rmSync(diskPath)
        return
      }
      if (!shell) throw new Error('shell 服务不可用，无法删除文件')
      const target = await fs.resolve(reviewDiskPath(st, rel))
      const p = fs.processPath(target)
      const isWin = process.platform === 'win32'
      const bashQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
      const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'"
      // The shell executor on Windows is PowerShell (pwsh-local/sandbox): the
      // bash idiom `rm -f -- path` fails there ("-f is ambiguous"). Pick the
      // dialect by platform and fall back to the other one once.
      const primary = isWin
        ? 'Remove-Item -LiteralPath ' + psQuote(p) + ' -Force'
        : 'rm -f -- ' + bashQuote(p)
      const alternate = isWin
        ? 'rm -f -- ' + bashQuote(p)
        : 'Remove-Item -LiteralPath ' + psQuote(p) + ' -Force'
      let result
      try {
        result = await shell.run(shell.resolve({ command: primary, sandboxPolicy: st.policy }))
      } catch (e) {
        result = undefined
      }
      if (!result || result.exitCode !== 0) {
        try {
          result = await shell.run(shell.resolve({ command: alternate, sandboxPolicy: st.policy }))
        } catch (e) {
          result = undefined
        }
      }
      if (!result || result.exitCode !== 0) {
        const stderr = result && result.stderr && result.stderr.text !== undefined ? String(result.stderr.text) : String((result && result.stderr) || '')
        throw new Error('删除失败: ' + stderr)
      }
      // The plugin itself removed a file from disk: notify the client so the
      // sidebar file tree reloads (rejecting an added file = delete).
      bumpTree(st)
    }

    function toolSessionState(exec) {
      const sid = reviewOwnerSessionId(exec && exec.agent && exec.agent.session ? exec.agent.session.id : '')
      if (!sid) throw new Error('该文件操作必须由会话中的 AI 发起')
      return { sid, st: initializeEventState(sid) }
    }
    function assertRealPathInsideRoot(st, diskPath, existing) {
      const rootReal = realpathSync(st.root)
      const candidate = realpathSync(existing ? diskPath : dirname(diskPath))
      const cmp = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s
      const rootCmp = cmp(rootReal.replace(/[\\/]+$/, ''))
      const candidateCmp = cmp(candidate)
      if (candidateCmp !== rootCmp && !candidateCmp.startsWith(rootCmp + (process.platform === 'win32' ? '\\' : '/'))) {
        throw new Error('路径通过符号链接指向了工作区之外')
      }
    }
    async function validatedRegularFile(st, raw, label) {
      const rel = normalizeRelPath(st.root, raw)
      if (!rel) throw new Error(label + '必须是当前工作区内的文件路径')
      const target = await fs.resolve(joinPath(st.root, rel))
      const diskPath = fs.processPath(target)
      assertRealPathInsideRoot(st, diskPath, true)
      let info
      try { info = lstatSync(diskPath) } catch (e) { throw new Error(label + '不存在') }
      if (info.isSymbolicLink()) throw new Error(label + '不能是符号链接')
      if (!info.isFile()) throw new Error(label + '必须是普通文件，不能是文件夹')
      return { rel, target, diskPath }
    }

    function deletionBatchId() {
      return 'batch-' + Date.now().toString(36) + '-' + randomBytes(6).toString('hex')
    }
    function deleteManifestEntry(root, diskPath, depth) {
      if (depth > MAX_DELETE_DEPTH) throw new Error(`删除目录超过安全深度限制（${MAX_DELETE_DEPTH} 层）`)
      const info = lstatSync(diskPath)
      const rel = diskPath === root ? '.' : relativePath(root, diskPath).split('\\').join('/')
      if (info.isSymbolicLink()) {
        return { relativePath: rel, kind: 'symlink', size: info.size, linkTarget: readlinkSync(diskPath) }
      }
      if (info.isFile()) return { relativePath: rel, kind: 'file', size: info.size }
      if (info.isDirectory()) return { relativePath: rel, kind: 'directory', size: 0 }
      throw new Error(`删除目标包含不支持的特殊文件：${rel}`)
    }
    function buildDeleteManifestEntries(root) {
      const entries = []
      let totalBytes = 0
      const visit = (diskPath, depth) => {
        const entry = deleteManifestEntry(root, diskPath, depth)
        entries.push(entry)
        if (entries.length > MAX_DELETE_ENTRIES) throw new Error(`删除目录超过安全条目限制（${MAX_DELETE_ENTRIES} 项）`)
        if (entry.kind === 'file') {
          totalBytes += entry.size
          if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_DELETE_BYTES) {
            throw new Error(`删除目录超过隔离区安全容量限制（${MAX_DELETE_BYTES} 字节）`)
          }
        }
        if (entry.kind !== 'directory') return
        for (const child of readdirSync(diskPath, { withFileTypes: true })) visit(join(diskPath, child.name), depth + 1)
      }
      visit(root, 0)
      entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      return { entries, totalBytes }
    }
    function hashFile(diskPath) {
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      const fd = openSync(diskPath, 'r')
      try {
        let offset = 0
        while (true) {
          const count = readSync(fd, buffer, 0, buffer.length, offset)
          if (count === 0) break
          hash.update(buffer.subarray(0, count))
          offset += count
        }
      } finally { closeSync(fd) }
      return hash.digest('hex')
    }
    function copyDeletePayload(source, destination, entries) {
      for (const entry of entries) {
        const suffix = entry.relativePath === '.' ? '' : entry.relativePath
        const from = suffix ? join(source, suffix) : source
        const to = suffix ? join(destination, suffix) : destination
        if (entry.kind === 'directory') mkdirSync(to, { recursive: true })
        else if (entry.kind === 'file') {
          mkdirSync(dirname(to), { recursive: true })
          copyFileSync(from, to)
          const fd = openSync(to, 'r')
          try { fsyncSync(fd) } finally { closeSync(fd) }
        } else {
          mkdirSync(dirname(to), { recursive: true })
          symlinkSync(entry.linkTarget, to)
        }
      }
    }
    function verifyDeletePayload(source, destination, expectedEntries) {
      const actual = buildDeleteManifestEntries(destination)
      if (actual.entries.length !== expectedEntries.length) throw new Error('隔离区校验失败：条目数量不一致')
      for (let index = 0; index < expectedEntries.length; index++) {
        const expected = expectedEntries[index]
        const found = actual.entries[index]
        if (expected.relativePath !== found.relativePath || expected.kind !== found.kind || expected.size !== found.size || expected.linkTarget !== found.linkTarget) {
          throw new Error(`隔离区校验失败：${expected.relativePath}`)
        }
        if (expected.kind === 'file') {
          const suffix = expected.relativePath === '.' ? '' : expected.relativePath
          if (hashFile(suffix ? join(source, suffix) : source) !== hashFile(suffix ? join(destination, suffix) : destination)) {
            throw new Error(`隔离区校验失败：${expected.relativePath} 内容不一致`)
          }
        }
      }
    }
    function writeDeleteManifest(batchRoot, manifest) {
      const target = join(batchRoot, 'manifest.json')
      const temporary = target + '.tmp-' + randomBytes(4).toString('hex')
      writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n')
      const fd = openSync(temporary, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, target)
    }
    function quarantinedFilePath(st, deletion) {
      const batchId = deletionId(deletion)
      if (!batchId || !/^batch-[a-z0-9]+-[a-f0-9]{12}$/.test(batchId)) {
        throw new Error('隔离区记录无效')
      }
      const rel = String(deletion.quarantineRelativePath || '').replace(/\\/g, '/')
      if (!rel || rel.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('隔离区文件记录无效')
      const batchRoot = join(quarantineRoot(st.sid), batchId)
      const diskPath = resolvePath(batchRoot, rel)
      if (!diskPathInside(batchRoot, diskPath)) throw new Error('隔离区文件越界')
      const info = lstatSync(diskPath)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('隔离区原文件不存在')
      return diskPath
    }
    function deletedPreviewPayload(st, f) {
      let entry = null
      let source = null
      let note = null
      if (f && f.deletion) {
        try {
          const target = quarantinedFilePath(st, f.deletion)
          const info = statSync(target)
          if (info.size > MAX_CONTENT_BYTES) note = 'large'
          else {
            const bytes = readFileSync(target)
            if (bytes.includes(0)) note = 'binary'
            else {
              try {
                const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
                entry = textEntry(text, f.deletion.manifestRelativePath || '', null)
                source = 'quarantine'
              } catch (error) { note = 'binary' }
            }
          }
        } catch (error) {
          note = 'unavailable'
        }
      } else if (f && f.deletedPreview && f.deletedPreview.present) {
        entry = f.deletedPreview
        source = 'open-snapshot'
        note = entry.note || (entry.content === null ? 'unavailable' : null)
      }
      if (!entry || entry.content === null) {
        return { deletedPreview: null, deletedPreviewSource: source, deletedPreviewNote: note || 'unavailable' }
      }
      return {
        deletedPreview: entryLines(entry),
        deletedPreviewSource: source,
        deletedPreviewNote: null,
        deletedPreviewTrailingNL: entry.eol === true,
        deletedPreviewCrlf: entry.crlf === true,
      }
    }
    function retainDeletedPreview(st, f, path) {
      const preview = deletedPreviewPayload(st, f)
      if (!Array.isArray(preview.deletedPreview)) return
      const content = preview.deletedPreview.join('\n')
        + (preview.deletedPreviewTrailingNL && preview.deletedPreview.length > 0 ? '\n' : '')
      f.deletedPreview = textEntry(content, path, null)
    }
    function cleanupCompletedFileDeletion(st, deletion) {
      const batchId = deletionId(deletion)
      if (!batchId || deletion.rootKind !== 'file') return
      try { rmSync(join(quarantineRoot(st.sid), batchId), { recursive: true, force: true }) } catch (error) {}
    }
    function readDeletionBatchManifest(st, rawBatchId) {
      const batchId = String(rawBatchId || '')
      if (!/^batch-[a-z0-9]+-[a-f0-9]{12}$/.test(batchId)) throw new Error('删除批次无效')
      const batchRoot = join(quarantineRoot(st.sid), batchId)
      let manifest
      try { manifest = JSON.parse(readFileSync(join(batchRoot, 'manifest.json'), 'utf8')) } catch (error) {
        throw new Error('删除批次清单不存在或已损坏')
      }
      if (!manifest || manifest.version !== 1 || manifest.batchId !== batchId || manifest.sessionId !== st.sid || manifest.kind !== 'directory' || !Array.isArray(manifest.entries)) {
        throw new Error('删除批次清单无效')
      }
      const targetPath = String(manifest.targetPath || '')
      if (!isAbsoluteDiskPath(targetPath)) throw new Error('删除批次目标路径无效')
      const seenEntries = new Set()
      for (const entry of manifest.entries) {
        if (!entry || typeof entry.relativePath !== 'string' || !['directory', 'file', 'symlink'].includes(entry.kind)) throw new Error('删除批次条目无效')
        const rel = entry.relativePath.replace(/\\/g, '/')
        if (rel !== '.' && rel.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('删除批次条目路径无效')
        if (seenEntries.has(rel)) throw new Error('删除批次包含重复条目')
        seenEntries.add(rel)
        if (entry.kind === 'symlink' && typeof entry.linkTarget !== 'string') throw new Error('删除批次符号链接记录无效')
      }
      if (!seenEntries.has('.') || manifest.entries.find((entry) => entry.relativePath === '.')?.kind !== 'directory') throw new Error('删除批次缺少目录根条目')
      if (Number.isInteger(manifest.entryCount) && manifest.entryCount !== manifest.entries.length) throw new Error('删除批次条目数量不一致')
      const payloadRelativePath = String(manifest.payloadRelativePath || '').replace(/\\/g, '/')
      if (!payloadRelativePath || payloadRelativePath.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('删除批次清单路径无效')
      const payloadPath = resolvePath(batchRoot, payloadRelativePath)
      if (!diskPathInside(batchRoot, payloadPath)) throw new Error('删除批次隔离路径越界')
      return { batchId, batchRoot, payloadPath, manifest }
    }
    function directoryBatchRecords(st, rawBatchId) {
      const batch = readDeletionBatchManifest(st, rawBatchId)
      const records = []
      for (const [key, f] of st.files) {
        if (deletionId(f.deletion) === batch.batchId && f.deletion.rootKind === 'directory') records.push({ key, f })
      }
      records.sort((left, right) => left.key.localeCompare(right.key))
      const expectedFiles = batch.manifest.entries.filter((entry) => entry && entry.kind === 'file').length
      if (records.length === 0) throw new Error('删除批次已处理或不存在')
      if (records.length !== expectedFiles) {
        const error = new Error('该目录批次已有文件被单独处理，请按剩余文件逐个审核')
        error.code = 'batch-partial'
        throw error
      }
      const expectedRelativePaths = new Set(batch.manifest.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.relativePath))
      for (const record of records) {
        const deletion = record.f.deletion
        if (!expectedRelativePaths.has(deletion.manifestRelativePath)) throw new Error('删除批次文件清单与审核账本不一致')
        const rootPath = canonicalExternalPath(isAbsoluteDiskPath(deletion.root) ? deletion.root : resolvePath(st.root, String(deletion.root || '')))
        if (!sameDiskPath(rootPath, batch.manifest.targetPath)) throw new Error('删除批次目标与审核账本不一致')
      }
      return { ...batch, records, expectedFiles }
    }
    function cleanupDirectoryBatch(batch) {
      try { rmSync(batch.batchRoot, { recursive: true, force: true }) } catch (error) {}
    }
    function restoreDirectoryBatchPayload(batch) {
      const targetPath = resolvePath(String(batch.manifest.targetPath || ''))
      if (!isAbsoluteDiskPath(targetPath) || sameDiskPath(targetPath, parsePath(targetPath).root)) throw new Error('目录恢复目标无效')
      if (existsSync(targetPath)) {
        const error = new Error('无法恢复目录：原路径已被其他内容占用')
        error.code = 'stale'
        throw error
      }
      if (!existsSync(batch.payloadPath)) throw new Error('目录隔离内容不存在')
      verifyDeletePayload(batch.payloadPath, batch.payloadPath, batch.manifest.entries)
      mkdirSync(dirname(targetPath), { recursive: true })
      if (statSync(batch.payloadPath).dev === statSync(dirname(targetPath)).dev) {
        renameSync(batch.payloadPath, targetPath)
      } else {
        const temporary = targetPath + '.dsh-restore-' + randomBytes(5).toString('hex')
        try {
          copyDeletePayload(batch.payloadPath, temporary, batch.manifest.entries)
          verifyDeletePayload(batch.payloadPath, temporary, batch.manifest.entries)
          renameSync(temporary, targetPath)
          rmSync(batch.payloadPath, { recursive: true, force: true })
        } catch (error) {
          if (existsSync(temporary)) { try { rmSync(temporary, { recursive: true, force: true }) } catch (cleanupError) {} }
          throw error
        }
      }
      return targetPath
    }
    async function prepareDirectoryBatch(st, sid, rawBatchId) {
      const batch = directoryBatchRecords(st, rawBatchId)
      for (const record of batch.records) {
        const f = await refreshReviewTarget(st, sid, record.key)
        if (!f || deletionId(f.deletion) !== batch.batchId || (f.cur && f.cur.present)) {
          const error = new Error('目录内文件已重新出现，请刷新后重新审核')
          error.code = 'stale'
          throw error
        }
      }
      return batch
    }
    async function acceptDirectoryBatch(st, sid, rawBatchId) {
      const batch = await prepareDirectoryBatch(st, sid, rawBatchId)
      for (const record of batch.records) {
        retainDeletedPreview(st, record.f, record.key)
        await doAccept(st, record.f, record.key)
      }
      cleanupDirectoryBatch(batch)
      return batch
    }
    async function rejectDirectoryBatch(st, sid, rawBatchId) {
      const batch = await prepareDirectoryBatch(st, sid, rawBatchId)
      restoreDirectoryBatchPayload(batch)
      for (const record of batch.records) {
        const deletion = record.f.deletion
        record.f.cur = await loadFileEntry(st, record.key)
        if (!record.f.cur.present) throw new Error(`目录恢复后缺少文件：${reviewDisplayPath(st, record.key)}`)
        if (deletion.deletedFrom === 'baseline') {
          record.f.base = { ...cloneEntry(record.f.base), version: record.f.cur.version, size: record.f.cur.size }
        }
        record.f.decisions.clear()
        record.f.deletion = null
        record.f.deletedPreview = null
        record.f.rev++
      }
      cleanupDirectoryBatch(batch)
      st.lastReject = null
      bumpTree(st)
      return batch
    }
    function completeDirectoryBatchGroups(list) {
      const groups = new Map()
      for (const item of list) {
        if (!item.deletionBatchId || item.deletionRootKind !== 'directory' || !Number.isInteger(item.deletionFileCount)) continue
        let group = groups.get(item.deletionBatchId)
        if (!group) {
          group = { batchId: item.deletionBatchId, root: item.deletionRoot, expected: item.deletionFileCount, items: [] }
          groups.set(item.deletionBatchId, group)
        }
        group.items.push(item)
      }
      return [...groups.values()].filter((group) => group.items.length === group.expected && group.items.every((item) => item.deletionRoot === group.root))
    }
    function validateDeleteTarget(st, raw) {
      const supplied = String(raw || '').trim()
      if (!supplied) throw new Error('file_path 不能为空')
      const lexical = isAbsoluteDiskPath(supplied) ? resolvePath(supplied) : resolvePath(st.root, supplied)
      let lexicalInfo
      try { lexicalInfo = lstatSync(lexical) } catch (e) { throw new Error('待删除路径不存在') }
      if (lexicalInfo.isSymbolicLink()) throw new Error('待删除路径不能是符号链接')
      if (!lexicalInfo.isFile() && !lexicalInfo.isDirectory()) throw new Error('待删除路径必须是普通文件或目录')
      const diskPath = realpathSync(lexical)
      const rootReal = realpathSync(st.root)
      const stateReal = realpathSync(STATE_DIR)
      const homeReal = realpathSync(homedir())
      const fsRoot = parsePath(diskPath).root
      if (sameDiskPath(diskPath, fsRoot)) throw new Error('禁止删除文件系统根目录')
      if (sameDiskPath(diskPath, homeReal) || diskPathInside(diskPath, homeReal)) throw new Error('禁止删除用户主目录或其上级目录')
      if (sameDiskPath(diskPath, rootReal) || diskPathInside(diskPath, rootReal)) throw new Error('禁止删除当前工作区根目录或其上级目录')
      if (diskPathInside(diskPath, stateReal) || diskPathInside(stateReal, diskPath)) throw new Error('禁止删除文件审核状态目录')
      const key = reviewKeyFromRaw(st, diskPath)
      if (!key) throw new Error('无法为待删除路径建立审核标识')
      return {
        diskPath,
        key,
        displayPath: reviewDisplayPath(st, key),
        external: reviewTargetIsExternal(key),
        kind: lexicalInfo.isDirectory() ? 'directory' : 'file',
      }
    }
    async function quarantineDelete(st, sid, item, preparedInventory = null) {
      const inventory = preparedInventory ?? buildDeleteManifestEntries(item.diskPath)
      const batchId = deletionBatchId()
      const batchRoot = join(quarantineRoot(sid), batchId)
      const payloadRelativePath = join('payload', basename(item.diskPath))
      const payloadPath = join(batchRoot, payloadRelativePath)
      mkdirSync(dirname(payloadPath), { recursive: true })
      let transport = statSync(item.diskPath).dev === statSync(dirname(payloadPath)).dev ? 'rename' : 'copy'
      const manifest = {
        version: 1,
        batchId,
        sessionId: sid,
        targetPath: item.diskPath,
        reviewKey: item.key,
        external: item.external,
        kind: item.kind,
        createdAt: new Date().toISOString(),
        transport,
        payloadRelativePath: payloadRelativePath.split('\\').join('/'),
        entryCount: inventory.entries.length,
        totalBytes: inventory.totalBytes,
        entries: inventory.entries,
      }
      writeDeleteManifest(batchRoot, manifest)
      try {
        if (transport === 'rename') {
          try { renameSync(item.diskPath, payloadPath) } catch (error) {
            if (!error || error.code !== 'EXDEV') throw error
            transport = 'copy'
            manifest.transport = transport
            writeDeleteManifest(batchRoot, manifest)
          }
        }
        if (transport === 'copy' && existsSync(item.diskPath)) {
          copyDeletePayload(item.diskPath, payloadPath, inventory.entries)
          verifyDeletePayload(item.diskPath, payloadPath, inventory.entries)
          rmSync(item.diskPath, { recursive: item.kind === 'directory' })
        }
        if (existsSync(item.diskPath) || !existsSync(payloadPath)) throw new Error('隔离事务未能完整转移删除目标')
        return { batchId, batchRoot, payloadPath, payloadRelativePath: manifest.payloadRelativePath, manifest }
      } catch (error) {
        // An incomplete copy is safe to discard only while the original is
        // still present. If removal already began, preserve the quarantine as
        // the recovery authority and surface the failure.
        if (existsSync(item.diskPath)) {
          try { rmSync(batchRoot, { recursive: true, force: true }) } catch (cleanupError) {}
        }
        throw new Error('删除已阻止：无法建立完整隔离备份。' + (error && error.message ? error.message : String(error)))
      }
    }

    function registerAgentFileTools() {
      const objectOutput = {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string' },
            from: { type: 'string' },
            to: { type: 'string' },
            deletionBatchId: { type: 'string' },
            kind: { type: 'string' },
            entryCount: { type: 'number' },
          },
          required: ['ok'],
        },
        render: (_args, value) => [{ type: 'text', text: value.from
          ? `Moved file ${value.from} to ${value.to}`
          : `Deleted file ${value.path}` }],
      }
      const disposers = []
      disposers.push(tools.register({
        name: 'shell_readonly',
        description: 'Run a foreground shell command under a forced read-only filesystem sandbox. Use this for inspection, search, tests that do not write, and diagnostics. It cannot run in the background or request wider sandbox permissions.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            command: { type: 'string', description: 'Shell command that must not create, modify, move, or delete files.' },
            workdir: { type: 'string', description: 'Optional working directory. Relative paths resolve from the current workspace.' },
            timeout_ms: { type: 'number', description: 'Optional positive timeout in milliseconds.' },
          },
          required: ['command'],
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              stdout: { type: 'string' },
              stderr: { type: 'string' },
            },
            required: ['ok', 'exitCode', 'stdout', 'stderr'],
          },
          render: (_args, value) => [{
            type: 'text',
            text: `${[value.stdout, value.stderr].filter(Boolean).join(value.stdout && value.stderr ? '\n' : '').replace(/\n+$/, '')}${value.stdout || value.stderr ? '\n' : ''}[exit code: ${value.exitCode ?? 'signal'}]`,
          }],
        },
        async execute(args, exec) {
          exec.signal.throwIfAborted()
          if (!shell || shell.sandboxMode === undefined) throw new Error('只读 Shell 不可用：当前执行器没有文件系统沙箱，命令未执行')
          if (!args || typeof args.command !== 'string' || args.command.trim() === '') throw new Error('command 不能为空')
          if (args.timeout_ms !== undefined && (!Number.isFinite(args.timeout_ms) || args.timeout_ms <= 0)) throw new Error('timeout_ms 必须是正数')
          const { st } = toolSessionState(exec)
          const workdir = typeof args.workdir === 'string' && args.workdir !== ''
            ? (isAbsolutePath(args.workdir) ? args.workdir : resolvePath(st.root, args.workdir))
            : st.root
          const policy = sandboxPolicy.resolve({ session: exec.agent.session, mode: 'read-only' })
          if (!policy || policy.mode !== 'read-only') throw new Error('只读 Shell 策略解析失败，命令未执行')
          const result = await shell.run(shell.resolve({
            command: args.command,
            workdir,
            ...args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {},
            sandboxPolicy: policy,
            signal: exec.signal,
          }))
          const stdout = result && result.stdout && typeof result.stdout.text === 'string' ? result.stdout.text : ''
          const stderr = result && result.stderr && typeof result.stderr.text === 'string' ? result.stderr.text : ''
          return { ok: result?.exitCode === 0, exitCode: result && Number.isInteger(result.exitCode) ? result.exitCode : null, stdout, stderr }
        },
      }))
      disposers.push(tools.register({
        name: 'file_delete',
        description: 'Delete one file or directory inside or outside the current workspace by first moving it to a persistent review quarantine. Every regular file in a directory is added to the current task review. Do not use shell rm for paths the user may need to review.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { file_path: { type: 'string', description: 'Existing file or directory path. Relative paths resolve from the current workspace; absolute paths may be outside it.' } },
          required: ['file_path'],
        },
        output: objectOutput,
        async execute(args, exec) {
          exec.signal.throwIfAborted()
          if (!args || typeof args.file_path !== 'string' || args.file_path.trim() === '') throw new Error('file_path 不能为空')
          const { sid, st } = toolSessionState(exec)
          const item = validateDeleteTarget(st, args.file_path)
          const inventory = buildDeleteManifestEntries(item.diskPath)
          const beforeEntries = new Map()
          for (const manifestEntry of inventory.entries) {
            if (manifestEntry.kind !== 'file') continue
            const diskPath = manifestEntry.relativePath === '.' ? item.diskPath : join(item.diskPath, manifestEntry.relativePath)
            const key = reviewKeyFromRaw(st, diskPath)
            if (!key) throw new Error(`无法为目录内文件建立审核标识：${manifestEntry.relativePath}`)
            const prior = st.files.get(key)
            const priorPending = !!(prior && prior.base && prior.cur && isChanged(prior))
            const deletedFrom = priorPending
              ? (prior.base.present ? 'modified-in-session' : 'created-in-session')
              : 'baseline'
            beforeEntries.set(manifestEntry.relativePath, { key, before: await loadFileEntry(st, key), deletedFrom })
          }
          const transaction = await quarantineDelete(st, sid, item, inventory)
          const deletedAt = new Date().toISOString()
          const deletionFileCount = inventory.entries.filter((entry) => entry.kind === 'file').length
          const stamp = (st.mutationStamp || 0) + 1
          st.mutationStamp = stamp
          for (const [manifestRelativePath, record] of beforeEntries) {
            const quarantineRelativePath = manifestRelativePath === '.'
              ? transaction.payloadRelativePath
              : join(transaction.payloadRelativePath, manifestRelativePath).split('\\').join('/')
            stageEntries(st, record.key, record.before, absentEntry(), {
              batchId: transaction.batchId,
              deletionBatchId: transaction.batchId,
              deletedFrom: record.deletedFrom,
              deletedAt,
              deleteTarget: reviewDisplayPath(st, record.key),
              root: item.displayPath,
              rootKind: item.kind,
              deletionFileCount,
              manifestRelativePath,
              quarantineRelativePath,
            })
          }
          bumpTree(st)
          st.dirty = false
          saveState(st)
          scheduleNotify(sid, 80)
          return {
            ok: true,
            path: item.displayPath,
            deletionBatchId: transaction.batchId,
            kind: item.kind,
            entryCount: transaction.manifest.entryCount,
          }
        },
      }))
      disposers.push(tools.register({
        name: 'file_move',
        description: 'Move or rename one regular file inside the current workspace and add both sides of the move to the current task review. The destination must not already exist. Do not use shell mv for reviewable files.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            source_path: { type: 'string', description: 'Existing regular file inside the current workspace.' },
            destination_path: { type: 'string', description: 'New file path inside the current workspace; its parent folder must already exist.' },
          },
          required: ['source_path', 'destination_path'],
        },
        output: objectOutput,
        async execute(args, exec) {
          exec.signal.throwIfAborted()
          if (!args || typeof args.source_path !== 'string' || args.source_path.trim() === '') throw new Error('source_path 不能为空')
          if (typeof args.destination_path !== 'string' || args.destination_path.trim() === '') throw new Error('destination_path 不能为空')
          const { sid, st } = toolSessionState(exec)
          const source = await validatedRegularFile(st, args.source_path, '源路径')
          const destinationRel = normalizeRelPath(st.root, args.destination_path)
          if (!destinationRel) throw new Error('目标路径必须位于当前工作区内')
          if (destinationRel === source.rel) throw new Error('源路径和目标路径不能相同')
          const destinationTarget = await fs.resolve(joinPath(st.root, destinationRel))
          const destinationDiskPath = fs.processPath(destinationTarget)
          if (existsSync(destinationDiskPath)) throw new Error('目标路径已存在，禁止覆盖')
          assertRealPathInsideRoot(st, destinationDiskPath, false)
          const before = await loadFileEntry(st, source.rel)
          renameSync(source.diskPath, destinationDiskPath)
          const after = await loadFileEntry(st, destinationRel)
          const stamp = (st.mutationStamp || 0) + 1
          st.mutationStamp = stamp
          stageEntries(st, source.rel, before, absentEntry())
          stageEntries(st, destinationRel, absentEntry(), after)
          st.dirty = false
          saveState(st)
          scheduleNotify(sid, 80)
          return { ok: true, from: source.rel, to: destinationRel }
        },
      }))
      return () => { for (const dispose of disposers.reverse()) dispose() }
    }

    ctx.effect(registerAgentFileTools, 'dsh-file-edit: agent file tools')
    // The pre-execute listener below provides early feedback and compatibility,
    // while the monotonic runtime guard is the security boundary. Guards run
    // after the complete extensible pre-execute waterfall, so another plugin
    // cannot short-circuit with an allow decision and resurrect raw shell.
    ctx.effect(() => tools.guard((exec) => RAW_SHELL_TOOLS.has(exec.name) ? RAW_SHELL_DENIAL : undefined), 'dsh-file-edit: strict raw shell guard')
    ctx.effect(() => systemPrompt.section({
      name: 'tool:file-review-ledger',
      order: 103,
      text: 'Strict file review is enabled. Use write/edit for text creation and edits, file_delete for deleting any file or directory (including absolute paths outside the workspace), and file_move for moving or renaming a workspace file. file_delete quarantines content before removal. Writable raw shell tools are blocked before execution; use shell_readonly for inspection and diagnostics. Never try to bypass this gate with Python, Node, PowerShell, a background command, a persistent terminal, or sandbox escalation.',
    }), 'dsh-file-edit: file tool guidance')
    // Copy the file's current bytes into the undo dir before a reject
    // overwrites or deletes them. Returns the record entry (afterVersion is
    // filled by the caller once the reject write/delete has settled), or
    // null when there is nothing to back up (absent / too large / bad path).
    async function snapshotForUndo(st, path, rec) {
      try {
        const target = await fs.resolve(reviewDiskPath(st, path))
        const info = await fs.stat(target)
        if (!info || info.size > MAX_BACKUP_BYTES) return null
        const bytes = await fs.readBytes(target, undefined, MAX_BACKUP_BYTES)
        const backupName = createHash('sha256').update(path).digest('hex')
        const dir = join(undoRoot(st.sid), rec.opId)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, backupName), bytes)
        return { key: path, path: reviewDisplayPath(st, path), backupName, afterVersion: null }
      } catch (e) {
        return null
      }
    }
    async function doReject(st, f, path, rec) {
      const wasAbsent = !f.cur || !f.cur.present
      const completedDeletion = f.deletion
      if (completedDeletion && wasAbsent && f.base) {
        // Structured deletes retain the exact bytes in quarantine. Restore
        // from that authority instead of relying on the normal 512KB text /
        // 4MB binary baseline caps. If the file was already pending before
        // deletion, keep that earlier baseline so rejecting only the delete
        // returns to the added/modified review state.
        const source = quarantinedFilePath(st, completedDeletion)
        const targetPath = reviewDiskPath(st, path)
        if (existsSync(targetPath)) throw new Error('无法还原：原路径已被其他内容占用')
        mkdirSync(dirname(targetPath), { recursive: true })
        copyFileSync(source, targetPath)
        const fd = openSync(targetPath, 'r')
        try { fsyncSync(fd) } finally { closeSync(fd) }
        if (hashFile(source) !== hashFile(targetPath)) {
          try { rmSync(targetPath, { force: true }) } catch (cleanupError) {}
          throw new Error('无法还原：隔离区内容校验失败')
        }
        f.cur = await loadFileEntry(st, path)
        if (completedDeletion.deletedFrom === 'baseline') {
          f.base = { ...cloneEntry(f.base), version: f.cur.version, size: f.cur.size }
        }
      } else if (!f.base || !f.base.present) {
        // Added file: reject = delete. If it is already gone (agent deleted
        // it after our scan), converge idempotently instead of making the
        // shell fail on a nonexistent path.
        let info
        try { info = await fs.stat(await fs.resolve(reviewDiskPath(st, path))) } catch (e) { info = undefined }
        if (!info) {
          f.base = cloneEntry(f.cur)
          f.decisions.clear()
          f.deletion = null
          f.rev++
          return
        }
        const snap = rec ? await snapshotForUndo(st, path, rec) : null
        await deleteFile(st, path)
        f.cur = { present: false, content: null, eol: false, crlf: false, version: null, size: 0, binRef: null, binSize: 0 }
        if (snap) { snap.afterVersion = null; rec.files.push(snap) }
      } else if (f.base.content === null) {
        // Binary / oversized baseline: restore the byte snapshot taken at
        // baseline time (binaries up to MAX_BACKUP_BYTES only).
        const blobPath = f.base.binRef ? join(blobRoot(st.sid), f.base.binRef) : null
        if (!blobPath || !existsSync(blobPath)) throw new Error('无法还原：文件过大或非文本')
        const snap = rec ? await snapshotForUndo(st, path, rec) : null
        const target = await fs.resolve(reviewDiskPath(st, path))
        writeFileSync(fs.processPath(target), readFileSync(blobPath))
        const info = await fs.stat(target)
        f.cur = { present: true, content: null, eol: false, crlf: false, version: info.version, size: info.size, note: 'binary', binRef: f.base.binRef, binSize: f.base.binSize }
        // Restored content IS the baseline again: align versions so
        // isChanged() reports no diff (binary has no content comparison).
        f.base = { ...cloneEntry(f.base), version: info.version, size: info.size }
        if (snap) { snap.afterVersion = info.version; rec.files.push(snap) }
      } else {
        const snap = rec ? await snapshotForUndo(st, path, rec) : null
        // Write back with the ORIGINAL line endings: normalizing to LF here
        // used to rewrite CRLF files wholesale (one giant spurious diff).
        const writeContent = f.base.crlf ? f.base.content.split('\n').join('\r\n') : f.base.content
        const outcome = await writeFile(st, path, writeContent)
        f.cur = { present: true, content: f.base.content, eol: f.base.eol, crlf: f.base.crlf, version: outcome.version, size: outcome.size !== undefined ? outcome.size : writeContent.length, binRef: null, binSize: 0 }
        // Restored content IS the baseline: align versions so isChanged()
        // reports no diff (matters for large files where content comparison
        // is unavailable).
        f.base = { ...cloneEntry(f.base), version: outcome.version, size: outcome.size !== undefined ? outcome.size : writeContent.length }
        if (snap) { snap.afterVersion = outcome.version; rec.files.push(snap) }
      }
      f.decisions.clear()
      f.deletion = null
      cleanupCompletedFileDeletion(st, completedDeletion)
      f.rev++
      // A deleted file came back to disk: notify the client so the sidebar
      // file tree reloads (scan-only detection would miss this write).
      if (wasAbsent) bumpTree(st)
    }
    async function doAccept(st, f, path) {
      const completedDeletion = f.deletion
      if (completedDeletion && f.cur && f.cur.present) throw new Error('文件已重新出现，请刷新后重新审核，未确认删除')
      // A binary baseline needs its bytes for a future reject; snapshot them
      // now that this content becomes the new baseline.
      if (f.cur && f.cur.present && f.cur.note === 'binary' && !f.cur.binRef) {
        try {
          const target = await fs.resolve(reviewDiskPath(st, path))
          const info = await fs.stat(target)
          if (info && info.size <= MAX_BACKUP_BYTES) {
            const bytes = await fs.readBytes(target, undefined, MAX_BACKUP_BYTES)
            const hash = createHash('sha1').update(path).update(String(info.version)).digest('hex')
            const blobPath = join(blobRoot(st.sid), hash)
            if (!existsSync(blobPath)) {
              mkdirSync(blobRoot(st.sid), { recursive: true })
              writeFileSync(blobPath, bytes)
            }
            f.cur.binRef = hash
            f.cur.binSize = bytes.length
          }
        } catch (e) {}
      }
      f.base = cloneEntry(f.cur)
      f.decisions.clear()
      f.deletion = null
      cleanupCompletedFileDeletion(st, completedDeletion)
      f.rev++
    }

    // ---------- RPC API ----------
    const api = {
      async resolveOpenTarget(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        return resolveOpenTarget(st, String(args.sessionId), args)
      },
      // Restart hydration never waits for a full workspace scan. Version-2+
      // state files contain durable pending review entries, which are already
      // sufficient to paint the ModifiedBar immediately; getModified follows
      // with target-only ledger hydration and leaves unrelated clean files
      // untouched.
      async getModifiedSnapshot(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        return {
          ok: true,
          root: st.root,
          files: modifiedFiles(st),
          treeStamp: st.treeStamp,
          restoring: !st.baseReady,
          undo: st.lastReject ? { opId: st.lastReject.opId, count: st.lastReject.files.length, ts: st.lastReject.ts } : null,
        }
      },

      async listTree(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const rootOverride = args && args.root ? String(args.root) : null
        if (rootOverride) {
          try {
            const rootTarget = await fs.resolve(rootOverride)
            const tree = await treeNode(rootTarget, '', 0, { n: 0 })
            return { ok: true, root: rootOverride, tree: tree }
          } catch (e) {
            return { ok: false, error: e && e.message ? String(e.message) : String(e) }
          }
        }
        await scan(sid)
        if (st.error) return { ok: false, error: st.error }
        try {
          const rootTarget = await fs.resolve(st.root)
          const tree = await treeNode(rootTarget, '', 0, { n: 0 })
          return { ok: true, root: st.root, tree: tree }
        } catch (e) {
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
      },

      async getModified(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        if (!st.baseReady) await hydrateReviewLedger(sid)
        if (st.baseReady && st.dirty) await reconcileReviewTargets(st, sid)
        if (st.error) return { ok: false, error: st.error }
        if (st.needsCompact) {
          saveState(st)
          st.needsCompact = false
        }
        return { ok: true, root: st.root, files: modifiedFiles(st), treeStamp: st.treeStamp, undo: st.lastReject ? { opId: st.lastReject.opId, count: st.lastReject.files.length, ts: st.lastReject.ts } : null }
      },

      // Long-poll wake-up: resolves as soon as an agent mutation (write/edit/
      // shell/pwsh tool result) dirties the session — or immediately when it
      // is already dirty — otherwise after WAIT_MS. The client chains these
      // calls so diff stats update the moment a tool result lands instead of
      // waiting for its 6s fallback poll.
      async wait(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        if (st.baseReady && st.dirty) return { ok: true, changed: true }
        const WAIT_MS = 15000
        const MAX_WAITERS = 4
        return await new Promise((resolve) => {
          let set = waiters.get(sid)
          if (!set) { set = new Set(); waiters.set(sid, set) }
          if (set.size >= MAX_WAITERS) { resolve({ ok: true, changed: false }); return }
          let settled = false
          let h = null
          const finish = (payload) => {
            if (settled) return
            settled = true
            if (h) clearTimeout(h)
            set.delete(finish)
            resolve(payload)
          }
          set.add(finish)
          h = setTimeout(() => finish({ ok: true, changed: false }), WAIT_MS)
        })
      },

      async getDiff(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const path = reviewKeyFromApi(st, args && args.path ? String(args.path) : '')
        if (!path) return { ok: false, error: 'invalid-path' }
        if (!st.baseReady) await hydrateReviewLedger(sid)
        // v1.13.4: another task can change and accept the same workspace file
        // without dirtying THIS session. Always validate the single file being
        // opened instead of trusting its per-session in-memory snapshot. This
        // is only one stat/read, not a workspace scan. Clean external changes
        // advance this session's baseline; an existing local review remains a
        // review, preserving per-task review isolation.
        if (!st.error) {
          try {
            const f = st.files.get(path)
            if (f && f.cur) {
              let info
              try { info = await fs.stat(await fs.resolve(reviewDiskPath(st, path))) } catch (e) { info = undefined }
              const changed = f.cur.present
                ? (!info || f.cur.version !== info.version || f.cur.size !== info.size)
                : !!info
              if (changed && f.decisions.size > 0) { f.decisions.clear(); f.rev++ }
              if (changed) {
                const pending = !!(f.base && f.cur &&
                  (f.base.present !== f.cur.present || f.base.version !== f.cur.version))
                if (!info && f.cur.present && !f.deletion) f.deletedPreview = cloneEntry(f.cur)
                f.cur = await loadFileEntry(st, path)
                if (f.cur.present) {
                  if (f.deletion) f.deletion = null
                  f.deletedPreview = null
                }
                f.rev++
                // A non-pending change made outside this task (including an
                // accepted edit in another task) is current disk truth here,
                // not a new review item. Deletions advance the baseline too.
                if (!pending) {
                  f.base = cloneEntry(f.cur)
                  f.decisions.clear()
                  f.rev++
                }
              }
            }
            // NOTE: dirty deliberately stays set. getModified reconciles every
            // known review target before clearing it. Agent-created/deleted
            // paths enter the event ledger directly and never depend on a
            // discovery scan to remain visible.
          } catch (e) {}
        }
        if (st.error) return { ok: false, error: st.error }
        let f = st.files.get(path)
        // Files that never went through a scan load on demand as ordinary
        // disk truth. Agent-created files are already in the event ledger.
        if (!f || !f.cur) {
          try {
            const entry = await loadFileEntry(st, path)
            if (!entry.present) return { ok: true, missing: true }
            if (!f) {
              f = { base: null, cur: null, rev: 0, decisions: new Map() }
              st.files.set(path, f)
              // The map did not know this file: the sidebar tree may not show
              // it yet, so notify the client to reload (a later scan would see
              // no "new" presence change and would not bump again).
              bumpTree(st)
            }
            f.cur = entry
            if (f.base === null) f.base = cloneEntry(entry)
            f.rev++
            saveState(st)
          } catch (e) {
            return { ok: true, missing: true }
          }
        }
        if (!f.cur) return { ok: true, missing: true }
        if (reviewTargetIsExternal(path)) f.externalReadOnly = true
        // v1.9: large markdown (>512KB scan cap) loads its content ON DEMAND
        // when the file is opened, so the viewer renders the whole document
        // (bounded by MAX_MD_RENDER_BYTES). The entry keeps note:'large' for
        // every other consumer; only the diff payload treats it as renderable.
        if (f.cur.md && f.cur.note === 'large' && f.cur.content === null && f.cur.size <= MAX_MD_RENDER_BYTES) {
          try {
            const target = await fs.resolve(reviewDiskPath(st, path))
            const text = await fs.readText(target)
            if (typeof text === 'string') {
              f.cur.content = text.replace(/\r\n/g, '\n')
              f.cur.crlf = /\r\n/.test(text)
              f.cur.eol = text.endsWith('\n')
              f.rev++
            }
          } catch (e) {}
        }
        const prev = args && args.rev !== undefined && args.rev !== null ? Number(args.rev) : undefined
        return diffPayload(st, f, prev)
      },

      // [文件引用] 读指定行范围的内容（供引用 serialize 动态注入）
      async readLines(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const path = reviewKeyFromApi(st, args && args.path ? String(args.path) : '')
        if (!path) return { ok: false, error: 'no-path' }
        const start = args && args.start ? Number(args.start) : 1
        const end = args && args.end ? Number(args.end) : start
        try {
          const target = await fs.resolve(reviewDiskPath(st, path))
          const text = await fs.readText(target)
          if (typeof text !== 'string') return { ok: false, error: 'read-failed' }
          const lines = text.replace(/\r\n/g, '\n').split('\n')
          const a = Math.max(1, Math.min(start, end))
          if (a > lines.length) return { ok: false, error: 'line-range-out-of-range' }
          const b = Math.min(lines.length, Math.max(start, end))
          const content = lines.slice(a - 1, b).join('\n')
          return { ok: true, path: path, start: a, end: b, content: content }
        } catch (e) {
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
      },

      async applyHunk(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const path = reviewKeyFromApi(st, args && args.path ? String(args.path) : '')
        if (!path) return { ok: false, error: 'invalid-path' }
        const hunkId = args && args.hunkId ? String(args.hunkId) : ''
        const action = args && args.action === 'reject' ? 'reject' : 'accept'
        await scan(sid)
        const f = st.files.get(path)
        if (!f || !f.cur) return { ok: false, code: 'not-found', message: '文件不存在' }
        if (f.rev !== Number(args.rev)) return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试' }
        const baseLines = entryLines(f.base)
        const curLines = entryLines(f.cur)
        const all = computeHunks(baseLines, curLines)
        let hunk = null
        for (const h of all) if (h.id === hunkId) hunk = h
        if (hunk === null) return { ok: false, code: 'stale', message: '修订已变化，请刷新后重试' }
        f.decisions.set(hunkId, action)
        if (action === 'reject') {
          const rec = newUndoRec()
          if (!f.base || !f.base.present) {
            const snap = await snapshotForUndo(st, path, rec)
            await deleteFile(st, path)
            f.cur = { present: false, content: null, eol: false, crlf: false, version: null, size: 0, binRef: null, binSize: 0 }
            if (snap) { snap.afterVersion = null; rec.files.push(snap) }
          } else {
            const snap = await snapshotForUndo(st, path, rec)
            const merged = mergeHunks(baseLines, all, f.decisions)
            const text = joinLines(merged, f.base.eol, f.base.crlf)
            const outcome = await writeFile(st, path, text)
            f.cur = { present: true, content: text.replace(/\r\n/g, '\n'), eol: f.base.eol, crlf: f.base.crlf, version: outcome.version, size: outcome.size !== undefined ? outcome.size : text.length, binRef: null, binSize: 0 }
            if (snap) { snap.afterVersion = outcome.version; rec.files.push(snap) }
          }
          commitUndo(st, rec)
        }
        let pendingCount = 0
        for (const h of all) if (!f.decisions.has(h.id)) pendingCount++
        if (pendingCount === 0) {
          f.base = cloneEntry(f.cur)
          f.decisions.clear()
        }
        f.rev++
        saveState(st)
        return diffPayload(st, f, undefined)
      },

      // Route A whole-document save.  This endpoint intentionally accepts
      // only a clean file: pending agent hunks must be reviewed first, so a
      // user save can never silently accept or rewrite them.  `rev` is the
      // optimistic concurrency token shared with getDiff.
      async applyDocument(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const path = reviewKeyFromApi(st, args && args.path ? String(args.path) : '')
        if (!path) return { ok: false, error: 'invalid-path' }
        if (reviewTargetIsExternal(path)) return { ok: false, code: 'read-only', message: '工作区外文件仅支持浏览' }
        const raw = args && typeof args.content === 'string' ? args.content : ''
        const content = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
          return { ok: false, code: 'too-large', message: '文件过大，无法在编辑器中保存' }
        }
        // Saving one open document must not depend on an exhaustive workspace
        // walk. Large workspaces are capped at MAX_ENTRIES; a full scan can
        // legitimately omit this path. Validate only the target file, using
        // the same direct stat/read path as the review actions.
        const f = await refreshReviewTarget(st, sid, path)
        if (!f || !f.cur || !f.cur.present) return { ok: false, code: 'not-found', message: '文件不存在' }
        if (f.rev !== Number(args.rev)) return { ok: false, code: 'stale', message: '文件已在外部变化，请重新加载后再编辑' }
        if (isChanged(f)) return { ok: false, code: 'pending-review', message: '文件仍有待审修改，请先接受或拒绝后再编辑' }
        if (f.cur.content === null || f.cur.note) return { ok: false, code: 'unsupported', message: '此文件不支持文本编辑' }
        if (content === f.cur.content) return diffPayload(st, f, undefined)
        const crlf = f.cur.crlf === true
        const writeContent = crlf ? content.replace(/\n/g, '\r\n') : content
        let outcome
        try {
          outcome = await writeFile(st, path, writeContent)
        } catch (e) {
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
        f.cur = {
          present: true,
          content: content,
          eol: content.endsWith('\n'),
          crlf: crlf,
          version: outcome.version,
          size: outcome.size !== undefined ? outcome.size : Buffer.byteLength(writeContent, 'utf8'),
          note: undefined,
          binRef: null,
          binSize: 0,
          md: isMarkdownPath(path),
        }
        // A direct user edit becomes the clean baseline. Pending files never
        // reach this endpoint, so this cannot accept agent work by accident.
        f.base = cloneEntry(f.cur)
        f.decisions.clear()
        f.rev++
        saveState(st)
        return diffPayload(st, f, undefined)
      },

      // Legacy one-line endpoint retained for compatibility with older
      // clients. The Route A client no longer renders per-line editors.
      // idx addresses the CURRENT content line (0-based; idx === length
      // appends, which is how the empty-file placeholder types its first
      // line). Semantics: the edit is written to disk immediately. Context
      // lines fold the same edit into the baseline (user edits are NOT
      // counted into the diff and do not disturb pending hunks); edits to
      // agent-ADDED lines stay inside their pending hunk (still counted).
      async applyEdit(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const path = reviewKeyFromApi(st, args && args.path ? String(args.path) : '')
        if (!path) return { ok: false, error: 'invalid-path' }
        if (reviewTargetIsExternal(path)) return { ok: false, code: 'read-only', message: '工作区外文件仅支持浏览' }
        const idx = Number(args.idx)
        const text = args && typeof args.text === 'string' ? args.text.replace(/\r/g, '') : ''
        if (!Number.isInteger(idx) || idx < 0) return { ok: false, code: 'stale', message: '编辑位置无效' }
        const f = await refreshReviewTarget(st, sid, path)
        if (!f || !f.cur || !f.cur.present) return { ok: false, code: 'not-found', message: '文件不存在' }
        if (f.rev !== Number(args.rev)) return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试' }
        const baseLines = entryLines(f.base)
        const curLines = entryLines(f.cur)
        if (idx > curLines.length) return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试' }
        // Edited lines address cur lines only, so they can never be diff OLD
        // (deleted) lines — the client renders those read-only.
        const all = computeHunks(baseLines, curLines)
        let container = null
        for (const h of all) {
          if (idx >= h.newStart && idx < h.newStart + h.newLen) { container = h; break }
        }
        const nextCur = curLines.slice()
        if (idx === curLines.length) nextCur.push(text)
        else nextCur[idx] = text
        if (!container && f.base && f.base.present) {
          // Context line: fold the identical edit into the baseline at the
          // aligned index. Alignment shift = sum of (newLen - oldLen) over
          // hunks at or before this position in cur coordinates.
          let shift = 0
          for (const h of all) { if (h.newStart <= idx) shift += h.newLen - h.oldLen }
          const baseIdx = idx - shift
          if (baseIdx >= 0 && baseIdx <= baseLines.length) {
            baseLines.splice(baseIdx, baseIdx < baseLines.length ? 1 : 0, text)
            f.base = { ...cloneEntry(f.base), content: joinLines(baseLines, f.base.eol) }
          }
        }
        // container !== null: the line belongs to a hunk (pending added line,
        // or a decided-accepted line). Either way the edit updates cur only —
        // pending hunks keep counting it, decided hunks stay hidden.
        const newAll = computeHunks(baseLines, nextCur)
        // If the hunk topology changed (merged/split hunks), drop stale
        // decisions rather than misapplying them to reshaped hunks.
        const shapeOf = (h) => h.oldStart + ':' + h.oldLen + ':' + h.newStart + ':' + h.newLen
        if (all.map(shapeOf).join('|') !== newAll.map(shapeOf).join('|')) f.decisions.clear()
        const textOut = joinLines(nextCur, f.cur.eol, f.cur.crlf)
        let outcome
        try {
          outcome = await writeFile(st, path, textOut)
        } catch (e) {
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
        f.cur = { present: true, content: textOut.replace(/\r\n/g, '\n'), eol: f.cur.eol, crlf: f.cur.crlf, version: outcome.version, size: outcome.size !== undefined ? outcome.size : textOut.length }
        // changed-flag hygiene: with no pending hunks the file IS the
        // baseline now — align versions so the toolbar hides.
        const newPending = newAll.filter((h) => !f.decisions.has(h.id))
        if (newPending.length === 0 && f.base && f.base.present) {
          f.base = { ...cloneEntry(f.base), version: outcome.version, size: outcome.size !== undefined ? outcome.size : textOut.length }
        }
        f.rev++
        saveState(st)
        return diffPayload(st, f, undefined)
      },

      async acceptFile(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const path = reviewKeyFromApi(st, args && args.path ? String(args.path) : '')
        if (!path) return { ok: false, error: 'invalid-path' }
        const expectedDeletionBatchId = deletionId(st.files.get(path)?.deletion)
        const f = await refreshReviewTarget(st, sid, path)
        if (!f || !f.cur) return { ok: false, code: 'not-found', message: '文件不存在' }
        if (expectedDeletionBatchId && deletionId(f.deletion) !== expectedDeletionBatchId) {
          return { ok: false, code: 'stale', message: '文件已重新出现，请刷新后重新审核，未确认删除' }
        }
        if (f.deletion) retainDeletedPreview(st, f, path)
        try { await doAccept(st, f, path) } catch (e) {
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
        saveState(st)
        return diffPayload(st, f, undefined)
      },

      async rejectFile(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const path = reviewKeyFromApi(st, args && args.path ? String(args.path) : '')
        if (!path) return { ok: false, error: 'invalid-path' }
        const existing = st.files.get(path)
        const expectedVersion = existing && existing.cur ? existing.cur.version : undefined
        const f = await refreshReviewTarget(st, sid, path)
        if (!f || !f.cur) return { ok: false, code: 'not-found', message: '文件不存在' }
        if (expectedVersion !== undefined && expectedVersion !== f.cur.version) {
          return { ok: false, code: 'stale', message: '文件已再次变化，请刷新后重试，未覆盖新的修改' }
        }
        try {
          const rec = newUndoRec()
          await doReject(st, f, path, rec)
          f.deletedPreview = null
          commitUndo(st, rec)
          saveState(st)
          return diffPayload(st, f, undefined)
        } catch (e) {
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
      },

      async acceptDeletionBatch(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        try {
          const batch = await acceptDirectoryBatch(st, String(args.sessionId), args && args.deletionBatchId)
          saveState(st)
          return { ok: true, applied: batch.records.length, files: modifiedFiles(st) }
        } catch (error) {
          return { ok: false, code: error && error.code ? error.code : undefined, error: error && error.message ? String(error.message) : String(error) }
        }
      },

      async rejectDeletionBatch(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        try {
          const batch = await rejectDirectoryBatch(st, String(args.sessionId), args && args.deletionBatchId)
          saveState(st)
          return { ok: true, applied: batch.records.length, files: modifiedFiles(st) }
        } catch (error) {
          return { ok: false, code: error && error.code ? error.code : undefined, error: error && error.message ? String(error.message) : String(error) }
        }
      },

      async acceptAll(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        await reconcileReviewTargets(st, sid)
        if (st.error) return { ok: false, error: st.error }
        const list = modifiedFiles(st)
        const handled = new Set()
        let applied = 0
        for (const group of completeDirectoryBatchGroups(list)) {
          const batch = await acceptDirectoryBatch(st, sid, group.batchId)
          for (const record of batch.records) handled.add(record.key)
          applied += batch.records.length
        }
        for (const item of list) {
          const key = item.id || item.path
          if (handled.has(key)) continue
          const f = st.files.get(key)
          if (!f) continue
          if (f.deletion) retainDeletedPreview(st, f, key)
          await doAccept(st, f, key)
          applied++
        }
        saveState(st)
        return { ok: true, applied: applied, files: modifiedFiles(st) }
      },

      async rejectAll(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        await reconcileReviewTargets(st, sid)
        if (st.error) return { ok: false, error: st.error }
        const list = modifiedFiles(st)
        const failed = []
        const rec = newUndoRec()
        const handled = new Set()
        let applied = 0
        for (const group of completeDirectoryBatchGroups(list)) {
          for (const item of group.items) handled.add(item.id || item.path)
          try {
            const batch = await rejectDirectoryBatch(st, sid, group.batchId)
            applied += batch.records.length
          } catch (e) {
            failed.push({ path: group.root, error: e && e.message ? String(e.message) : String(e) })
          }
        }
        for (const item of list) {
          const key = item.id || item.path
          if (handled.has(key)) continue
          const f = st.files.get(key)
          if (!f) continue
          try {
            const expectedVersion = f.cur && f.cur.version
            await refreshReviewTarget(st, sid, key)
            if (expectedVersion !== (f.cur && f.cur.version)) throw new Error('文件已再次变化，请刷新后逐个处理')
            await doReject(st, f, key, rec)
            applied++
          } catch (e) {
            failed.push({ path: item.path, error: e && e.message ? String(e.message) : String(e) })
          }
        }
        commitUndo(st, rec)
        saveState(st)
        return { ok: true, applied: applied, failed: failed, files: modifiedFiles(st) }
      },

      // Undo the last reject batch: rewrite the pre-reject bytes for every
      // file in the record, unless the file changed again on disk since the
      // reject (version guard — never clobber newer agent work).
      async undoReject(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        if (!st.root) { await hydrateReviewLedger(sid); if (st.error) return { ok: false, error: st.error } }
        const rec = st.lastReject
        if (!rec) return { ok: false, code: 'no-undo', message: '没有可撤销的拒绝操作' }
        const restored = []
        const skipped = []
        for (const item of rec.files) {
          const key = typeof item.key === 'string' ? item.key : item.path
          if (!st.files.has(key) && reviewTargetIsExternal(key)) {
            skipped.push({ path: item.path, reason: 'invalid' })
            continue
          }
          const legacySegs = String(item.path || '').split('/')
          const src = item.backupName
            ? join(undoRoot(st.sid), rec.opId, item.backupName)
            : join(undoRoot(st.sid), rec.opId, ...legacySegs)
          if (!existsSync(src)) {
            skipped.push({ path: item.path, reason: '备份丢失' })
            continue
          }
          const target = await fs.resolve(reviewDiskPath(st, key))
          let info
          try { info = await fs.stat(target) } catch (e) { info = undefined }
          const expectAbsent = item.afterVersion === null || item.afterVersion === undefined
          if (expectAbsent ? !!info : (!info || info.version !== item.afterVersion)) {
            skipped.push({ path: item.path, reason: '文件已再次变化' })
            continue
          }
          try {
            const bytes = readFileSync(src)
            writeFileSync(fs.processPath(target), bytes)
            restored.push(reviewDisplayPath(st, key))
            let f = st.files.get(key)
            if (!f) {
              f = { base: absentEntry(), cur: null, rev: 0, decisions: new Map() }
              st.files.set(key, f)
            }
            f.cur = await loadFileEntry(st, key)
            if (f.decisions.size > 0) f.decisions.clear()
            f.rev++
            // Recreated file: let the sidebar tree know right away; the full
            // scan (dirty) reconciles everything else on the next poll.
            if (expectAbsent) bumpTree(st)
            st.dirty = true
          } catch (e) {
            skipped.push({ path: item.path, reason: e && e.message ? String(e.message) : String(e) })
          }
        }
        try { rmSync(join(undoRoot(st.sid), rec.opId), { recursive: true, force: true }) } catch (e) {}
        st.lastReject = null
        saveState(st)
        return { ok: true, restored: restored, skipped: skipped }
      },
    }

    // ---------- HTTP carrier ----------
    const route = webServer.register({
      kind: 'prefix',
      path: '/dsh-file-edit',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST' || req.url !== '/dsh-file-edit/api') {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'not found' }))
            return
          }
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          let body
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'bad json' }))
            return
          }
          const method = body && typeof body.method === 'string' ? body.method : ''
          const handler = api[method]
          if (typeof handler !== 'function') {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'no such method: ' + method }))
            return
          }
          const result = await handler(body.args && typeof body.args === 'object' ? body.args : {})
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result ?? { ok: true }))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: e && e.message ? String(e.message) : String(e) }))
        }
      },
    })
    ctx.effect(() => route, 'dsh-file-edit: web route')

    // Wake pending long-polls on teardown so no held request outlives the
    // plugin fiber, and drop coalescing timers.
    ctx.effect(() => () => {
      for (const [, set] of waiters) {
        for (const resolve of set) { try { resolve({ ok: true, changed: false }) } catch (e) {} }
        set.clear()
      }
      waiters.clear()
      for (const [, h] of notifyTimers) clearTimeout(h)
      notifyTimers.clear()
    }, 'dsh-file-edit: wait cleanup')

    // ---------- change triggers ----------
    ctx.on('tools/pre-execute', async (exec, next) => {
      const name = exec && exec.name ? exec.name : ''
      if (RAW_SHELL_TOOLS.has(name)) return { kind: 'deny', reason: RAW_SHELL_DENIAL }
      return next()
    })

    ctx.on('tools/execute', async (exec, next) => {
      const name = exec && exec.name ? exec.name : ''
      if (!SHELL_TOOLS.has(name)) return next()
      return captureForegroundShell(exec, next)
    })

    ctx.on('tools/result', async (exec, result) => {
      const name = exec && exec.name ? exec.name : ''
      if (!DIRECT_CONTENT_TOOLS.has(name) || (result && result.isError === true)) return
      try { await stageTextToolResult(exec, result) } catch (e) {
        console.error('[dsh-file-edit] failed to record tool result:', e && e.message ? e.message : e)
      }
    })
  },
}
