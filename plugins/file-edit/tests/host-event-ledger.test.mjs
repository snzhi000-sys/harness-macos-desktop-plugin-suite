import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, lstatSync, readdirSync, rmSync, symlinkSync, realpathSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'

const temp = mkdtempSync(join(tmpdir(), 'dsh-file-edit-ledger-'))
const stateHome = join(temp, 'state')
const workspace = join(temp, 'workspace')
mkdirSync(stateHome, { recursive: true })
mkdirSync(workspace, { recursive: true })
process.env.DSH_HOME = stateHome

const { default: plugin } = await import('../host/index.mjs?' + Date.now())

function harness(pluginImpl = plugin, sessionOverrides = {}) {
  const events = new Map()
  const registered = new Map()
  const guards = []
  const shellCalls = []
  let listCalls = 0
  let readTextCalls = 0
  let routeHandler = null
  const session = { header: { id: 'session-test', cwd: workspace } }
  const sessionRecords = new Map([['session-test', session], ...Object.entries(sessionOverrides)])
  const fs = {
    async resolve(path) { return { displayPath: path, path } },
    processPath(target) { return target.path },
    async stat(target) {
      if (!existsSync(target.path)) return undefined
      const s = statSync(target.path)
      return { size: s.size, version: `${s.mtimeMs}:${s.size}` }
    },
    async readText(target) { readTextCalls++; return readFileSync(target.path, 'utf8') },
    async readBytes(target) { return readFileSync(target.path) },
    async listDir() { listCalls++; return [] },
    async writeText(target, content) {
      const before = existsSync(target.path) ? readFileSync(target.path, 'utf8') : null
      writeFileSync(target.path, content)
      const s = statSync(target.path)
      return { before, after: content, operation: before === null ? 'create' : 'update', size: s.size, version: `${s.mtimeMs}:${s.size}` }
    },
  }
  const ctx = {
    fs,
    sandboxPolicy: { resolve: (request = {}) => ({ mode: request.mode ?? 'workspace-write', workspaceRoot: workspace, sessionId: 'session-test' }) },
    sessions: { get: id => sessionRecords.get(id) },
    shell: { sandboxMode: 'workspace-write', resolve: x => x, run: async (spec) => {
      shellCalls.push(spec)
      const remove = typeof spec.command === 'string' ? spec.command.match(/^rm -f -- '([^']+)'$/) : null
      if (remove && spec.sandboxPolicy?.mode !== 'read-only') rmSync(remove[1], { force: true })
      const denied = spec.sandboxPolicy?.mode === 'read-only' && /(?:^|\s)(?:rm|rmdir)(?:\s|$)/.test(String(spec.command))
      return {
        exitCode: denied ? 1 : 0,
        stdout: { text: denied ? '' : 'readonly-ok\n', truncated: false },
        stderr: { text: denied ? 'sandbox denied\n' : '', truncated: false },
        sandbox: { mode: spec.sandboxPolicy?.mode ?? 'workspace-write', denied },
      }
    } },
    webServer: { register(def) { routeHandler = def.handler; return () => {} } },
    tools: {
      register(def) { registered.set(def.name, def); return () => registered.delete(def.name) },
      guard(fn) { guards.push(fn); return () => guards.splice(guards.indexOf(fn), 1) },
    },
    systemPrompt: { section: () => () => {} },
    effect(fn) { return fn() },
    on(name, fn) { events.set(name, fn); return () => events.delete(name) },
  }
  pluginImpl.apply(ctx)
  const invoke = async (method, args) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ method, args }))])
    req.method = 'POST'
    req.url = '/dsh-file-edit/api'
    let body = ''
    const res = { writeHead() {}, end(value) { body = String(value || '') } }
    await routeHandler(req, res)
    return JSON.parse(body)
  }
  return {
    events, registered, guards, invoke, shellCalls,
    get listCalls() { return listCalls },
    get readTextCalls() { return readTextCalls },
  }
}

function state() {
  return JSON.parse(readFileSync(join(stateHome, 'dsh-file-edit-state', 'session-test.json'), 'utf8'))
}

test('write/edit results enter the session ledger without a workspace scan', async () => {
  const h = harness()
  const deep = join(workspace, 'beyond-8000', 'target.md')
  await h.events.get('tools/result')(
    { name: 'write', agent: { session: { id: 'session-test' } } },
    { isError: false, value: { path: deep, operation: 'create', before: null, after: '# created\n' } },
  )
  assert.equal(h.listCalls, 0)
  assert.equal(state().files['beyond-8000/target.md'].base.present, false)
  assert.equal(state().files['beyond-8000/target.md'].cur.content, '# created\n')

  await h.events.get('tools/result')(
    { name: 'edit', agent: { session: { id: 'session-test' } } },
    { isError: false, value: { path: deep, before: '# created\n', after: '# expanded\n\nbody\n' } },
  )
  assert.equal(state().files['beyond-8000/target.md'].base.present, false)
  assert.equal(state().files['beyond-8000/target.md'].cur.content, '# expanded\n\nbody\n')
})

test('subagent writes and structured deletes are reviewed by the nearest visible parent session', async () => {
  const subagent = { id: 'session-child', header: { id: 'session-child', cwd: workspace, origin: 'subagent', parentSession: 'session-test' } }
  const nested = { id: 'session-grandchild', header: { id: 'session-grandchild', cwd: workspace, origin: 'subagent', parentSession: 'session-child' } }
  const h = harness(plugin, { 'session-child': subagent, 'session-grandchild': nested })
  const written = join(workspace, 'subagent-write.md')
  writeFileSync(written, 'written by child\n')
  await h.events.get('tools/result')(
    { name: 'write', agent: { session: nested } },
    { isError: false, value: { path: written, operation: 'create', before: null, after: 'written by child\n' } },
  )
  const deleted = join(workspace, 'subagent-delete.md')
  writeFileSync(deleted, 'deleted by child\n')
  const result = await h.registered.get('file_delete').execute(
    { file_path: deleted },
    { agent: { session: subagent }, signal: new AbortController().signal },
  )
  const parentSnapshot = await h.invoke('getModifiedSnapshot', { sessionId: 'session-test' })
  assert.ok(parentSnapshot.files.some((file) => file.path === 'subagent-write.md'))
  assert.ok(parentSnapshot.files.some((file) => file.path === 'subagent-delete.md' && file.deletionBatchId === result.deletionBatchId))
  assert.equal(existsSync(join(stateHome, 'dsh-file-edit-state', 'session-child.json')), false)
  assert.equal(existsSync(join(stateHome, 'dsh-file-edit-state', 'session-grandchild.json')), false)
})

