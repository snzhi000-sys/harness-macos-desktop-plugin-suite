import test from 'node:test'
import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createShellSnapshotTransactions } from '../host/shell-snapshot-transaction.mjs'

function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `dsh-shell-snapshot-${name}-`))
  const workspace = join(root, 'workspace')
  const stateRoot = join(root, 'state')
  mkdirSync(workspace)
  mkdirSync(stateRoot)
  return { root, workspace, stateRoot }
}

function manager(stateRoot, options = {}) {
  let sequence = 0
  return createShellSnapshotTransactions({
    stateRoot,
    idFactory: () => `tx-${++sequence}`,
    ...options,
    limits: { settleMs: 0, ...(options.limits || {}) },
  })
}

function cloneError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function transactionEntries(stateRoot) {
  const root = join(stateRoot, 'shell-transactions')
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((session) => readdirSync(join(root, session)))
}

function allocatedBytes(path) {
  const info = lstatSync(path)
  let total = Number(info.blocks) * 512
  if (info.isDirectory()) for (const name of readdirSync(path)) total += allocatedBytes(join(path, name))
  return total
}

test('APFS COW snapshots are verified and enter the ready state', () => {
  const { workspace, stateRoot } = fixture('cow')
  const source = join(workspace, 'document.md')
  writeFileSync(source, 'before\n')
  let clones = 0
  let copies = 0
  const snapshots = manager(stateRoot, {
    cloneFile(from, to) { clones++; copyFileSync(from, to) },
    copyFile(from, to) { copies++; copyFileSync(from, to) },
  })
  const transaction = snapshots.begin({ sessionId: 'session-cow', roots: [workspace] })
  const manifest = snapshots.manifestOf(transaction)
  assert.equal(manifest.state, 'ready')
  assert.equal(manifest.entries.find((entry) => entry.relativePath === 'document.md').snapshotMethod, 'cow')
  assert.equal(readFileSync(join(transaction.path, 'payload/root-0000/document.md'), 'utf8'), 'before\n')
  assert.equal(clones, 1)
  assert.equal(copies, 0)
  snapshots.discard(transaction)
})

test('the real macOS adapter creates an APFS COW payload', { skip: process.platform !== 'darwin' }, () => {
  const { workspace, stateRoot } = fixture('real-cow')
  writeFileSync(join(workspace, 'native.txt'), 'native clone')
  const snapshots = manager(stateRoot)
  const transaction = snapshots.begin({ sessionId: 'session-real-cow', roots: [workspace] })
  const file = snapshots.manifestOf(transaction).entries.find((entry) => entry.kind === 'file')
  assert.equal(file.snapshotMethod, 'cow')
  snapshots.discard(transaction)
})

test('snapshot roots must be absolute and non-overlapping', () => {
  const { workspace, stateRoot } = fixture('roots')
  const nested = join(workspace, 'nested')
  mkdirSync(nested)
  const snapshots = manager(stateRoot)
  assert.throws(() => snapshots.begin({ sessionId: 'session-roots', roots: ['relative'] }), (error) => error.code === 'snapshot-root-relative')
  assert.throws(() => snapshots.begin({ sessionId: 'session-roots', roots: [workspace, nested] }), (error) => error.code === 'snapshot-roots-overlap')
  assert.throws(() => snapshots.begin({ sessionId: 'session-roots', roots: [stateRoot] }), (error) => error.code === 'snapshot-state-overlap')
  assert.deepEqual(transactionEntries(stateRoot), [])
})

test('transaction cleanup cannot target a path outside snapshot state', () => {
  const { root, stateRoot } = fixture('authority')
  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'keep'), 'safe')
  const snapshots = manager(stateRoot)
  assert.throws(
    () => snapshots.discard({ id: 'outside', path: outside, manifestPath: join(outside, 'manifest.json') }),
    (error) => error.code === 'snapshot-transaction-authority',
  )
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'safe')
})

