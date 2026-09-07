import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createShellSnapshotTransactions } from '../host/shell-snapshot-transaction.mjs'

const scales = String(process.env.DSH_SHELL_SNAPSHOT_BENCH_SCALES || '1000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isSafeInteger(value) && value > 0)
const binaryMiB = Number(process.env.DSH_SHELL_SNAPSHOT_BENCH_BINARY_MIB || 128)

function allocatedBytes(path) {
  const info = lstatSync(path)
  let total = Number(info.blocks) * 512
  if (info.isDirectory()) for (const name of readdirSync(path)) total += allocatedBytes(join(path, name))
  return total
}

async function benchmarkFiles(fileCount) {
  const root = mkdtempSync(join(tmpdir(), `dsh-shell-bench-${fileCount}-`))
  const workspace = join(root, 'workspace')
  const stateRoot = join(root, 'state')
  mkdirSync(workspace)
  mkdirSync(stateRoot)
  const shardSize = 1_000
  for (let index = 0; index < fileCount; index++) {
    const shard = join(workspace, `shard-${String(Math.floor(index / shardSize)).padStart(3, '0')}`)
    if (index % shardSize === 0) mkdirSync(shard)
    writeFileSync(join(shard, `file-${String(index).padStart(6, '0')}.txt`), `content-${index}\n`)
  }
  const manager = createShellSnapshotTransactions({
    stateRoot,
    limits: { maxEntries: fileCount + Math.ceil(fileCount / shardSize) + 4, settleMs: 0 },
  })
  const rssBefore = process.memoryUsage().rss
  const prepareStarted = performance.now()
  const transaction = manager.begin({ sessionId: `bench-${fileCount}`, roots: [workspace] })
  const prepareMs = performance.now() - prepareStarted
  manager.updateState(transaction, 'running')
  writeFileSync(join(workspace, 'shard-000', 'file-000000.txt'), 'changed\n')
  const finalizeStarted = performance.now()
  const settled = await manager.finalize(transaction)
  const finalizeMs = performance.now() - finalizeStarted
  const result = {
    kind: 'files',
    fileCount,
    prepareMs: Math.round(prepareMs),
    finalizeMs: Math.round(finalizeMs),
    rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
    snapshotLogicalBytes: manager.manifestOf(settled.transaction).totalBytes,
    transactionDirectoryBlocks: allocatedBytes(settled.transaction.path),
    changes: settled.changes.length,
  }
  rmSync(root, { recursive: true, force: true })
  return result
}

async function benchmarkBinary(sizeMiB) {
  const root = mkdtempSync(join(tmpdir(), `dsh-shell-bench-binary-${sizeMiB}-`))
  const workspace = join(root, 'workspace')
  const stateRoot = join(root, 'state')
  mkdirSync(workspace)
  mkdirSync(stateRoot)
  const target = join(workspace, 'large.bin')
  writeFileSync(target, Buffer.alloc(sizeMiB * 1024 * 1024, 0x5a))
  const manager = createShellSnapshotTransactions({ stateRoot, limits: { settleMs: 0 } })
  const beforeBlocks = allocatedBytes(stateRoot)
  const started = performance.now()
  const transaction = manager.begin({ sessionId: 'bench-binary', roots: [workspace] })
  const result = {
    kind: 'binary',
    sizeMiB,
    prepareMs: Math.round(performance.now() - started),
    logicalBytes: manager.manifestOf(transaction).totalBytes,
    stateRootBlockDelta: Math.max(0, allocatedBytes(stateRoot) - beforeBlocks),
  }
  manager.discard(transaction)
  rmSync(root, { recursive: true, force: true })
  return result
}

for (const scale of scales) console.log(JSON.stringify(await benchmarkFiles(scale)))
console.log(JSON.stringify(await benchmarkBinary(binaryMiB)))