test('ordinary message-edit forks keep their own review ledger', async () => {
  const fork = { id: 'session-fork', header: { id: 'session-fork', cwd: workspace, parentSession: 'session-test' } }
  const h = harness(plugin, { 'session-fork': fork })
  const target = join(workspace, 'fork-owned.md')
  writeFileSync(target, 'fork content\n')
  await h.events.get('tools/result')(
    { name: 'write', agent: { session: fork } },
    { isError: false, value: { path: target, operation: 'create', before: null, after: 'fork content\n' } },
  )
  const parentSnapshot = await h.invoke('getModifiedSnapshot', { sessionId: 'session-test' })
  const forkSnapshot = await h.invoke('getModifiedSnapshot', { sessionId: 'session-fork' })
  assert.equal(parentSnapshot.files.some((file) => file.path === 'fork-owned.md'), false)
  assert.ok(forkSnapshot.files.some((file) => file.path === 'fork-owned.md'))
})

test('opaque shell results do not claim unrelated files', async () => {
  const h = harness()
  const before = JSON.stringify(state().files)
  await h.events.get('tools/result')(
    { name: 'bash', agent: { session: { id: 'session-test' } }, arguments: { command: 'ls' } },
    { isError: false, value: { output: '' } },
  )
  assert.equal(JSON.stringify(state().files), before)
})

test('strict gate denies every writable raw shell entry before dispatch', async () => {
  const h = harness()
  const target = join(workspace, 'strict-gate-target.md')
  writeFileSync(target, 'must remain\n')
  const attempts = [
    ['bash', { command: `rm -f '${target}'` }],
    ['bash', { command: `python3 -c "import os; os.remove('${target}')"`, run_in_background: true }],
    ['bash', { command: `node -e "require('fs').rmSync('${target}')"`, sandbox_permissions: 'danger-full-access', justification: 'delete it' }],
    ['shell', { command: `find '${workspace}' -delete` }],
    ['pwsh', { command: `Remove-Item '${target}'` }],
    ['powershell', { command: `Remove-Item '${target}'` }],
    ['shell_command', { command: `rm -f '${target}'` }],
    ['terminal_open', { type: 'shell' }],
    ['terminal_send', { sessionId: 'pty-1', text: `rm -f '${target}'` }],
  ]
  for (const [name, args] of attempts) {
    let dispatched = false
    const decision = await h.events.get('tools/pre-execute')(
      { name, arguments: args, agent: { session: { id: 'session-test' } } },
      async () => { dispatched = true; return { kind: 'allow' } },
    )
    assert.equal(decision.kind, 'deny', name)
    assert.match(decision.reason, /file_delete/)
    assert.equal(dispatched, false, name)
    assert.equal(readFileSync(target, 'utf8'), 'must remain\n', name)
  }
})

test('strict gate allows structured file tools and unrelated read tools', async () => {
  const h = harness()
  for (const name of ['write', 'edit', 'file_delete', 'file_move', 'read', 'shell_readonly']) {
    const downstream = { kind: 'allow', name }
    const decision = await h.events.get('tools/pre-execute')(
      { name, arguments: {}, agent: { session: { id: 'session-test' } } },
      async () => downstream,
    )
    assert.equal(decision, downstream)
  }
})

test('monotonic guard remains the final raw shell denial after pre-execute listeners', async () => {
  const h = harness()
  assert.equal(h.guards.length, 1)
  for (const name of ['bash', 'shell', 'pwsh', 'powershell', 'shell_command', 'terminal_open', 'terminal_send']) {
    assert.match(h.guards[0]({ name, arguments: {} }), /file_delete/, name)
  }
  for (const name of ['shell_readonly', 'write', 'edit', 'file_delete', 'file_move', 'read']) {
    assert.equal(h.guards[0]({ name, arguments: {} }), undefined, name)
  }
})

test('shell_readonly forces read-only policy and offers no escalation or background fields', async () => {
  const h = harness()
  const tool = h.registered.get('shell_readonly')
  assert.ok(tool)
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['command', 'timeout_ms', 'workdir'])
  const result = await tool.execute(
    { command: 'pwd', workdir: '.', timeout_ms: 2500 },
    { signal: { throwIfAborted() {} }, agent: { session: { id: 'session-test' } } },
  )
  assert.equal(result.ok, true)
  assert.equal(result.stdout, 'readonly-ok\n')
  assert.match(tool.output.render({}, result)[0].text, /\[exit code: 0\]$/)
  assert.equal(h.shellCalls.length, 1)
  assert.equal(h.shellCalls[0].sandboxPolicy.mode, 'read-only')
  assert.equal(h.shellCalls[0].workdir, workspace)
})

test('shell_readonly cannot delete even when the command hides deletion in a script', async () => {
  const h = harness()
  const target = join(workspace, 'readonly-delete-target.md')
  writeFileSync(target, 'safe\n')
  const result = await h.registered.get('shell_readonly').execute(
    { command: `python3 -c "import os; os.remove('${target}')"` },
    { signal: { throwIfAborted() {} }, agent: { session: { id: 'session-test' } } },
  )
  // The mock executor does not parse dynamic Python. The security assertion is
  // that the plugin supplied a read-only kernel policy, rather than trusting
  // command text classification.
  assert.equal(h.shellCalls[0].sandboxPolicy.mode, 'read-only')
  assert.equal(existsSync(target), true)
  assert.equal(result.ok, true)
})

test('foreground shell-created files enter review outside the discovery scan', async () => {
  const h = harness()
  const dir = join(workspace, 'shell-generated', 'deep')
  mkdirSync(dir, { recursive: true })
  const diskPath = join(dir, 'generated.md')
  const exec = {
    name: 'bash',
    callId: 'call-shell-create',
    // The destination is computed inside the script and is deliberately not
    // present in the command text; filesystem observation, not parsing, must
    // discover it.
    arguments: { command: 'python3 build.py' },
    agent: { session: { id: 'session-test' } },
  }
  const result = await h.events.get('tools/execute')(exec, async () => {
    writeFileSync(diskPath, '# generated by script\n')
    return { isError: false, value: { kind: 'foreground', exitCode: 0 } }
  })
  assert.equal(result.value.exitCode, 0)
  assert.equal(h.listCalls, 0)
  assert.equal(state().files['shell-generated/deep/generated.md'].base.present, false)
  assert.equal(state().files['shell-generated/deep/generated.md'].cur.content, '# generated by script\n')
  const rejected = await h.invoke('rejectFile', { sessionId: 'session-test', path: 'shell-generated/deep/generated.md' })
  assert.equal(rejected.ok, true)
  assert.equal(existsSync(diskPath), false)
})

test('foreground shell overwrites preserve an exact explicit-path before image', async () => {
  const h = harness()
  const diskPath = join(workspace, 'shell-overwrite.md')
  writeFileSync(diskPath, 'before shell\n')
  const exec = {
    name: 'bash',
    callId: 'call-shell-overwrite',
    arguments: { command: `python3 -c 'transform' \"${diskPath}\"` },
    agent: { session: { id: 'session-test' } },
  }
  await h.events.get('tools/execute')(exec, async () => {
    writeFileSync(diskPath, 'after shell\n')
    return { isError: false, value: { kind: 'foreground', exitCode: 0 } }
  })
  assert.equal(state().files['shell-overwrite.md'].base.content, 'before shell\n')
  assert.equal(state().files['shell-overwrite.md'].cur.content, 'after shell\n')
  const rejected = await h.invoke('rejectFile', { sessionId: 'session-test', path: 'shell-overwrite.md' })
  assert.equal(rejected.ok, true)
  assert.equal(readFileSync(diskPath, 'utf8'), 'before shell\n')
})