test('unsupported COW and cross-volume EXDEV use the bounded copy fallback', () => {
  for (const code of ['ENOTSUP', 'EXDEV']) {
    const { workspace, stateRoot } = fixture(`fallback-${code}`)
    writeFileSync(join(workspace, 'data.txt'), 'fallback\n')
    let copies = 0
    const snapshots = manager(stateRoot, {
      cloneFile() { throw cloneError(code) },
      copyFile(from, to) { copies++; copyFileSync(from, to) },
      availableBytes: () => 1024 * 1024 * 1024,
      limits: { reserveBytes: 0 },
    })
    const transaction = snapshots.begin({ sessionId: `session-${code}`, roots: [workspace] })
    const file = snapshots.manifestOf(transaction).entries.find((entry) => entry.kind === 'file')
    assert.equal(file.snapshotMethod, 'copy')
    assert.equal(copies, 1)
    snapshots.discard(transaction)
  }
})

test('insufficient fallback space fails before the command starts and leaves no transaction', async () => {
  const { workspace, stateRoot } = fixture('disk-full')
  writeFileSync(join(workspace, 'large.bin'), Buffer.alloc(128))
  let executed = false
  const snapshots = manager(stateRoot, {
    cloneFile() { throw cloneError('EXDEV') },
    availableBytes: () => 127,
    limits: { reserveBytes: 0 },
  })
  await assert.rejects(
    snapshots.run({ sessionId: 'session-full', roots: [workspace] }, async () => { executed = true }),
    (error) => error.code === 'snapshot-disk-full',
  )
  assert.equal(executed, false)
  assert.deepEqual(transactionEntries(stateRoot), [])
})

test('recursive COW fallback checks aggregate free space before copying any file', async () => {
  const { workspace, stateRoot } = fixture('tree-disk-full')
  writeFileSync(join(workspace, 'one.bin'), Buffer.alloc(80))
  writeFileSync(join(workspace, 'two.bin'), Buffer.alloc(80))
  let copies = 0
  let executed = false
  const snapshots = manager(stateRoot, {
    cloneTree() { throw cloneError('ENOTSUP') },
    cloneFile() { throw cloneError('ENOTSUP') },
    copyFile(from, to) { copies++; copyFileSync(from, to) },
    availableBytes: () => 159,
    limits: { reserveBytes: 0 },
  })
  await assert.rejects(
    snapshots.run({ sessionId: 'session-tree-full', roots: [workspace] }, async () => { executed = true }),
    (error) => error.code === 'snapshot-disk-full',
  )
  assert.equal(executed, false)
  assert.equal(copies, 0)
  assert.deepEqual(transactionEntries(stateRoot), [])
})

test('unreadable input fails before command dispatch', async () => {
  const { workspace, stateRoot } = fixture('unreadable')
  const blocked = join(workspace, 'blocked.txt')
  writeFileSync(blocked, 'secret')
  let executed = false
  const snapshots = manager(stateRoot, {
    hashFile(path) {
      if (path === blocked) throw cloneError('EACCES')
      return 'unused'
    },
  })
  await assert.rejects(
    snapshots.run({ sessionId: 'session-unreadable', roots: [workspace] }, async () => { executed = true }),
    (error) => error.code === 'snapshot-unreadable',
  )
  assert.equal(executed, false)
  assert.deepEqual(transactionEntries(stateRoot), [])
})

