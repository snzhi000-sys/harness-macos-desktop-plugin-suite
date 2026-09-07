/** Provider-scoped durable mapping from attachment digest to DeepSeek file id. */

import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export interface DeepSeekUploadRecord {
  scope: string
  attachmentId: string
  fileId: string
  bytes: number
  createdAt: number
  expiresAt: number
}

interface StoredIndex { formatVersion: 1; records: DeepSeekUploadRecord[] }

export function deepSeekFileScope(baseURL: string, apiKey: string): string {
  return createHash('sha256').update(baseURL.replace(/\/+$/u, '')).update('\0').update(apiKey).digest('hex')
}

function validRecord(value: unknown): value is DeepSeekUploadRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return typeof r.scope === 'string' && /^[a-f0-9]{64}$/u.test(r.scope)
    && typeof r.attachmentId === 'string' && /^sha256:[a-f0-9]{64}$/u.test(r.attachmentId)
    && typeof r.fileId === 'string' && r.fileId.length > 0
    && Number.isSafeInteger(r.bytes) && Number.isSafeInteger(r.createdAt) && Number.isSafeInteger(r.expiresAt)
}

export class DeepSeekUploadIndex {
  constructor(readonly path = join(resolveDshHome(), 'llm-deepseek', 'files-v1.json')) {}

  private async load(): Promise<StoredIndex> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as { formatVersion?: unknown; records?: unknown }
      if (value.formatVersion !== 1 || !Array.isArray(value.records)
        || !value.records.every(validRecord)) return { formatVersion: 1, records: [] }
      return { formatVersion: 1, records: value.records }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT' || error instanceof SyntaxError) return { formatVersion: 1, records: [] }
      throw error
    }
  }

  async get(scope: string, attachmentId: string, now: number, marginMs: number): Promise<DeepSeekUploadRecord | undefined> {
    return (await this.load()).records.find(record => record.scope === scope
      && record.attachmentId === attachmentId && record.expiresAt - now > marginMs)
  }

  async commit(candidate: DeepSeekUploadRecord, now: number, marginMs: number): Promise<DeepSeekUploadRecord> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    return withFileLock(this.path, async () => {
      const index = await this.load()
      const existing = index.records.find(record => record.scope === candidate.scope
        && record.attachmentId === candidate.attachmentId && record.expiresAt - now > marginMs)
      if (existing !== undefined) return existing
      const records = index.records.filter(record => record.expiresAt - now > marginMs
        && !(record.scope === candidate.scope && record.attachmentId === candidate.attachmentId))
      records.push(candidate)
      await writeFileAtomic(this.path, `${JSON.stringify({ formatVersion: 1, records }, undefined, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      return candidate
    })
  }

  async remove(scope: string, attachmentId: string, fileId: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await withFileLock(this.path, async () => {
      const index = await this.load()
      const records = index.records.filter(record => !(record.scope === scope
        && record.attachmentId === attachmentId && record.fileId === fileId))
      if (records.length !== index.records.length) {
        await writeFileAtomic(this.path, `${JSON.stringify({ formatVersion: 1, records }, undefined, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      }
    })
  }
}