test('dynamically computed shell overwrites remain visible when before is unavailable', async () => {
  const h = harness()
  const diskPath = join(workspace, 'shell-dynamic-overwrite.md')
  writeFileSync(diskPath, 'before dynamic shell\n')
  await new Promise((resolve) => setTimeout(resolve, 40))
  const exec = {
    name: 'bash',
    callId: 'call-shell-dynamic-overwrite',
    arguments: { command: 'python3 transform_dynamic_destination.py' },
    agent: { session: { id: 'session-test' } },
  }
  await h.events.get('tools/execute')(exec, async () => {
    writeFileSync(diskPath, 'after dynamic shell\n')
    return { isError: false, value: { kind: 'foreground', exitCode: 0 } }
  })
  assert.equal(state().files['shell-dynamic-overwrite.md'].base.note, 'shell-unknown')
  assert.equal(state().files['shell-dynamic-overwrite.md'].cur.content, 'after dynamic shell\n')
})

test('shell changes are recorded even when the tool later fails', async () => {
  const h = harness()
  const diskPath = join(workspace, 'shell-before-error.md')
  const exec = {
    name: 'bash',
    callId: 'call-shell-error',
    arguments: { command: `python3 generator.py 'shell-before-error.md'` },
    agent: { session: { id: 'session-test' } },
  }
  await assert.rejects(
    h.events.get('tools/execute')(exec, async () => {
      writeFileSync(diskPath, 'written before failure\n')
      throw new Error('command failed')
    }),
    /command failed/,
  )
  assert.equal(state().files['shell-before-error.md'].base.present, false)
  assert.equal(state().files['shell-before-error.md'].cur.content, 'written before failure\n')
})

test('restart snapshot restores pending review without a workspace scan', async () => {
  const restartedPlugin = (await import('../host/index.mjs?restart-snapshot=' + Date.now())).default
  const h = harness(restartedPlugin)
  const result = await h.invoke('getModifiedSnapshot', { sessionId: 'session-test' })
  assert.equal(result.ok, true)
  assert.equal(result.restoring, true)
  assert.ok(result.files.some(file => file.path === 'beyond-8000/target.md'))
  assert.equal(h.listCalls, 0)
})

test('restart reconciliation hydrates only persisted review targets without scanning the workspace', async () => {
  const sessionId = 'session-reconcile'
  const session = { id: sessionId, header: { id: sessionId, cwd: workspace } }
  const target = join(workspace, 'startup-reconcile.md')
  writeFileSync(target, 'after restart\n')
  const seeded = harness(plugin, { [sessionId]: session })
  await seeded.events.get('tools/result')(
    { name: 'edit', agent: { session } },
    { isError: false, value: { path: target, before: 'before restart\n', after: 'after restart\n' } },
  )
  const restartedPlugin = (await import('../host/index.mjs?restart-reconcile=' + Date.now())).default
  const h = harness(restartedPlugin, { [sessionId]: session })
  const result = await h.invoke('getModified', { sessionId })
  assert.equal(result.ok, true)
  assert.ok(result.files.some(file => file.path === 'startup-reconcile.md'))
  assert.equal(h.listCalls, 0)
  assert.equal(h.readTextCalls, 0)
  const hydrated = await h.invoke('getModifiedSnapshot', { sessionId })
  assert.equal(hydrated.restoring, false)
  assert.equal(h.listCalls, 0)
  assert.equal(h.readTextCalls, 0)
})