test('entry, byte, and depth limits reject broad snapshots before execution', async () => {
  const scenarios = [
    {
      name: 'entries',
      prepare(workspace) {
        writeFileSync(join(workspace, 'one'), '1')
        writeFileSync(join(workspace, 'two'), '2')
      },
      limits: { maxEntries: 2 },
      code: 'snapshot-entry-limit',
    },
    {
      name: 'bytes',
      prepare(workspace) { writeFileSync(join(workspace, 'large'), '1234') },
      limits: { maxBytes: 3 },
      code: 'snapshot-byte-limit',
    },
    {
      name: 'depth',
      prepare(workspace) {
        mkdirSync(join(workspace, 'a', 'b'), { recursive: true })
        writeFileSync(join(workspace, 'a', 'b', 'deep'), 'x')
      },
      limits: { maxDepth: 1 },
      code: 'snapshot-depth-limit',
    },
  ]
  for (const scenario of scenarios) {
    const { workspace, stateRoot } = fixture(scenario.name)
    scenario.prepare(workspace)
    let executed = false
    const snapshots = manager(stateRoot, { limits: scenario.limits })
    await assert.rejects(
      snapshots.run({ sessionId: `session-${scenario.name}`, roots: [workspace] }, async () => { executed = true }),
      (error) => error.code === scenario.code,
    )
    assert.equal(executed, false)
    assert.deepEqual(transactionEntries(stateRoot), [])
  }
})

test('symlinks are captured as links without traversing their targets', () => {
  const { root, workspace, stateRoot } = fixture('symlink')
  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'must-not-copy.txt'), 'outside')
  const link = join(workspace, 'outside-link')
  const relativeTarget = '../outside'
  symlinkSync(relativeTarget, link)
  const snapshots = manager(stateRoot)
  const transaction = snapshots.begin({ sessionId: 'session-symlink', roots: [workspace] })
  const entries = snapshots.manifestOf(transaction).entries
  assert.deepEqual(entries.map((entry) => [entry.relativePath, entry.kind]), [['', 'directory'], ['outside-link', 'symlink']])
  const copiedLink = join(transaction.path, 'payload/root-0000/outside-link')
  assert.equal(lstatSync(copiedLink).isSymbolicLink(), true)
  assert.equal(readlinkSync(copiedLink), relativeTarget)
  assert.equal(existsSync(join(transaction.path, 'payload/root-0000/outside-link/must-not-copy.txt')), false)
  assert.equal(entries.some((entry) => entry.relativePath.includes('must-not-copy')), false)
  snapshots.discard(transaction)
})

test('hard-linked files fail conservatively before execution', async () => {
  const { workspace, stateRoot } = fixture('hardlink')
  const first = join(workspace, 'first.txt')
  writeFileSync(first, 'linked')
  linkSync(first, join(workspace, 'second.txt'))
  let executed = false
  const snapshots = manager(stateRoot)
  await assert.rejects(
    snapshots.run({ sessionId: 'session-hardlink', roots: [workspace] }, async () => { executed = true }),
    (error) => error.code === 'snapshot-hard-link',
  )
  assert.equal(executed, false)
  assert.deepEqual(transactionEntries(stateRoot), [])
})

test('an unwritable state target fails before command dispatch', async () => {
  const { root, workspace } = fixture('state-unwritable')
  const stateFile = join(root, 'not-a-directory')
  writeFileSync(stateFile, 'occupied')
  writeFileSync(join(workspace, 'data'), 'x')
  let executed = false
  const snapshots = manager(stateFile)
  await assert.rejects(
    snapshots.run({ sessionId: 'session-state', roots: [workspace] }, async () => { executed = true }),
    (error) => error.code === 'snapshot-create-failed',
  )
  assert.equal(executed, false)
})

test('mid-copy failure rolls back every partial snapshot', async () => {
  const { workspace, stateRoot } = fixture('partial')
  writeFileSync(join(workspace, 'one.txt'), 'one')
  writeFileSync(join(workspace, 'two.txt'), 'two')
  let copied = 0
  let executed = false
  const snapshots = manager(stateRoot, {
    cloneFile() { throw cloneError('ENOTSUP') },
    availableBytes: () => 1024 * 1024,
    limits: { reserveBytes: 0 },
    copyFile(from, to) {
      copied++
      if (copied === 2) throw cloneError('EIO')
      copyFileSync(from, to)
    },
  })
  await assert.rejects(
    snapshots.run({ sessionId: 'session-partial', roots: [workspace] }, async () => { executed = true }),
    (error) => error.code === 'snapshot-create-failed',
  )
  assert.equal(executed, false)
  assert.deepEqual(transactionEntries(stateRoot), [])
})

