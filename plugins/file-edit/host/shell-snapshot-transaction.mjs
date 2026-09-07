import {
  constants as fsConstants,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const SHELL_SNAPSHOT_DEFAULTS = Object.freeze({
  maxEntries: 51_000,
  maxBytes: 8 * 1024 * 1024 * 1024,
  maxDepth: 64,
  reserveBytes: 16 * 1024 * 1024,
  settleMs: 140,
  stalePreparingMs: 60 * 60 * 1000,
  staleReadyMs: 60 * 60 * 1000,
  committedRetentionMs: 7 * 24 * 60 * 60 * 1000,
})

const FALLBACK_CLONE_ERRORS = new Set(['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL'])
const TRANSITIONS = Object.freeze({
  ready: new Set(['running', 'discarded']),
  running: new Set(['captured', 'failed', 'discarded']),
})

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  throw error
}

function safeSessionId(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32)
}

function normalizeRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0) fail('snapshot-roots-empty', 'Shell 快照至少需要一个可写根目录')
  const rawRoots = roots.map((item) => String(item))
  for (const root of rawRoots) {
    if (!root || !isAbsolute(root)) fail('snapshot-root-relative', 'Shell 快照根目录必须是绝对路径')
  }
  const normalized = [...new Set(rawRoots.map((item) => resolve(item)))].sort()
  for (let index = 0; index < normalized.length; index++) {
    for (let other = index + 1; other < normalized.length; other++) {
      const rel = relative(normalized[index], normalized[other])
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        fail('snapshot-roots-overlap', 'Shell 快照可写根目录不能互相包含')
      }
    }
  }
  return normalized
}