test('a clean session becomes ready without constructing a workspace baseline', async () => {
  const clean = { id: 'session-clean', header: { id: 'session-clean', cwd: workspace } }
  const h = harness(plugin, { 'session-clean': clean })
  const result = await h.invoke('getModified', { sessionId: 'session-clean' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.files, [])
  assert.equal(h.listCalls, 0)
  const hydrated = await h.invoke('getModifiedSnapshot', { sessionId: 'session-clean' })
  assert.equal(hydrated.restoring, false)
})

test('file_delete and file_move mutate disk and record exact review entries', async () => {
  const h = harness()
  const deletePath = join(workspace, 'delete-me.txt')
  writeFileSync(deletePath, 'delete baseline\n')
  const expectedDeletePath = realpathSync(deletePath)
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  const deletion = await h.registered.get('file_delete').execute({ file_path: deletePath }, exec)
  assert.equal(existsSync(deletePath), false)
  assert.equal(state().files['delete-me.txt'].cur.present, false)
  assert.equal(state().files['delete-me.txt'].deletion.batchId, deletion.deletionBatchId)
  const quarantine = join(stateHome, 'dsh-file-edit-state', 'session-test', 'quarantine', deletion.deletionBatchId)
  assert.equal(readFileSync(join(quarantine, 'payload', 'delete-me.txt'), 'utf8'), 'delete baseline\n')
  const manifest = JSON.parse(readFileSync(join(quarantine, 'manifest.json'), 'utf8'))
  assert.equal(manifest.targetPath, expectedDeletePath)
  assert.equal(manifest.kind, 'file')
  assert.equal(manifest.entryCount, 1)
  const deletedDiff = await h.invoke('getDiff', { sessionId: 'session-test', path: 'delete-me.txt' })
  assert.equal(deletedDiff.deleted, true)
  assert.equal(deletedDiff.readOnly, true)
  assert.equal(deletedDiff.deletedPreviewSource, 'quarantine')
  assert.deepEqual(deletedDiff.deletedPreview, ['delete baseline'])
  assert.equal(deletedDiff.deletedPreviewTrailingNL, true)
  const reopenedDeletion = await h.invoke('resolveOpenTarget', {
    sessionId: 'session-test', cwd: workspace, path: 'delete-me.txt', absolutePath: deletePath,
  })
  assert.equal(reopenedDeletion.ok, true)
  assert.equal(reopenedDeletion.id, 'delete-me.txt')
  assert.equal(reopenedDeletion.deleted, true)
  assert.equal(reopenedDeletion.readOnly, true)

  const source = join(workspace, 'move-me.md')
  const destination = join(workspace, 'moved.md')
  writeFileSync(source, 'move baseline\n')
  await h.registered.get('file_move').execute({ source_path: source, destination_path: destination }, exec)
  assert.equal(existsSync(source), false)
  assert.equal(readFileSync(destination, 'utf8'), 'move baseline\n')
  const files = state().files
  assert.equal(files['move-me.md'].cur.present, false)
  assert.equal(files['moved.md'].base.present, false)
  assert.equal(files['moved.md'].cur.content, 'move baseline\n')
})

test('created-then-deleted files persist as tombstones and reject returns to added review', async () => {
  const h = harness()
  const target = join(workspace, 'created-then-deleted.md')
  const content = '# created in this task\n'
  writeFileSync(target, content)
  await h.events.get('tools/result')(
    { name: 'write', agent: { session: { id: 'session-test' } } },
    { isError: false, value: { path: target, operation: 'create', before: null, after: content } },
  )
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  const deletion = await h.registered.get('file_delete').execute({ file_path: target }, exec)
  assert.equal(existsSync(target), false)
  const quarantine = join(stateHome, 'dsh-file-edit-state', 'session-test', 'quarantine', deletion.deletionBatchId)
  assert.equal(existsSync(quarantine), true)

  const snapshot = await h.invoke('getModifiedSnapshot', { sessionId: 'session-test' })
  const tombstone = snapshot.files.find(file => file.path === 'created-then-deleted.md')
  assert.ok(tombstone)
  assert.equal(tombstone.status, 'deleted')
  assert.equal(tombstone.createdThenDeleted, true)
  assert.equal(tombstone.deletedFrom, 'created-in-session')
  assert.equal(tombstone.deletionBatchId, deletion.deletionBatchId)
  assert.equal(tombstone.deleteTarget, 'created-then-deleted.md')
  assert.match(tombstone.deletedAt, /^\d{4}-\d{2}-\d{2}T/)

  const restartedPlugin = (await import('../host/index.mjs?restart-tombstone=' + Date.now())).default
  const restarted = harness(restartedPlugin)
  const restoredSnapshot = await restarted.invoke('getModifiedSnapshot', { sessionId: 'session-test' })
  assert.ok(restoredSnapshot.files.some(file => file.path === 'created-then-deleted.md' && file.createdThenDeleted === true))
  const restoredDiff = await restarted.invoke('getDiff', { sessionId: 'session-test', path: 'created-then-deleted.md' })
  assert.equal(restoredDiff.deleted, true)
  assert.deepEqual(restoredDiff.deletedPreview, ['# created in this task'])
  assert.equal(restoredDiff.deletedPreviewSource, 'quarantine')

  const rejected = await restarted.invoke('rejectFile', { sessionId: 'session-test', path: 'created-then-deleted.md' })
  assert.equal(rejected.ok, true)
  assert.equal(rejected.status, 'added')
  assert.equal(rejected.deleted, undefined)
  assert.equal(readFileSync(target, 'utf8'), content)
  assert.equal(existsSync(quarantine), false)
  const afterReject = await restarted.invoke('getModifiedSnapshot', { sessionId: 'session-test' })
  const added = afterReject.files.find(file => file.path === 'created-then-deleted.md')
  assert.equal(added.status, 'added')
  assert.equal(added.createdThenDeleted, undefined)
})

test('accepting a created-then-deleted tombstone confirms absence and closes the change', async () => {
  const h = harness()
  const target = join(workspace, 'accept-created-delete.txt')
  writeFileSync(target, 'temporary output\n')
  await h.events.get('tools/result')(
    { name: 'write', agent: { session: { id: 'session-test' } } },
    { isError: false, value: { path: target, operation: 'create', before: null, after: 'temporary output\n' } },
  )
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  const deletion = await h.registered.get('file_delete').execute({ file_path: target }, exec)
  const quarantine = join(stateHome, 'dsh-file-edit-state', 'session-test', 'quarantine', deletion.deletionBatchId)
  const accepted = await h.invoke('acceptFile', { sessionId: 'session-test', path: 'accept-created-delete.txt' })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.changed, false)
  assert.equal(accepted.deleted, true)
  assert.deepEqual(accepted.deletedPreview, ['temporary output'])
  const reopenedAccepted = await h.invoke('resolveOpenTarget', {
    sessionId: 'session-test', cwd: workspace, path: 'accept-created-delete.txt', absolutePath: target,
  })
  assert.equal(reopenedAccepted.ok, true)
  assert.equal(reopenedAccepted.deleted, true)
  assert.equal(existsSync(target), false)
  assert.equal(existsSync(quarantine), false)
  const snapshot = await h.invoke('getModifiedSnapshot', { sessionId: 'session-test' })
  assert.equal(snapshot.files.some(file => file.path === 'accept-created-delete.txt'), false)
})

test('rejecting deletion of a modified file restores it and keeps the modification pending', async () => {
  const h = harness()
  const target = join(workspace, 'modified-then-deleted.txt')
  writeFileSync(target, 'after edit\n')
  await h.events.get('tools/result')(
    { name: 'edit', agent: { session: { id: 'session-test' } } },
    { isError: false, value: { path: target, before: 'before edit\n', after: 'after edit\n' } },
  )
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  await h.registered.get('file_delete').execute({ file_path: target }, exec)
  const tombstone = (await h.invoke('getModifiedSnapshot', { sessionId: 'session-test' })).files.find(file => file.path === 'modified-then-deleted.txt')
  assert.equal(tombstone.deletedFrom, 'modified-in-session')
  const deletedDiff = await h.invoke('getDiff', { sessionId: 'session-test', path: 'modified-then-deleted.txt' })
  assert.deepEqual(deletedDiff.deletedPreview, ['after edit'])
  assert.notDeepEqual(deletedDiff.deletedPreview, ['before edit'])
  const rejected = await h.invoke('rejectFile', { sessionId: 'session-test', path: 'modified-then-deleted.txt' })
  assert.equal(rejected.ok, true)
  assert.equal(rejected.status, 'modified')
  assert.equal(rejected.changed, true)
  assert.equal(readFileSync(target, 'utf8'), 'after edit\n')
  const pending = (await h.invoke('getModifiedSnapshot', { sessionId: 'session-test' })).files.find(file => file.path === 'modified-then-deleted.txt')
  assert.equal(pending.status, 'modified')
})

test('bulk review preserves created-then-deleted tombstone semantics', async () => {
  const h = harness()
  const restoreTarget = join(workspace, 'bulk-restore-created.txt')
  const acceptTarget = join(workspace, 'bulk-accept-created.txt')
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  for (const [target, content] of [[restoreTarget, 'restore me\n'], [acceptTarget, 'accept absence\n']]) {
    writeFileSync(target, content)
    await h.events.get('tools/result')(
      { name: 'write', agent: { session: { id: 'session-test' } } },
      { isError: false, value: { path: target, operation: 'create', before: null, after: content } },
    )
    await h.registered.get('file_delete').execute({ file_path: target }, exec)
  }

  // Resolve one tombstone individually, then verify reject-all applies the
  // remaining tombstone as "reject deletion", not "reject added file".
  await h.invoke('acceptFile', { sessionId: 'session-test', path: 'bulk-accept-created.txt' })
  const rejected = await h.invoke('rejectAll', { sessionId: 'session-test' })
  assert.ok(rejected.applied >= 1)
  assert.equal(readFileSync(restoreTarget, 'utf8'), 'restore me\n')
  assert.equal(existsSync(acceptTarget), false)
  const pending = (await h.invoke('getModifiedSnapshot', { sessionId: 'session-test' })).files.find(file => file.path === 'bulk-restore-created.txt')
  assert.equal(pending.status, 'added')
})