test('snapshot integrity mismatch rolls back instead of marking ready', () => {
  const { workspace, stateRoot } = fixture('integrity')
  writeFileSync(join(workspace, 'source.txt'), 'correct')
  const snapshots = manager(stateRoot, {
    cloneFile(_from, to) { writeFileSync(to, 'corrupt') },
  })
  assert.throws(
    () => snapshots.begin({ sessionId: 'session-integrity', roots: [workspace] }),
    (error) => error.code === 'snapshot-integrity',
  )
  assert.deepEqual(transactionEntries(stateRoot), [])
})

test('a source change during snapshot creation fails before command dispatch', async () => {
  const { workspace, stateRoot } = fixture('source-race')
  const source = join(workspace, 'source.txt')
  writeFileSync(source, 'before')
  let executed = false
  const snapshots = manager(stateRoot, {
    cloneFile(from, to) {
      copyFileSync(from, to)
      writeFileSync(from, 'changed concurrently')
    },
  })
  await assert.rejects(
    snapshots.run({ sessionId: 'session-source-race', roots: [workspace] }, async () => { executed = true }),
    (error) => error.code === 'snapshot-source-changed',
  )
  assert.equal(executed, false)
  assert.deepEqual(transactionEntries(stateRoot), [])
})

test('unchanged execution discards the snapshot while changed execution retains it as captured', async () => {
  const { workspace, stateRoot } = fixture('finalize')
  const target = join(workspace, 'document.txt')
  writeFileSync(target, 'before')
  const snapshots = manager(stateRoot, {
    cloneFile(from, to) { copyFileSync(from, to) },
  })
  const unchanged = await snapshots.run({ sessionId: 'session-finalize', roots: [workspace] }, async () => 'ok')
  assert.equal(unchanged.result, 'ok')
  assert.equal(unchanged.changed, false)
  assert.equal(unchanged.transaction, null)
  assert.deepEqual(transactionEntries(stateRoot), [])

  const changed = await snapshots.run({ sessionId: 'session-finalize', roots: [workspace] }, async () => {
    writeFileSync(target, 'after')
    return 'changed'
  })
  assert.equal(changed.changed, true)
  const manifest = snapshots.manifestOf(changed.transaction)
  assert.equal(manifest.state, 'captured')
  assert.deepEqual(manifest.changes.map((entry) => [entry.relativePath, entry.kind]), [['document.txt', 'modified']])
  assert.equal(readFileSync(join(changed.transaction.path, 'payload/root-0000/document.txt'), 'utf8'), 'before')
  snapshots.discard(changed.transaction)
})

test('manifest settlement classifies added modified and deleted paths without watcher authority', async () => {
  const { workspace, stateRoot } = fixture('change-set')
  writeFileSync(join(workspace, 'modified.bin'), Buffer.from([0, 1, 2]))
  writeFileSync(join(workspace, 'deleted.txt'), 'delete me')
  const candidates = new Set(['wrong-watcher-hint.txt'])
  const snapshots = manager(stateRoot, { cloneFile(from, to) { copyFileSync(from, to) } })
  const outcome = await snapshots.run({
    sessionId: 'session-change-set',
    roots: [workspace],
    candidatePaths: () => candidates,
  }, async () => {
    writeFileSync(join(workspace, 'modified.bin'), Buffer.from([3, 4, 5]))
    rmSync(join(workspace, 'deleted.txt'))
    writeFileSync(join(workspace, 'added.txt'), 'created')
    return { exitCode: 7 }
  })
  assert.equal(outcome.result.exitCode, 7)
  assert.deepEqual(outcome.changes.filter((entry) => entry.relativePath).map((entry) => [entry.relativePath, entry.kind]), [
    ['added.txt', 'added'],
    ['deleted.txt', 'deleted'],
    ['modified.bin', 'modified'],
  ])
  const manifest = snapshots.manifestOf(outcome.transaction)
  assert.deepEqual(manifest.candidatePaths, ['wrong-watcher-hint.txt'])
  assert.equal(manifest.changes.some((entry) => entry.relativePath === 'wrong-watcher-hint.txt'), false)
  snapshots.discard(outcome.transaction)
})

