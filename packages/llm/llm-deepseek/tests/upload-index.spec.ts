import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekUploadIndex, deepSeekFileScope } from '../src/upload-index.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('DeepSeekUploadIndex', () => {
  it('isolates reusable file ids by endpoint and API-key scope and removes only an exact stale generation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-files-index-'))
    roots.push(root)
    const index = new DeepSeekUploadIndex(join(root, 'files.json'))
    const attachmentId = `sha256:${'c'.repeat(64)}`
    const firstScope = deepSeekFileScope('https://api.example/', 'key-a')
    const otherScope = deepSeekFileScope('https://api.example', 'key-b')
    const record = { scope: firstScope, attachmentId, fileId: 'file-a', bytes: 3, createdAt: 100, expiresAt: 10_000 }
    await index.commit(record, 1_000, 100)
    expect((await index.get(firstScope, attachmentId, 1_000, 100))?.fileId).toBe('file-a')
    expect(await index.get(otherScope, attachmentId, 1_000, 100)).toBeUndefined()
    await index.remove(firstScope, attachmentId, 'file-other')
    expect((await index.get(firstScope, attachmentId, 1_000, 100))?.fileId).toBe('file-a')
    await index.remove(firstScope, attachmentId, 'file-a')
    expect(await index.get(firstScope, attachmentId, 1_000, 100)).toBeUndefined()
  })
})