test('accepting a tombstone refuses to overwrite a path that reappeared', async () => {
  const h = harness()
  const target = join(workspace, 'reappeared-after-delete.txt')
  writeFileSync(target, 'agent created\n')
  await h.events.get('tools/result')(
    { name: 'write', agent: { session: { id: 'session-test' } } },
    { isError: false, value: { path: target, operation: 'create', before: null, after: 'agent created\n' } },
  )
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  await h.registered.get('file_delete').execute({ file_path: target }, exec)
  writeFileSync(target, 'recreated elsewhere\n')
  const accepted = await h.invoke('acceptFile', { sessionId: 'session-test', path: 'reappeared-after-delete.txt' })
  assert.equal(accepted.ok, false)
  assert.equal(accepted.code, 'stale')
  assert.equal(readFileSync(target, 'utf8'), 'recreated elsewhere\n')
})

test('file_delete quarantines external files with opaque review authority', async () => {
  const h = harness()
  const outside = join(temp, 'delete-external.txt')
  writeFileSync(outside, 'external delete baseline\n')
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  const result = await h.registered.get('file_delete').execute({ file_path: outside }, exec)
  assert.equal(result.path, realpathSync(temp) + '/delete-external.txt')
  assert.equal(existsSync(outside), false)
  const persisted = state()
  const record = Object.entries(persisted.files).find(([, value]) => value.deletion?.batchId === result.deletionBatchId)
  assert.ok(record)
  assert.ok(record[0].startsWith('\u001edsh-external:'))
  assert.equal(record[1].cur.present, false)
  const batch = join(stateHome, 'dsh-file-edit-state', 'session-test', 'quarantine', result.deletionBatchId)
  assert.equal(readFileSync(join(batch, 'payload', 'delete-external.txt'), 'utf8'), 'external delete baseline\n')
})

test('reject restores a quarantined file beyond the normal text baseline limit', async () => {
  const h = harness()
  const target = join(workspace, 'delete-large.txt')
  const content = 'large-delete-line\n'.repeat(40000)
  writeFileSync(target, content)
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  await h.registered.get('file_delete').execute({ file_path: target }, exec)
  assert.equal(existsSync(target), false)
  assert.equal(state().files['delete-large.txt'].base.note, 'large')
  const rejected = await h.invoke('rejectFile', { sessionId: 'session-test', path: 'delete-large.txt' })
  assert.equal(rejected.ok, true)
  assert.equal(readFileSync(target, 'utf8'), content)
})

test('file_delete recursively quarantines directories without following symlinks', async () => {
  const h = harness()
  const directory = join(workspace, 'delete-directory')
  const nested = join(directory, 'nested')
  const externalTarget = join(temp, 'symlink-target.txt')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(directory, 'root.md'), 'root file\n')
  writeFileSync(join(nested, 'child.txt'), 'child file\n')
  writeFileSync(externalTarget, 'must survive\n')
  symlinkSync(externalTarget, join(nested, 'outside-link'))
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  const result = await h.registered.get('file_delete').execute({ file_path: directory }, exec)
  assert.equal(result.kind, 'directory')
  assert.equal(result.entryCount, 5)
  assert.equal(existsSync(directory), false)
  assert.equal(readFileSync(externalTarget, 'utf8'), 'must survive\n')
  const batch = join(stateHome, 'dsh-file-edit-state', 'session-test', 'quarantine', result.deletionBatchId)
  const manifest = JSON.parse(readFileSync(join(batch, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.entries.map(entry => [entry.relativePath, entry.kind]), [
    ['.', 'directory'],
    ['nested', 'directory'],
    ['nested/child.txt', 'file'],
    ['nested/outside-link', 'symlink'],
    ['root.md', 'file'],
  ])
  assert.equal(readFileSync(join(batch, 'payload', 'delete-directory', 'nested', 'child.txt'), 'utf8'), 'child file\n')
  const files = state().files
  assert.equal(files['delete-directory/root.md'].deletion.batchId, result.deletionBatchId)
  assert.equal(files['delete-directory/nested/child.txt'].deletion.batchId, result.deletionBatchId)
  assert.equal(files['delete-directory/root.md'].deletion.deletionFileCount, 2)
})

test('rejectDeletionBatch restores the complete directory including empty folders and symlinks', async () => {
  const h = harness()
  const directory = join(workspace, 'restore-directory-batch')
  const nested = join(directory, 'nested')
  const empty = join(directory, 'empty')
  mkdirSync(nested, { recursive: true })
  mkdirSync(empty, { recursive: true })
  writeFileSync(join(directory, 'root.md'), 'root\n')
  writeFileSync(join(nested, 'child.txt'), 'child\n')
  const binary = Buffer.from([0, 255, 16, 128, 65, 0, 66])
  writeFileSync(join(nested, 'binary.bin'), binary)
  symlinkSync('../root.md', join(nested, 'root-link'))
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  const deletion = await h.registered.get('file_delete').execute({ file_path: directory }, exec)
  const restored = await h.invoke('rejectDeletionBatch', { sessionId: 'session-test', deletionBatchId: deletion.deletionBatchId })
  assert.equal(restored.ok, true)
  assert.equal(restored.applied, 3)
  assert.equal(readFileSync(join(directory, 'root.md'), 'utf8'), 'root\n')
  assert.equal(readFileSync(join(nested, 'child.txt'), 'utf8'), 'child\n')
  assert.deepEqual(readFileSync(join(nested, 'binary.bin')), binary)
  assert.equal(lstatSync(join(nested, 'root-link')).isSymbolicLink(), true)
  assert.equal(existsSync(empty), true)
  assert.equal((await h.invoke('getModifiedSnapshot', { sessionId: 'session-test' })).files.some(item => item.deletionBatchId === deletion.deletionBatchId), false)
  assert.equal(existsSync(join(stateHome, 'dsh-file-edit-state', 'session-test', 'quarantine', deletion.deletionBatchId)), false)
})

test('acceptDeletionBatch confirms every file and removes the directory quarantine', async () => {
  const h = harness()
  const directory = join(workspace, 'accept-directory-batch')
  mkdirSync(join(directory, 'nested'), { recursive: true })
  writeFileSync(join(directory, 'one.md'), 'one\n')
  writeFileSync(join(directory, 'nested', 'two.md'), 'two\n')
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  const deletion = await h.registered.get('file_delete').execute({ file_path: directory }, exec)
  const accepted = await h.invoke('acceptDeletionBatch', { sessionId: 'session-test', deletionBatchId: deletion.deletionBatchId })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.applied, 2)
  assert.equal(existsSync(directory), false)
  assert.equal(accepted.files.some(item => item.deletionBatchId === deletion.deletionBatchId), false)
  assert.equal(existsSync(join(stateHome, 'dsh-file-edit-state', 'session-test', 'quarantine', deletion.deletionBatchId)), false)
})