test('real Bash Python and Node writes are classified from disk state', async () => {
  const probes = [
    {
      name: 'bash-redirect',
      run(target) { execFileSync('/bin/bash', ['-c', 'printf redirected > "$TARGET"'], { env: { ...process.env, TARGET: target } }) },
    },
    {
      name: 'python-dynamic',
      run(target) { execFileSync('python3', ['-c', 'import os; open(os.environ["TARGET"], "wb").write(b"python")'], { env: { ...process.env, TARGET: target } }) },
    },
    {
      name: 'node-binary',
      run(target) { execFileSync(process.execPath, ['-e', 'require("fs").writeFileSync(process.env.TARGET, Buffer.from([0,255,1]))'], { env: { ...process.env, TARGET: target } }) },
    },
  ]
  for (const probe of probes) {
    const { workspace, stateRoot } = fixture(probe.name)
    const target = join(workspace, `${probe.name}.bin`)
    const snapshots = manager(stateRoot)
    const outcome = await snapshots.run({ sessionId: `session-${probe.name}`, roots: [workspace] }, async () => probe.run(target))
    assert.equal(outcome.changes.find((entry) => entry.relativePath === `${probe.name}.bin`).kind, 'added')
    snapshots.discard(outcome.transaction)
  }
})

test('throw timeout and cancellation endings all settle through the captured state', async () => {
  for (const code of ['COMMAND_FAILED', 'BASH_TIMEOUT', 'TOOL_ABORTED']) {
    const { workspace, stateRoot } = fixture(`ending-${code}`)
    const target = join(workspace, 'ending.txt')
    writeFileSync(target, 'before')
    const snapshots = manager(stateRoot, { cloneFile(from, to) { copyFileSync(from, to) } })
    await assert.rejects(
      snapshots.run({ sessionId: `session-${code}`, roots: [workspace] }, async () => {
        writeFileSync(target, code)
        throw Object.assign(new Error(code), { code })
      }),
      (error) => error.code === code && typeof error.snapshotTransactionId === 'string',
    )
    const sessionRoot = join(stateRoot, 'shell-transactions', readdirSync(join(stateRoot, 'shell-transactions'))[0])
    const transaction = readdirSync(sessionRoot)[0]
    const manifest = JSON.parse(readFileSync(join(sessionRoot, transaction, 'manifest.json'), 'utf8'))
    assert.equal(manifest.state, 'captured')
    assert.equal(manifest.changes.find((entry) => entry.relativePath === 'ending.txt').kind, 'modified')
  }
})

test('same-content touch is discarded while a post-command concurrent write fails stale', async () => {
  const touchFixture = fixture('touch')
  const touchTarget = join(touchFixture.workspace, 'same.txt')
  writeFileSync(touchTarget, 'same')
  const touchSnapshots = manager(touchFixture.stateRoot, { cloneFile(from, to) { copyFileSync(from, to) } })
  const touched = await touchSnapshots.run({ sessionId: 'session-touch', roots: [touchFixture.workspace] }, async () => {
    const now = new Date(Date.now() + 2_000)
    utimesSync(touchTarget, now, now)
  })
  assert.equal(touched.changed, false)

  const staleFixture = fixture('stale')
  const staleTarget = join(staleFixture.workspace, 'race.txt')
  writeFileSync(staleTarget, 'before')
  const staleSnapshots = manager(staleFixture.stateRoot, {
    cloneFile(from, to) { copyFileSync(from, to) },
    settle: async () => { writeFileSync(staleTarget, 'concurrent') },
  })
  await assert.rejects(
    staleSnapshots.run({ sessionId: 'session-stale', roots: [staleFixture.workspace] }, async () => {
      writeFileSync(staleTarget, 'command')
    }),
    (error) => error.code === 'snapshot-finalize-stale',
  )
  const [retained] = transactionEntries(staleFixture.stateRoot)
  const manifest = JSON.parse(readFileSync(join(staleFixture.stateRoot, 'shell-transactions', readdirSync(join(staleFixture.stateRoot, 'shell-transactions'))[0], retained, 'manifest.json'), 'utf8'))
  assert.equal(manifest.state, 'failed')
  assert.equal(manifest.failure, 'snapshot-finalize-stale')
})

