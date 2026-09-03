/**
 * JSON `per-record` unit: one document at
 * `<root>/<unit>/<table>/<key>.json`. The directory is authoritative; the
 * domain layer owns live memory and serializes writes.
 *
 * A malformed, unreadable, or unaccepted-version document reads as absent.
 * When the tree is empty, an accepted legacy single-unit document is copied
 * into current-version record documents and retained unchanged.
 * @module @deepseek-ai/dsh-storage-json/src/per-record-unit
 */

import type { Dirent } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { writeAtomic } from './atomic.ts'
import { parseRecord, serializeRecord } from './format.ts'
import type { UnitState } from './format.ts'

const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/

/**
 * Open a per-record unit without touching the medium.
 * @param descriptor - Static unit identity and accepted versions.
 * @param root - JSON backend root.
 * @param onClose - Callback releasing the backend's open slot.
 * @returns the opened unit.
 */
export function openPerRecordUnit(
  descriptor: KvUnitDescriptor,
  root: string,
  onClose: () => void,
): Promise<KvUnit> {
  return Promise.resolve(new PerRecordJsonUnit(descriptor, join(root, descriptor.name), onClose))
}

/** Reconstruct the complete logical unit from independent record documents. */
async function loadPerRecordState(descriptor: KvUnitDescriptor, dir: string): Promise<UnitState> {
  const versions = acceptedStamps(descriptor)
  const state: UnitState = {
    version: descriptor.version,
    global: null,
    tables: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
  }
  let entries: Dirent[] | undefined
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const hasNewDocuments = entries === undefined
    ? false
    : (await Promise.all(entries.map(async (entry) => {
      if (entry.isDirectory()) {
        const records = state.tables.get(entry.name)
        if (records !== undefined) return loadTableRecords(records, versions, join(dir, entry.name))
      }
      if (entry.name === 'global.json' && descriptor.hasGlobal) {
        const global = await readRecord(join(dir, entry.name), versions)
        if (global !== undefined) state.global = global
        return true
      }
      return false
    }))).some(Boolean)
  if (!hasNewDocuments) await bootstrapLegacyUnit(descriptor, dir, state)
  return state
}

/** Current and explicitly compatible stamps accepted on read. */
function acceptedStamps(descriptor: KvUnitDescriptor): readonly number[] {
  return [descriptor.version, ...descriptor.compatibleVersions ?? []]
}

/**
 * Copy an accepted legacy single-unit file into the new tree. The source file
 * remains untouched so a failed or partial migration is recoverable.
 */
async function bootstrapLegacyUnit(descriptor: KvUnitDescriptor, dir: string, state: UnitState): Promise<void> {
  const legacyPath = join(dirname(dir), `${descriptor.name}.json`)
  let text: string
  try {
    text = await readFile(legacyPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let document: { unit?: { name?: unknown; version?: unknown }; tables?: unknown }
  try {
    document = JSON.parse(text) as typeof document
  } catch {
    return
  }
  if (document.unit?.name !== descriptor.name) return
  const version = document.unit.version
  if (typeof version !== 'number' || !acceptedStamps(descriptor).includes(version)) return
  if (typeof document.tables !== 'object' || document.tables === null) return
  const tables = document.tables as Record<string, unknown>
  for (const [table, values] of Object.entries(tables)) {
    const target = state.tables.get(table)
    if (target === undefined || typeof values !== 'object' || values === null || Array.isArray(values)) continue
    for (const [key, value] of Object.entries(values)) {
      if (!SAFE_KEY_RE.test(key)) continue
      const path = join(dir, table, `${key}.json`)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeAtomic(path, serializeRecord(descriptor.version, value))
      target.set(key, value)
    }
  }
}

/**
 * Load one table.
 * @returns whether any JSON document exists, including an unreadable or
 * foreign document that must suppress legacy bootstrap.
 */
async function loadTableRecords(
  records: Map<string, unknown>,
  versions: readonly number[],
  dir: string,
): Promise<boolean> {
  const files = await readdir(dir, { withFileTypes: true })
  const hasDocuments = files.some(file => file.name.endsWith('.json'))
  const loaded = await Promise.all(files.map(async (file) => {
    if (!file.isFile() || !file.name.endsWith('.json')) return
    const key = file.name.slice(0, -'.json'.length)
    if (!SAFE_KEY_RE.test(key)) return
    const record = await readRecord(join(dir, file.name), versions)
    if (record !== undefined) return [key, record] as const
  }))
  for (const record of loaded) {
    if (record !== undefined) records.set(...record)
  }
  return hasDocuments
}

/** Read one record; foreign or unreadable documents are absent. */
async function readRecord(path: string, versions: readonly number[]): Promise<unknown> {
  try {
    return parseRecord(await readFile(path, 'utf8'), versions)
  } catch {
    return undefined
  }
}

/** Opened per-record JSON unit. */
export class PerRecordJsonUnit implements KvUnit {
  private closed = false
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly dir: string,
    private readonly onClose: () => void,
  ) {}

  /** Re-read the authoritative directory. */
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const state = await loadPerRecordState(this.descriptor, this.dir)
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of state.tables) tables[table] = Object.fromEntries(records)
    return { tables, global: state.global }
  }

  /** Atomically replace one record document. */
  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    await this.tracked(this.writeDocument(join(this.tableDir(table), `${key}.json`), value))
  }

  /** Remove one record document; a missing record is already deleted. */
  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    await this.tracked(rm(join(this.tableDir(table), `${key}.json`), { force: true }))
  }

  /** Move an invalid record aside under a timestamped non-JSON name. */
  async backupRecord(table: string, key: string): Promise<string> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    const path = join(this.tableDir(table), `${key}.json`)
    const moved = `${path}.bak.${backupStamp(new Date())}-${randomUUID()}`
    await this.tracked(rename(path, moved))
    return moved
  }

  /** Replace the global document when the unit declared one. */
  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
    await this.tracked(this.writeDocument(join(this.dir, 'global.json'), value))
  }

  /** Drain writes and release the unit. */
  async close(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled(this.inFlight)
      return
    }
    this.closed = true
    await Promise.allSettled(this.inFlight)
    this.onClose()
  }

  private assertOpen(): void {
    if (this.closed) throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
  }

  private tableDir(table: string): string {
    if (!this.descriptor.tables.includes(table)) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return join(this.dir, table)
  }

  private writeDocument(path: string, value: unknown): Promise<void> {
    return (async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeAtomic(path, serializeRecord(this.descriptor.version, value))
    })()
  }

  private tracked(write: Promise<void>): Promise<void> {
    this.inFlight.add(write)
    write.catch(() => {}).finally(() => this.inFlight.delete(write))
    return write
  }
}

/** Local-time millisecond stamp used by unique backup names. */
function backupStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    + String(now.getMilliseconds()).padStart(3, '0')
}

function assertSafeKey(unit: string, key: string): void {
  if (!SAFE_KEY_RE.test(key)) {
    throw new Error(`unit '${unit}': per-record key '${key}' is not path-safe (must match ${SAFE_KEY_RE})`)
  }
}