test('acceptAll handles a complete directory batch once and still accepts ordinary files', async () => {
  const h = harness()
  const ordinary = join(workspace, 'accept-all-ordinary.md')
  writeFileSync(ordinary, 'after\n')
  await h.events.get('tools/result')(
    { name: 'edit', agent: { session: { id: 'session-test' } } },
    { isError: false, value: { path: ordinary, before: 'before\n', after: 'after\n' } },
  )
  const directory = join(workspace, 'accept-all-directory')
  mkdirSync(join(directory, 'empty'), { recursive: true })
  writeFileSync(join(directory, 'one.md'), 'one\n')
  writeFileSync(join(directory, 'two.md'), 'two\n')
  symlinkSync('one.md', join(directory, 'one-link'))
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  const deletion = await h.registered.get('file_delete').execute({ file_path: directory }, exec)
  const before = await h.invoke('getModifiedSnapshot', { sessionId: 'session-test' })
  const accepted = await h.invoke('acceptAll', { sessionId: 'session-test' })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.applied, before.files.length)
  assert.equal(existsSync(directory), false)
  assert.equal(accepted.files.length, 0)
  assert.equal(existsSync(join(stateHome, 'dsh-file-edit-state', 'session-test', 'quarantine', deletion.deletionBatchId)), false)
})

test('rejectAll restores complete directory payloads and ordinary files together', async () => {
  const h = harness()
  const ordinary = join(workspace, 'reject-all-ordinary.md')
  writeFileSync(ordinary, 'after\n')
  await h.events.get('tools/result')(
    { name: 'edit', agent: { session: { id: 'session-test' } } },
    { isError: false, value: { path: ordinary, before: 'before\n', after: 'after\n' } },
  )
  const directory = join(workspace, 'reject-all-directory')
  mkdirSync(join(directory, 'empty'), { recursive: true })
  writeFileSync(join(directory, 'one.md'), 'one\n')
  writeFileSync(join(directory, 'two.md'), 'two\n')
  symlinkSync('one.md', join(directory, 'one-link'))
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  const deletion = await h.registered.get('file_delete').execute({ file_path: directory }, exec)
  const rejected = await h.invoke('rejectAll', { sessionId: 'session-test' })
  assert.equal(rejected.ok, true)
  assert.equal(rejected.applied, 3)
  assert.deepEqual(rejected.failed, [])
  assert.equal(readFileSync(ordinary, 'utf8'), 'before\n')
  assert.equal(readFileSync(join(directory, 'one.md'), 'utf8'), 'one\n')
  assert.equal(readFileSync(join(directory, 'two.md'), 'utf8'), 'two\n')
  assert.equal(existsSync(join(directory, 'empty')), true)
  assert.equal(lstatSync(join(directory, 'one-link')).isSymbolicLink(), true)
  assert.equal(existsSync(join(stateHome, 'dsh-file-edit-state', 'session-test', 'quarantine', deletion.deletionBatchId)), false)
})

test('rejectAll falls back to remaining files for a partial directory batch', async () => {
  const h = harness()
  const directory = join(workspace, 'reject-all-partial-directory')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'accepted.md'), 'accepted absence\n')
  writeFileSync(join(directory, 'restore.md'), 'restore me\n')
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  const deletion = await h.registered.get('file_delete').execute({ file_path: directory }, exec)
  await h.invoke('acceptFile', { sessionId: 'session-test', path: 'reject-all-partial-directory/accepted.md' })
  const rejected = await h.invoke('rejectAll', { sessionId: 'session-test' })
  assert.equal(rejected.ok, true)
  assert.equal(existsSync(join(directory, 'accepted.md')), false)
  assert.equal(readFileSync(join(directory, 'restore.md'), 'utf8'), 'restore me\n')
  assert.equal(existsSync(join(stateHome, 'dsh-file-edit-state', 'session-test', 'quarantine', deletion.deletionBatchId)), true)
})

test('directory batch actions fail closed after one child was reviewed separately', async () => {
  const h = harness()
  const directory = join(workspace, 'partial-directory-batch')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'one.md'), 'one\n')
  writeFileSync(join(directory, 'two.md'), 'two\n')
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  const deletion = await h.registered.get('file_delete').execute({ file_path: directory }, exec)
  await h.invoke('acceptFile', { sessionId: 'session-test', path: 'partial-directory-batch/one.md' })
  const rejected = await h.invoke('rejectDeletionBatch', { sessionId: 'session-test', deletionBatchId: deletion.deletionBatchId })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'batch-partial')
  assert.equal(existsSync(directory), false)
  assert.equal(existsSync(join(stateHome, 'dsh-file-edit-state', 'session-test', 'quarantine', deletion.deletionBatchId)), true)
})

test('directory reject returns stale and preserves quarantine when the original path reappears', async () => {
  const h = harness()
  const directory = join(workspace, 'stale-directory-batch')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'original.md'), 'original\n')
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  const deletion = await h.registered.get('file_delete').execute({ file_path: directory }, exec)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'intruder.md'), 'new owner\n')
  const rejected = await h.invoke('rejectDeletionBatch', { sessionId: 'session-test', deletionBatchId: deletion.deletionBatchId })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'stale')
  assert.equal(readFileSync(join(directory, 'intruder.md'), 'utf8'), 'new owner\n')
  assert.equal(existsSync(join(directory, 'original.md')), false)
  assert.equal(existsSync(join(stateHome, 'dsh-file-edit-state', 'session-test', 'quarantine', deletion.deletionBatchId)), true)
})

test('file_delete recursively records files from an external directory', async () => {
  const h = harness()
  const directory = join(temp, 'delete-external-directory')
  mkdirSync(join(directory, 'nested'), { recursive: true })
  writeFileSync(join(directory, 'one.md'), 'one\n')
  writeFileSync(join(directory, 'nested', 'two.md'), 'two\n')
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  const result = await h.registered.get('file_delete').execute({ file_path: directory }, exec)
  assert.equal(existsSync(directory), false)
  const records = Object.entries(state().files).filter(([, value]) => value.deletion?.batchId === result.deletionBatchId)
  assert.equal(records.length, 2)
  assert.ok(records.every(([key]) => key.startsWith('\u001edsh-external:')))
  const batch = join(stateHome, 'dsh-file-edit-state', 'session-test', 'quarantine', result.deletionBatchId)
  assert.equal(readFileSync(join(batch, 'payload', 'delete-external-directory', 'nested', 'two.md'), 'utf8'), 'two\n')
  const restartedPlugin = (await import('../host/index.mjs?restart-delete-batch=' + Date.now())).default
  const restarted = harness(restartedPlugin)
  const snapshot = await restarted.invoke('getModifiedSnapshot', { sessionId: 'session-test' })
  const batchFiles = snapshot.files.filter(file => file.deletionBatchId === result.deletionBatchId)
  assert.equal(batchFiles.length, 2)
  assert.ok(batchFiles.every(file => file.external === true && file.deletionFileCount === 2))
  assert.ok(batchFiles.every(file => file.deletionRoot === realpathSync(dirname(directory)) + '/delete-external-directory'))
  const nestedReview = batchFiles.find(file => file.path.endsWith('/nested/two.md'))
  const nestedDiff = await restarted.invoke('getDiff', { sessionId: 'session-test', path: nestedReview.id })
  assert.deepEqual(nestedDiff.deletedPreview, ['two'])
  assert.equal(nestedDiff.deletedPreviewSource, 'quarantine')
  const reopenedNested = await restarted.invoke('resolveOpenTarget', {
    sessionId: 'session-test', cwd: workspace, path: join(directory, 'nested', 'two.md'), absolutePath: join(directory, 'nested', 'two.md'),
  })
  assert.equal(reopenedNested.ok, true)
  assert.equal(reopenedNested.id, nestedReview.id)
  assert.equal(reopenedNested.deleted, true)
  const restored = await restarted.invoke('rejectDeletionBatch', { sessionId: 'session-test', deletionBatchId: result.deletionBatchId })
  assert.equal(restored.ok, true)
  assert.equal(readFileSync(join(directory, 'one.md'), 'utf8'), 'one\n')
  assert.equal(readFileSync(join(directory, 'nested', 'two.md'), 'utf8'), 'two\n')
})