test('a surviving foreground process marks the transaction failed and retains its snapshot', async () => {
  const { workspace, stateRoot } = fixture('process-survivor')
  const target = join(workspace, 'survivor.txt')
  writeFileSync(target, 'before')
  const snapshots = manager(stateRoot, { cloneFile(from, to) { copyFileSync(from, to) } })
  await assert.rejects(
    snapshots.run({ sessionId: 'session-survivor', roots: [workspace] }, async () => {
      writeFileSync(target, 'after')
      throw Object.assign(new Error('process survived'), { code: 'SHELL_PROCESS_TREE_SURVIVED' })
    }),
    (error) => error.code === 'SHELL_PROCESS_TREE_SURVIVED' && error.snapshotTransactionId === 'tx-1',
  )
  const sessionDir = join(stateRoot, 'shell-transactions', readdirSync(join(stateRoot, 'shell-transactions'))[0])
  const manifest = JSON.parse(readFileSync(join(sessionDir, 'tx-1', 'manifest.json'), 'utf8'))
  assert.equal(manifest.state, 'failed')
  assert.equal(manifest.failure, 'SHELL_PROCESS_TREE_SURVIVED')
  assert.equal(manifest.changes.find((entry) => entry.relativePath === 'survivor.txt').kind, 'modified')
})

test('invalid state transitions are rejected and a command error still finalizes changes', async () => {
  const { workspace, stateRoot } = fixture('state-machine')
  const target = join(workspace, 'document.txt')
  writeFileSync(target, 'before')
  const snapshots = manager(stateRoot, { cloneFile(from, to) { copyFileSync(from, to) } })
  const ready = snapshots.begin({ sessionId: 'session-state-machine', roots: [workspace] })
  assert.throws(() => snapshots.updateState(ready, 'captured'), (error) => error.code === 'snapshot-state-transition')
  snapshots.discard(ready)

  await assert.rejects(
    snapshots.run({ sessionId: 'session-state-machine', roots: [workspace] }, async () => {
      writeFileSync(target, 'changed before error')
      throw new Error('command failed')
    }),
    (error) => error.message === 'command failed' && error.snapshotTransactionId === 'tx-2',
  )
  const retained = transactionEntries(stateRoot)
  assert.deepEqual(retained, ['tx-2'])
})

test('a new manager recovers and finalizes a running transaction left by a host crash', async () => {
  const { workspace, stateRoot } = fixture('crash-recovery')
  const target = join(workspace, 'crashed.txt')
  writeFileSync(target, 'before crash')
  const first = manager(stateRoot, { cloneFile(from, to) { copyFileSync(from, to) } })
  const transaction = first.begin({ sessionId: 'session-crash', roots: [workspace] })
  first.updateState(transaction, 'running', { startedAt: new Date().toISOString() })
  writeFileSync(target, 'after crash')

  const restarted = manager(stateRoot, { cloneFile(from, to) { copyFileSync(from, to) } })
  const recovered = await restarted.recover('session-crash')
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].changes.find((change) => change.relativePath === 'crashed.txt').kind, 'modified')
  assert.equal(restarted.manifestOf(recovered[0].transaction).state, 'captured')
  restarted.markLedgerCommitted(recovered[0].transaction)
  assert.deepEqual(await restarted.recover('session-crash'), [])
})