function pathContains(parent, candidate) {
  const rel = relative(parent, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function defaultHashFile(path) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(256 * 1024)
  const fd = openSync(path, 'r')
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null)
      if (count === 0) break
      hash.update(buffer.subarray(0, count))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function defaultAvailableBytes(path) {
  const stats = statfsSync(path)
  return Number(stats.bavail) * Number(stats.bsize)
}

function defaultCloneFile(source, destination) {
  if (process.platform === 'darwin') {
    // Node's COPYFILE_FICLONE_FORCE currently returns ENOSYS on macOS even on
    // APFS. /bin/cp -c is the system clonefile(2) frontend; argv is passed
    // directly without a shell and both paths are transaction-owned values.
    const result = spawnSync('/bin/cp', ['-c', source, destination], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      const error = new Error('APFS clonefile is unavailable for this source and destination')
      error.code = 'ENOTSUP'
      throw error
    }
    return
  }
  copyFileSync(source, destination, fsConstants.COPYFILE_FICLONE_FORCE | fsConstants.COPYFILE_EXCL)
}

function defaultCloneTree(source, destination) {
  if (process.platform !== 'darwin') return false
  const result = spawnSync('/bin/cp', ['-cR', source, destination], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const error = new Error('APFS recursive clonefile is unavailable for this source and destination')
    error.code = 'ENOTSUP'
    throw error
  }
  return true
}

function entryMetadata(info) {
  return {
    mode: info.mode & 0o7777,
    mtimeMs: Math.trunc(info.mtimeMs),
    ctimeMs: info.ctimeMs,
    uid: info.uid,
    gid: info.gid,
  }
}

function reusableHash(entry, common, info) {
  return entry?.kind === 'file'
    && entry.size === info.size
    && entry.mode === common.mode
    && entry.mtimeMs === common.mtimeMs
    && entry.ctimeMs === common.ctimeMs
    && entry.uid === common.uid
    && entry.gid === common.gid
    ? entry.sha256
    : undefined
}

function inventoryRoots(roots, limits, hashFile, allowMissing = false, baselineEntries = []) {
  const entries = []
  let totalBytes = 0
  const baseline = new Map(baselineEntries.map((entry) => [entryKey(entry), entry]))

  function add(rootIndex, sourcePath, relativePath, depth) {
    if (depth > limits.maxDepth) fail('snapshot-depth-limit', `Shell 快照目录深度超过上限 ${limits.maxDepth}`)
    let info
    try {
      info = lstatSync(sourcePath)
    } catch (error) {
      if (allowMissing && error && error.code === 'ENOENT') {
        entries.push({ rootIndex, relativePath, kind: 'absent' })
        return
      }
      fail('snapshot-unreadable', `无法读取 Shell 快照目标：${sourcePath}`, error)
    }
    if (entries.length >= limits.maxEntries) fail('snapshot-entry-limit', `Shell 快照条目超过上限 ${limits.maxEntries}`)
    const common = { rootIndex, relativePath, ...entryMetadata(info) }
    if (info.isSymbolicLink()) {
      let linkTarget
      try { linkTarget = readlinkSync(sourcePath) } catch (error) {
        fail('snapshot-unreadable', `无法读取 Shell 快照符号链接：${sourcePath}`, error)
      }
      entries.push({ ...common, kind: 'symlink', linkTarget })
      return
    }
    if (info.isDirectory()) {
      entries.push({ ...common, kind: 'directory' })
      let names
      try { names = readdirSync(sourcePath).sort() } catch (error) {
        fail('snapshot-unreadable', `无法枚举 Shell 快照目录：${sourcePath}`, error)
      }
      for (const name of names) add(rootIndex, join(sourcePath, name), relativePath ? join(relativePath, name) : name, depth + 1)
      return
    }
    if (!info.isFile()) fail('snapshot-special-file', `Shell 快照不支持特殊文件：${sourcePath}`)
    if (info.nlink > 1) fail('snapshot-hard-link', `Shell 快照暂不支持硬链接文件：${sourcePath}`)
    totalBytes += info.size
    if (totalBytes > limits.maxBytes) fail('snapshot-byte-limit', `Shell 快照内容超过上限 ${limits.maxBytes} 字节`)
    let sha256 = reusableHash(baseline.get(`${rootIndex}\0${relativePath}`), common, info)
    try { sha256 ||= hashFile(sourcePath) } catch (error) {
      fail('snapshot-unreadable', `无法读取 Shell 快照文件：${sourcePath}`, error)
    }
    entries.push({ ...common, kind: 'file', size: info.size, sha256 })
  }

  for (let index = 0; index < roots.length; index++) add(index, roots[index], '', 0)
  return { entries, totalBytes }
}

function payloadPath(transactionPath, entry) {
  const root = join(transactionPath, 'payload', `root-${String(entry.rootIndex).padStart(4, '0')}`)
  return entry.relativePath ? join(root, entry.relativePath) : root
}

function writeJsonAtomic(path, value) {
  const tempPath = `${path}.tmp-${randomUUID()}`
  const body = JSON.stringify(value) + '\n'
  writeFileSync(tempPath, body, { flag: 'wx', mode: 0o600 })
  const fd = openSync(tempPath, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tempPath, path)
}

function semanticEntry(entry) {
  return {
    rootIndex: entry.rootIndex,
    relativePath: entry.relativePath,
    kind: entry.kind,
    mode: entry.mode,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
    uid: entry.uid,
    gid: entry.gid,
    size: entry.size,
    sha256: entry.sha256,
    linkTarget: entry.linkTarget,
  }
}

function inventoryMatches(left, right) {
  if (left.length !== right.length) return false
  return left.every((entry, index) => JSON.stringify(semanticEntry(entry)) === JSON.stringify(semanticEntry(right[index])))
}

function entryKey(entry) {
  return `${String(entry.rootIndex)}\0${entry.relativePath}`
}

function mutationEntry(entry) {
  if (!entry || entry.kind === 'absent') return null
  return {
    kind: entry.kind,
    mode: entry.mode,
    uid: entry.uid,
    gid: entry.gid,
    size: entry.size,
    sha256: entry.sha256,
    linkTarget: entry.linkTarget,
  }
}

function calculateChanges(before, after) {
  const previous = new Map(before.filter((entry) => entry.kind !== 'absent').map((entry) => [entryKey(entry), entry]))
  const current = new Map(after.filter((entry) => entry.kind !== 'absent').map((entry) => [entryKey(entry), entry]))
  const keys = [...new Set([...previous.keys(), ...current.keys()])].sort()
  const changes = []
  for (const key of keys) {
    const left = previous.get(key)
    const right = current.get(key)
    if (left === undefined) {
      changes.push({ rootIndex: right.rootIndex, relativePath: right.relativePath, kind: 'added', after: mutationEntry(right) })
      continue
    }
    if (right === undefined) {
      changes.push({ rootIndex: left.rootIndex, relativePath: left.relativePath, kind: 'deleted', before: mutationEntry(left) })
      continue
    }
    if (JSON.stringify(mutationEntry(left)) !== JSON.stringify(mutationEntry(right))) {
      changes.push({
        rootIndex: left.rootIndex,
        relativePath: left.relativePath,
        kind: 'modified',
        before: mutationEntry(left),
        after: mutationEntry(right),
      })
    }
  }
  return changes
}

function candidatePaths(request) {
  const source = typeof request.candidatePaths === 'function' ? request.candidatePaths() : request.candidatePaths
  if (!source || typeof source[Symbol.iterator] !== 'function') return []
  return [...new Set([...source].map((item) => String(item)).filter(Boolean))].sort()
}

function delay(ms) {
  return ms === 0 ? Promise.resolve() : new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

export function createShellSnapshotTransactions(options = {}) {
  const stateRoot = resolve(String(options.stateRoot || ''))
  if (!options.stateRoot || !isAbsolute(stateRoot)) fail('snapshot-state-root', 'Shell 快照状态目录必须是绝对路径')
  const limits = { ...SHELL_SNAPSHOT_DEFAULTS, ...(options.limits || {}) }
  for (const key of ['maxEntries', 'maxBytes', 'maxDepth', 'reserveBytes', 'settleMs', 'stalePreparingMs', 'staleReadyMs', 'committedRetentionMs']) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) fail('snapshot-limit-invalid', `Shell 快照限制无效：${key}`)
  }
  const cloneFile = options.cloneFile || defaultCloneFile
  const cloneTree = options.cloneTree === undefined && !options.cloneFile && !options.copyFile ? defaultCloneTree : options.cloneTree
  const copyFile = options.copyFile || ((source, destination) => copyFileSync(source, destination, fsConstants.COPYFILE_EXCL))
  const availableBytes = options.availableBytes || defaultAvailableBytes
  const hashFile = options.hashFile || defaultHashFile
  const settle = options.settle || delay
  const idFactory = options.idFactory || (() => `shell-${Date.now().toString(36)}-${randomUUID()}`)
  const now = options.now || (() => Date.now())
  const transactionsRoot = join(stateRoot, 'shell-transactions')
  const activeLocks = new Set()

  function rootsOverlap(left, right) {
    return left.some((a) => right.some((b) => pathContains(a, b) || pathContains(b, a)))
  }

  async function withRootLock(roots, task) {
    const blockers = [...activeLocks].filter((lock) => rootsOverlap(lock.roots, roots)).map((lock) => lock.done)
    let release
    const done = new Promise((resolveDone) => { release = resolveDone })
    const lock = { roots, done }
    activeLocks.add(lock)
    try {
      await Promise.all(blockers)
      return await task()
    } finally {
      activeLocks.delete(lock)
      release()
    }
  }

  function timestamp() {
    return new Date(now()).toISOString()
  }

  function assertTransaction(transaction) {
    const path = transaction && typeof transaction.path === 'string' ? resolve(transaction.path) : ''
    if (!path || !pathContains(transactionsRoot, path) || path === transactionsRoot || basename(path) !== transaction.id) {
      fail('snapshot-transaction-authority', 'Shell 快照事务句柄无效')
    }
    if (resolve(String(transaction.manifestPath || '')) !== join(path, 'manifest.json')) {
      fail('snapshot-transaction-authority', 'Shell 快照 manifest 句柄无效')
    }
  }

  function manifestOf(transaction) {
    assertTransaction(transaction)
    return JSON.parse(readFileSync(transaction.manifestPath, 'utf8'))
  }

  function updateState(transaction, nextState, extra = {}) {
    const manifest = manifestOf(transaction)
    const allowed = TRANSITIONS[manifest.state]
    if (!allowed || !allowed.has(nextState)) fail('snapshot-state-transition', `Shell 快照状态不能从 ${manifest.state} 变为 ${nextState}`)
    const next = { ...manifest, ...extra, state: nextState, updatedAt: timestamp() }
    writeJsonAtomic(transaction.manifestPath, next)
    return next
  }

  function snapshotEntry(transactionPath, roots, entry, cloneAdapter = cloneFile) {
    const source = entry.relativePath ? join(roots[entry.rootIndex], entry.relativePath) : roots[entry.rootIndex]
    const destination = payloadPath(transactionPath, entry)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    if (entry.kind === 'directory') {
      mkdirSync(destination, { recursive: false, mode: 0o700 })
      return { ...entry, snapshotMethod: 'directory' }
    }
    if (entry.kind === 'symlink') {
      symlinkSync(entry.linkTarget, destination)
      return { ...entry, snapshotMethod: 'symlink' }
    }
    let snapshotMethod = 'cow'
    try {
      cloneAdapter(source, destination)
    } catch (error) {
      if (!error || !FALLBACK_CLONE_ERRORS.has(error.code)) throw error
      try { rmSync(destination, { force: true }) } catch (cleanupError) {
        fail('snapshot-cleanup-failed', `无法清理失败的 COW 目标：${destination}`, cleanupError)
      }
      let free
      try { free = availableBytes(dirname(destination)) } catch (spaceError) {
        fail('snapshot-space-unknown', '无法确认 Shell 快照可用磁盘空间', spaceError)
      }
      if (!Number.isFinite(free) || free < entry.size + limits.reserveBytes) fail('snapshot-disk-full', 'Shell 快照可用磁盘空间不足')
      copyFile(source, destination)
      snapshotMethod = 'copy'
    }
    const copied = lstatSync(destination)
    if (!copied.isFile() || copied.size !== entry.size || hashFile(destination) !== entry.sha256) {
      fail('snapshot-integrity', `Shell 快照完整性校验失败：${source}`)
    }
    chmodSync(destination, entry.mode)
    utimesSync(destination, entry.mtimeMs / 1000, entry.mtimeMs / 1000)
    return { ...entry, snapshotMethod }
  }

  function verifyClonedEntry(transactionPath, entry) {
    const destination = payloadPath(transactionPath, entry)
    const copied = lstatSync(destination)
    if (entry.kind === 'directory') {
      if (!copied.isDirectory()) fail('snapshot-integrity', `Shell 快照目录完整性校验失败：${destination}`)
      return { ...entry, snapshotMethod: 'directory' }
    }
    if (entry.kind === 'symlink') {
      if (!copied.isSymbolicLink() || readlinkSync(destination) !== entry.linkTarget) fail('snapshot-integrity', `Shell 快照链接完整性校验失败：${destination}`)
      return { ...entry, snapshotMethod: 'symlink' }
    }
    if (!copied.isFile() || copied.size !== entry.size || hashFile(destination) !== entry.sha256) {
      fail('snapshot-integrity', `Shell 快照完整性校验失败：${destination}`)
    }
    return { ...entry, snapshotMethod: 'cow' }
  }

  function snapshotInventory(stagingPath, roots, inventory) {
    if (typeof cloneTree === 'function') {
      try {
        mkdirSync(join(stagingPath, 'payload'), { recursive: true, mode: 0o700 })
        for (let index = 0; index < roots.length; index++) {
          const destination = join(stagingPath, 'payload', `root-${String(index).padStart(4, '0')}`)
          if (cloneTree(roots[index], destination) === false) throw Object.assign(new Error('recursive COW unsupported'), { code: 'ENOTSUP' })
        }
        return inventory.entries.map((entry) => verifyClonedEntry(stagingPath, entry))
      } catch (error) {
        if (!error || !FALLBACK_CLONE_ERRORS.has(error.code)) throw error
        rmSync(join(stagingPath, 'payload'), { recursive: true, force: true })
        const free = availableBytes(stagingPath)
        if (!Number.isFinite(free) || free < inventory.totalBytes + limits.reserveBytes) fail('snapshot-disk-full', 'Shell 快照可用磁盘空间不足')
        const physicalOnly = (_source, _destination) => { throw Object.assign(new Error('COW unavailable'), { code: 'ENOTSUP' }) }
        return inventory.entries.map((entry) => snapshotEntry(stagingPath, roots, entry, physicalOnly))
      }
    }
    return inventory.entries.map((entry) => snapshotEntry(stagingPath, roots, entry))
  }

  function begin(request) {
    const sessionId = String(request && request.sessionId || '')
    if (!sessionId) fail('snapshot-session', 'Shell 快照缺少 Session ID')
    const roots = normalizeRoots(request.roots)
    for (const root of roots) {
      if (pathContains(root, stateRoot) || pathContains(stateRoot, root)) {
        fail('snapshot-state-overlap', 'Shell 快照状态目录不能与可写根目录重叠')
      }
    }
    const transactionId = String(idFactory())
    if (!/^[a-zA-Z0-9._-]+$/.test(transactionId)) fail('snapshot-id', 'Shell 快照事务 ID 无效')
    const sessionRoot = join(transactionsRoot, safeSessionId(sessionId))
    const stagingPath = join(sessionRoot, `.${transactionId}.preparing`)
    const transactionPath = join(sessionRoot, transactionId)
    let renamed = false
    try {
      mkdirSync(sessionRoot, { recursive: true, mode: 0o700 })
      mkdirSync(stagingPath, { recursive: false, mode: 0o700 })
      const manifestPath = join(stagingPath, 'manifest.json')
      writeJsonAtomic(manifestPath, {
        version: 2,
        transactionId,
        sessionIdHash: safeSessionId(sessionId),
        state: 'preparing',
        createdAt: timestamp(),
        roots,
        limits,
        entries: [],
        totalBytes: 0,
      })
      const inventory = inventoryRoots(roots, limits, hashFile)
      const entries = snapshotInventory(stagingPath, roots, inventory)
      const verifiedSource = inventoryRoots(roots, limits, hashFile, false, inventory.entries)
      if (!inventoryMatches(inventory.entries, verifiedSource.entries)) {
        fail('snapshot-source-changed', 'Shell 快照建立期间源目录发生变化，命令未执行')
      }
      writeJsonAtomic(manifestPath, {
        ...JSON.parse(readFileSync(manifestPath, 'utf8')),
        state: 'ready',
        readyAt: timestamp(),
        entries,
        totalBytes: inventory.totalBytes,
      })
      renameSync(stagingPath, transactionPath)
      renamed = true
      return { id: transactionId, path: transactionPath, manifestPath: join(transactionPath, 'manifest.json'), roots }
    } catch (error) {
      try { rmSync(renamed ? transactionPath : stagingPath, { recursive: true, force: true }) } catch (cleanupError) {
        fail('snapshot-cleanup-failed', 'Shell 快照失败且无法清理半成品', cleanupError)
      }
      if (error && error.code && String(error.code).startsWith('snapshot-')) throw error
      fail('snapshot-create-failed', '无法建立完整的 Shell 修改前快照', error)
    }
  }

  function discard(transaction) {
    assertTransaction(transaction)
    rmSync(transaction.path, { recursive: true, force: true })
  }

  function markLedgerCommitted(transaction) {
    const manifest = manifestOf(transaction)
    writeJsonAtomic(transaction.manifestPath, { ...manifest, ledgerCommittedAt: timestamp() })
  }

  function reclaimExpired() {
    if (!existsSync(transactionsRoot)) return { preparing: 0, ready: 0, committed: 0 }
    const removed = { preparing: 0, ready: 0, committed: 0 }
    const age = (value) => now() - Date.parse(value || '')
    for (const sessionName of readdirSync(transactionsRoot)) {
      const sessionRoot = join(transactionsRoot, sessionName)
      let names
      try { names = readdirSync(sessionRoot) } catch (error) { continue }
      for (const name of names) {
        const transactionPath = join(sessionRoot, name)
        if (name.startsWith('.') && name.endsWith('.preparing')) {
          let modifiedAt = 0
          try { modifiedAt = statSync(transactionPath).mtimeMs } catch (error) { continue }
          if (now() - modifiedAt >= limits.stalePreparingMs) {
            rmSync(transactionPath, { recursive: true, force: true })
            removed.preparing++
          }
          continue
        }
        const transaction = { id: name, path: transactionPath, manifestPath: join(transactionPath, 'manifest.json') }
        let manifest
        try { manifest = manifestOf(transaction) } catch (error) { continue }
        if (manifest.ledgerCommittedAt && age(manifest.ledgerCommittedAt) >= limits.committedRetentionMs) {
          discard(transaction)
          removed.committed++
        } else if (manifest.state === 'ready' && age(manifest.readyAt || manifest.updatedAt || manifest.createdAt) >= limits.staleReadyMs) {
          discard(transaction)
          removed.ready++
        }
      }
    }
    return removed
  }

  async function recover(sessionId, commit) {
    reclaimExpired()
    const sessionRoot = join(transactionsRoot, safeSessionId(sessionId))
    if (!existsSync(sessionRoot)) return []
    const recovered = []
    for (const name of readdirSync(sessionRoot).sort()) {
      const transactionPath = join(sessionRoot, name)
      if (name.startsWith('.') && name.endsWith('.preparing')) continue
      const transaction = { id: name, path: transactionPath, manifestPath: join(transactionPath, 'manifest.json') }
      let manifest
      try { manifest = manifestOf(transaction) } catch (error) { continue }
      transaction.roots = manifest.roots
      if (manifest.ledgerCommittedAt) continue
      if (manifest.state === 'ready') {
        discard(transaction)
        continue
      }
      if (!['running', 'captured', 'failed'].includes(manifest.state)) continue
      if (manifest.state !== 'running' && !Array.isArray(manifest.changes)) continue
      const finalized = await withRootLock(normalizeRoots(manifest.roots), async () => {
        const settled = manifest.state === 'running'
          ? await finalize(transaction)
          : {
              changed: manifest.changes.length > 0,
              failed: manifest.state === 'failed',
              transaction,
              changes: manifest.changes,
            }
        if (settled.changed && typeof commit === 'function') await commit(settled)
        return settled
      })
      if (finalized.changed && typeof commit !== 'function') recovered.push(finalized)
    }
    return recovered
  }

  async function finalize(transaction, request = {}) {
    const manifest = manifestOf(transaction)
    let first
    let current
    try {
      first = inventoryRoots(manifest.roots, manifest.limits, hashFile, true, manifest.entries)
      await settle(manifest.limits.settleMs)
      current = inventoryRoots(manifest.roots, manifest.limits, hashFile, true, first.entries)
    } catch (error) {
      updateState(transaction, 'failed', {
        failure: error.code || 'snapshot-compare-failed',
        candidatePaths: candidatePaths(request),
      })
      throw error
    }
    const changes = calculateChanges(manifest.entries, current.entries)
    if (!inventoryMatches(first.entries, current.entries)) {
      updateState(transaction, 'failed', {
        failure: 'snapshot-finalize-stale',
        candidatePaths: candidatePaths(request),
        changes,
      })
      fail('snapshot-finalize-stale', 'Shell 命令结束后可写根仍在变化，事务保留且不能结算')
    }
    if (request.forceFailure) {
      updateState(transaction, 'failed', {
        failure: String(request.failure || 'snapshot-execution-lifecycle'),
        candidatePaths: candidatePaths(request),
        changes,
      })
      return { changed: changes.length > 0, failed: true, transaction, changes }
    }
    if (changes.length === 0) {
      updateState(transaction, 'discarded')
      discard(transaction)
      return { changed: false, failed: false, transaction: null, changes: [] }
    }
    updateState(transaction, 'captured', {
        capturedAt: timestamp(),
      candidatePaths: candidatePaths(request),
      changes,
    })
    return { changed: true, failed: false, transaction, changes }
  }

  async function runUnlocked(request, execute, commit) {
    if (typeof execute !== 'function') fail('snapshot-execute', 'Shell 快照事务缺少执行函数')
    let transaction
    try {
      transaction = begin(request)
    } catch (error) {
      if (error && typeof error === 'object') error.snapshotPhase = 'prepare'
      throw error
    }
    updateState(transaction, 'running', { startedAt: timestamp() })
    let result
    let commandError
    try { result = await execute(transaction) } catch (error) { commandError = error }
    let finalized
    try {
      finalized = await finalize(transaction, {
        candidatePaths: request.candidatePaths,
        forceFailure: commandError?.code === 'SHELL_PROCESS_TREE_SURVIVED',
        failure: commandError?.code,
      })
    } catch (error) {
      if (error && typeof error === 'object') error.snapshotPhase = 'finalize'
      if (commandError) commandError.snapshotFinalizeError = error
      else throw error
    }
    if (finalized?.changed && typeof commit === 'function') {
      try { await commit(finalized) } catch (error) {
        if (commandError && error && typeof error === 'object') error.commandError = commandError
        throw error
      }
    }
    if (commandError) {
      commandError.snapshotTransactionId = existsSync(transaction.path) ? transaction.id : null
      commandError.snapshotSettlement = finalized
      throw commandError
    }
    return { result, ...finalized }
  }

  async function run(request, execute, commit) {
    if (typeof execute !== 'function') fail('snapshot-execute', 'Shell 快照事务缺少执行函数')
    const roots = normalizeRoots(request?.roots)
    return withRootLock(roots, async () => {
      reclaimExpired()
      return runUnlocked({ ...request, roots }, execute, commit)
    })
  }

  return { begin, discard, finalize, manifestOf, markLedgerCommitted, reclaimExpired, recover, run, updateState }
}