test('an externally deleted open file keeps a non-reviewable in-memory preview', async () => {
  const h = harness()
  const target = join(workspace, 'externally-deleted-open.txt')
  writeFileSync(target, 'visible before external delete\n')
  const opened = await h.invoke('getDiff', { sessionId: 'session-test', path: 'externally-deleted-open.txt' })
  assert.equal(opened.deleted, undefined)
  rmSync(target)

  const deleted = await h.invoke('getDiff', { sessionId: 'session-test', path: 'externally-deleted-open.txt' })
  assert.equal(deleted.deleted, true)
  assert.equal(deleted.changed, false)
  assert.equal(deleted.deletedPreviewSource, 'open-snapshot')
  assert.deepEqual(deleted.deletedPreview, ['visible before external delete'])
  const modified = await h.invoke('getModified', { sessionId: 'session-test' })
  assert.equal(modified.files.some(file => file.path === 'externally-deleted-open.txt'), false)
})

test('deleted previews fail closed for binary and missing quarantine content', async () => {
  const h = harness()
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  const binary = join(workspace, 'deleted-preview-binary.bin')
  writeFileSync(binary, Buffer.from([0, 255, 1, 2]))
  await h.registered.get('file_delete').execute({ file_path: binary }, exec)
  const binaryDiff = await h.invoke('getDiff', { sessionId: 'session-test', path: 'deleted-preview-binary.bin' })
  assert.equal(binaryDiff.deletedPreview, null)
  assert.equal(binaryDiff.deletedPreviewNote, 'binary')

  const missing = join(workspace, 'deleted-preview-missing.txt')
  writeFileSync(missing, 'quarantine will disappear\n')
  const deletion = await h.registered.get('file_delete').execute({ file_path: missing }, exec)
  rmSync(join(stateHome, 'dsh-file-edit-state', 'session-test', 'quarantine', deletion.deletionBatchId), { recursive: true, force: true })
  const missingDiff = await h.invoke('getDiff', { sessionId: 'session-test', path: 'deleted-preview-missing.txt' })
  assert.equal(missingDiff.deletedPreview, null)
  assert.equal(missingDiff.deletedPreviewNote, 'unavailable')
})

test('file_delete leaves the original intact when quarantine cannot be created', async () => {
  const h = harness()
  const target = join(workspace, 'delete-backup-failure.txt')
  writeFileSync(target, 'must remain\n')
  const quarantine = join(stateHome, 'dsh-file-edit-state', 'session-test', 'quarantine')
  const savedQuarantine = quarantine + '-saved'
  renameSync(quarantine, savedQuarantine)
  writeFileSync(quarantine, 'block quarantine directory creation')
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  try {
    await assert.rejects(h.registered.get('file_delete').execute({ file_path: target }, exec))
    assert.equal(readFileSync(target, 'utf8'), 'must remain\n')
  } finally {
    rmSync(quarantine, { force: true })
    renameSync(savedQuarantine, quarantine)
  }
})

test('file_delete refuses an over-depth directory before moving any content', async () => {
  const h = harness()
  const directory = join(workspace, 'delete-too-deep')
  let cursor = directory
  mkdirSync(cursor, { recursive: true })
  for (let depth = 0; depth < 65; depth++) {
    cursor = join(cursor, 'd' + depth)
    mkdirSync(cursor)
  }
  const leaf = join(cursor, 'leaf.txt')
  writeFileSync(leaf, 'must remain\n')
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  await assert.rejects(h.registered.get('file_delete').execute({ file_path: directory }, exec), /安全深度限制/)
  assert.equal(readFileSync(leaf, 'utf8'), 'must remain\n')
})