test('crash recovery keeps the workspace lease through recovered ledger commit', async () => {
  const { workspace, stateRoot } = fixture('crash-recovery-lock')
  const target = join(workspace, 'crashed.txt')
  writeFileSync(target, 'before')
  const crashed = manager(stateRoot, { cloneFile(from, to) { copyFileSync(from, to) } })
  const transaction = crashed.begin({ sessionId: 'crashed-session', roots: [workspace] })
  crashed.updateState(transaction, 'running')
  writeFileSync(target, 'after')

  const restarted = manager(stateRoot, { cloneFile(from, to) { copyFileSync(from, to) } })
  let commitStarted = false
  let releaseCommit
  const commitGate = new Promise((resolve) => { releaseCommit = resolve })
  const recovery = restarted.recover('crashed-session', async () => {
    commitStarted = true
    await commitGate
  })
  while (!commitStarted) await new Promise((resolve) => setTimeout(resolve, 1))
  let nextStarted = false
  const next = restarted.run({ sessionId: 'next-session', roots: [workspace] }, async () => { nextStarted = true })
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(nextStarted, false)
  releaseCommit()
  await Promise.all([recovery, next])
  assert.equal(nextStarted, true)
  restarted.discard(transaction)
})

test('recursive COW clones each root once while preserving verified entries', () => {
  const { workspace, stateRoot } = fixture('tree-cow')
  mkdirSync(join(workspace, 'nested'))
  writeFileSync(join(workspace, 'one.txt'), 'one')
  writeFileSync(join(workspace, 'nested', 'two.txt'), 'two')
  let trees = 0
  let files = 0
  const snapshots = manager(stateRoot, {
    cloneTree(from, to) {
      trees++
      execFileSync('/bin/cp', ['-R', from, to])
      return true
    },
    cloneFile(from, to) { files++; copyFileSync(from, to) },
  })
  const transaction = snapshots.begin({ sessionId: 'session-tree-cow', roots: [workspace] })
  assert.equal(trees, 1)
  assert.equal(files, 0)
  assert.equal(readFileSync(join(transaction.path, 'payload/root-0000/nested/two.txt'), 'utf8'), 'two')
  assert.equal(snapshots.manifestOf(transaction).entries.filter((entry) => entry.kind === 'file').every((entry) => entry.snapshotMethod === 'cow'), true)
  snapshots.discard(transaction)
})

test('incremental inventories hash unchanged files once per lifecycle', async () => {
  const { workspace, stateRoot } = fixture('incremental-hash')
  for (let index = 0; index < 40; index++) writeFileSync(join(workspace, `${index}.txt`), `value-${index}`)
  let hashes = 0
  const snapshots = manager(stateRoot, {
    cloneFile(from, to) { copyFileSync(from, to) },
    hashFile(path) {
      hashes++
      return createHash('sha256').update(readFileSync(path)).digest('hex')
    },
  })
  const unchanged = await snapshots.run({ sessionId: 'session-hash', roots: [workspace] }, async () => {})
  assert.equal(unchanged.changed, false)
  // 40 source hashes + 40 payload integrity hashes. The prepare verification
  // and both settlement passes reuse hashes because ctime/mtime/size match.
  assert.equal(hashes, 80)
})

test('same-workspace sessions serialize through ledger commit while different workspaces overlap', async () => {
  const first = fixture('serial-first')
  const secondWorkspace = join(first.root, 'other-workspace')
  mkdirSync(secondWorkspace)
  writeFileSync(join(first.workspace, 'a'), 'a')
  writeFileSync(join(secondWorkspace, 'b'), 'b')
  const snapshots = manager(first.stateRoot, { cloneFile(from, to) { copyFileSync(from, to) } })
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  let firstStarted = false
  let sameStarted = false
  let otherStarted = false
  const firstRun = snapshots.run({ sessionId: 'parent', roots: [first.workspace] }, async () => {
    firstStarted = true
    writeFileSync(join(first.workspace, 'a'), 'parent')
  }, async () => { await firstGate })
  while (!firstStarted) await new Promise((resolve) => setTimeout(resolve, 1))
  const sameRun = snapshots.run({ sessionId: 'child', roots: [first.workspace] }, async () => { sameStarted = true })
  const otherRun = snapshots.run({ sessionId: 'other', roots: [secondWorkspace] }, async () => { otherStarted = true })
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(sameStarted, false)
  assert.equal(otherStarted, true)
  releaseFirst()
  await Promise.all([firstRun, sameRun, otherRun])
  assert.equal(sameStarted, true)
})