test('file_delete rejects broad and symbolic-link targets before mutation', async () => {
  const h = harness()
  const target = join(workspace, 'delete-link-target.txt')
  const link = join(workspace, 'delete-link.txt')
  writeFileSync(target, 'keep target\n')
  symlinkSync(target, link)
  const exec = { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
  await assert.rejects(h.registered.get('file_delete').execute({ file_path: link }, exec), /不能是符号链接/)
  await assert.rejects(h.registered.get('file_delete').execute({ file_path: workspace }, exec), /工作区根目录/)
  assert.equal(readFileSync(target, 'utf8'), 'keep target\n')
  assert.equal(existsSync(link), true)
})

test('external write update is listed by absolute display path and reject restores it', async () => {
  const h = harness()
  const outside = join(temp, 'outside-update.txt')
  writeFileSync(outside, 'after external\n')
  await h.events.get('tools/result')(
    { name: 'write', agent: { session: { id: 'session-test' } } },
    { isError: false, value: { path: outside, operation: 'update', before: 'before external\n', after: 'after external\n' } },
  )
  const snapshot = await h.invoke('getModifiedSnapshot', { sessionId: 'session-test' })
  const item = snapshot.files.find(file => file.path === realpathSync(outside))
  assert.ok(item)
  assert.equal(item.external, true)
  assert.notEqual(item.id, outside)
  assert.equal((await h.invoke('getDiff', { sessionId: 'session-test', path: outside })).error, 'invalid-path')
  const rejected = await h.invoke('rejectFile', { sessionId: 'session-test', path: item.id })
  assert.equal(rejected.ok, true)
  assert.equal(readFileSync(outside, 'utf8'), 'before external\n')
})

test('external create can be rejected without granting arbitrary absolute-path access', async () => {
  const h = harness()
  const outside = join(temp, 'outside-created.txt')
  writeFileSync(outside, 'created externally\n')
  await h.events.get('tools/result')(
    { name: 'write', agent: { session: { id: 'session-test' } } },
    { isError: false, value: { path: outside, operation: 'create', before: null, after: 'created externally\n' } },
  )
  const snapshot = await h.invoke('getModifiedSnapshot', { sessionId: 'session-test' })
  const item = snapshot.files.find(file => file.path === realpathSync(outside))
  assert.equal(item.status, 'added')
  assert.equal((await h.invoke('rejectFile', { sessionId: 'session-test', path: item.id })).ok, true)
  assert.equal(existsSync(outside), false)
})

test('external regular files can be resolved for read-only browsing without granting edit access', async () => {
  const h = harness()
  const outside = join(temp, 'outside-browse.md')
  writeFileSync(outside, '# external artifact\n\nread only\n')

  const opened = await h.invoke('resolveOpenTarget', {
    sessionId: 'session-test', cwd: workspace, absolutePath: outside, path: outside,
  })
  assert.equal(opened.ok, true)
  assert.equal(opened.external, true)
  assert.equal(opened.readOnly, true)
  assert.equal(opened.kind, 'text')
  assert.equal(opened.path, realpathSync(outside))
  assert.notEqual(opened.id, outside)

  const diff = await h.invoke('getDiff', { sessionId: 'session-test', path: opened.id })
  assert.equal(diff.ok, true)
  assert.equal(diff.changed, false)
  assert.equal(diff.readOnly, true)
  assert.deepEqual(diff.current, ['# external artifact', '', 'read only'])

  const documentEdit = await h.invoke('applyDocument', {
    sessionId: 'session-test', path: opened.id, rev: diff.rev, content: 'must not write\n',
  })
  assert.equal(documentEdit.code, 'read-only')
  const lineEdit = await h.invoke('applyEdit', {
    sessionId: 'session-test', path: opened.id, rev: diff.rev, idx: 0, text: 'must not write',
  })
  assert.equal(lineEdit.code, 'read-only')
  assert.equal(readFileSync(outside, 'utf8'), '# external artifact\n\nread only\n')
})

test('open target rejects directories and keeps workspace files editable', async () => {
  const h = harness()
  const directory = join(temp, 'outside-directory')
  mkdirSync(directory, { recursive: true })
  assert.equal((await h.invoke('resolveOpenTarget', {
    sessionId: 'session-test', absolutePath: directory,
  })).error, 'not-a-file')

  const inside = join(workspace, 'ordinary-open.txt')
  writeFileSync(inside, 'inside\n')
  const opened = await h.invoke('resolveOpenTarget', {
    sessionId: 'session-test', absolutePath: inside,
  })
  assert.equal(opened.ok, true)
  assert.equal(opened.id, 'ordinary-open.txt')
  assert.equal(opened.external, false)
  assert.equal(opened.readOnly, false)
  const diff = await h.invoke('getDiff', { sessionId: 'session-test', path: opened.id })
  const edited = await h.invoke('applyDocument', {
    sessionId: 'session-test', path: opened.id, rev: diff.rev, content: 'edited inside\n',
  })
  assert.equal(edited.ok, true)
  assert.equal(readFileSync(inside, 'utf8'), 'edited inside\n')
})

test('unknown before-image for an external overwrite is never mislabeled as added or rejectable', async () => {
  const h = harness()
  const outside = join(temp, 'outside-unknown-before.txt')
  writeFileSync(outside, 'opaque overwrite\n')
  await h.events.get('tools/result')(
    { name: 'write', agent: { session: { id: 'session-test' } } },
    { isError: false, value: { path: outside, operation: 'update', before: null, after: 'opaque overwrite\n' } },
  )
  const snapshot = await h.invoke('getModifiedSnapshot', { sessionId: 'session-test' })
  const item = snapshot.files.find(file => file.path === realpathSync(outside))
  assert.equal(item.status, 'modified')
  assert.equal(item.note, 'write-before-unknown')
  assert.equal(item.restorable, false)
  await h.invoke('acceptFile', { sessionId: 'session-test', path: item.id })
})

test('external pending entries survive host restart and stale reject never overwrites later changes', async () => {
  const h = harness()
  const outside = join(temp, 'outside-persisted.txt')
  writeFileSync(outside, 'ai version\n')
  await h.events.get('tools/result')(
    { name: 'edit', agent: { session: { id: 'session-test' } } },
    { isError: false, value: { path: outside, before: 'original\n', after: 'ai version\n' } },
  )
  const restartedPlugin = (await import('../host/index.mjs?external-restart=' + Date.now())).default
  const restarted = harness(restartedPlugin)
  const snapshot = await restarted.invoke('getModifiedSnapshot', { sessionId: 'session-test' })
  const item = snapshot.files.find(file => file.path === realpathSync(outside))
  assert.ok(item)
  await new Promise(resolve => setTimeout(resolve, 20))
  writeFileSync(outside, 'later version\n')
  const rejected = await restarted.invoke('rejectFile', { sessionId: 'session-test', path: item.id })
  assert.equal(rejected.code, 'stale')
  assert.equal(readFileSync(outside, 'utf8'), 'later version\n')
  await restarted.invoke('acceptFile', { sessionId: 'session-test', path: item.id })
})

test('foreground shell captures an explicitly named external target without scanning outside directories', async () => {
  const h = harness()
  const outside = join(temp, 'outside-shell.txt')
  writeFileSync(outside, 'before shell outside\n')
  const exec = {
    name: 'bash', callId: 'call-shell-outside',
    arguments: { command: `python3 transform.py "${outside}"` },
    agent: { session: { id: 'session-test' } },
  }
  await h.events.get('tools/execute')(exec, async () => {
    writeFileSync(outside, 'after shell outside\n')
    return { isError: false, value: { kind: 'foreground', exitCode: 0 } }
  })
  const snapshot = await h.invoke('getModifiedSnapshot', { sessionId: 'session-test' })
  const item = snapshot.files.find(file => file.path === realpathSync(outside))
  assert.ok(item)
  assert.equal(item.external, true)
  assert.equal((await h.invoke('rejectFile', { sessionId: 'session-test', path: item.id })).ok, true)
  assert.equal(readFileSync(outside, 'utf8'), 'before shell outside\n')
})

test('workspace symlink escape is canonicalized as an external review target', async () => {
  const h = harness()
  const outside = join(temp, 'outside-symlink-target.txt')
  const link = join(workspace, 'linked-outside.txt')
  writeFileSync(outside, 'after symlink edit\n')
  try { symlinkSync(outside, link) } catch (e) { return }
  await h.events.get('tools/result')(
    { name: 'edit', agent: { session: { id: 'session-test' } } },
    { isError: false, value: { path: link, before: 'before symlink edit\n', after: 'after symlink edit\n' } },
  )
  const snapshot = await h.invoke('getModifiedSnapshot', { sessionId: 'session-test' })
  const item = snapshot.files.find(file => file.path === realpathSync(outside))
  assert.ok(item)
  assert.equal(item.external, true)
  assert.equal((await h.invoke('rejectFile', { sessionId: 'session-test', path: item.id })).ok, true)
  assert.equal(readFileSync(outside, 'utf8'), 'before symlink edit\n')
})