test('overlapping parent and child roots serialize even when root arrays differ', async () => {
  const { workspace, stateRoot } = fixture('overlap-lock')
  const child = join(workspace, 'child')
  mkdirSync(child)
  writeFileSync(join(child, 'file'), 'before')
  const snapshots = manager(stateRoot, { cloneFile(from, to) { copyFileSync(from, to) } })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let childStarted = false
  const parent = snapshots.run({ sessionId: 'parent', roots: [workspace] }, async () => { await gate })
  const childRun = snapshots.run({ sessionId: 'child', roots: [child] }, async () => { childStarted = true })
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(childStarted, false)
  release()
  await Promise.all([parent, childRun])
  assert.equal(childStarted, true)
})

test('reclamation is lazy and only removes expired preparing ready and committed evidence', async () => {
  const { workspace, stateRoot } = fixture('retention')
  writeFileSync(join(workspace, 'file'), 'before')
  let clock = Date.now()
  const snapshots = manager(stateRoot, {
    now: () => clock,
    cloneFile(from, to) { copyFileSync(from, to) },
    limits: { stalePreparingMs: 100, staleReadyMs: 100, committedRetentionMs: 100 },
  })
  const ready = snapshots.begin({ sessionId: 'ready', roots: [workspace] })
  const captured = await snapshots.run({ sessionId: 'captured', roots: [workspace] }, async () => {
    writeFileSync(join(workspace, 'file'), 'after')
  })
  snapshots.markLedgerCommitted(captured.transaction)
  const preparing = join(stateRoot, 'shell-transactions', 'manual-session', '.manual.preparing')
  mkdirSync(preparing, { recursive: true })
  const old = new Date(clock - 1_000)
  utimesSync(preparing, old, old)
  clock += 1_000
  const removed = snapshots.reclaimExpired()
  assert.deepEqual(removed, { preparing: 1, ready: 1, committed: 1 })
  assert.equal(existsSync(ready.path), false)
  assert.equal(existsSync(captured.transaction.path), false)

  const retained = await snapshots.run({ sessionId: 'uncommitted', roots: [workspace] }, async () => {
    writeFileSync(join(workspace, 'file'), 'again')
  })
  clock += 10_000
  snapshots.reclaimExpired()
  assert.equal(existsSync(retained.transaction.path), true)
})

test('a 1,000-file workspace stays within the routine performance and memory envelope', { timeout: 30_000 }, async (t) => {
  const { workspace, stateRoot } = fixture('perf-1000')
  for (let index = 0; index < 1_000; index++) writeFileSync(join(workspace, `file-${String(index).padStart(4, '0')}.txt`), `content-${index}`)
  const snapshots = manager(stateRoot)
  const rssBefore = process.memoryUsage().rss
  const started = performance.now()
  const outcome = await snapshots.run({ sessionId: 'session-perf', roots: [workspace] }, async () => {
    writeFileSync(join(workspace, 'file-0500.txt'), 'changed')
  })
  const elapsedMs = performance.now() - started
  const rssDelta = Math.max(0, process.memoryUsage().rss - rssBefore)
  const stateBytes = allocatedBytes(outcome.transaction.path)
  t.diagnostic(JSON.stringify({ files: 1_000, elapsedMs: Math.round(elapsedMs), rssDelta, stateRootAllocatedBytes: stateBytes }))
  assert.equal(outcome.changes.filter((entry) => entry.kind === 'modified').length, 1)
  assert.ok(elapsedMs < 15_000, `1,000-file transaction took ${elapsedMs}ms`)
  assert.ok(rssDelta < 256 * 1024 * 1024, `RSS grew by ${rssDelta} bytes`)
  snapshots.discard(outcome.transaction)
})
