import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readPersistedSessionTitles } from '../src/session-title-cache.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(value?: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-session-titles-'))
  temporaryDirectories.push(directory)
  if (value !== undefined) {
    mkdirSync(join(directory, 'storages'), { recursive: true })
    writeFileSync(join(directory, 'storages', 'session_projcache.json'), JSON.stringify(value))
  }
  return directory
}

describe('readPersistedSessionTitles', () => {
  it('extracts durable non-empty title rows', async () => {
    const directory = fixture({
      tables: {
        sessions: {
          'session-one': { rows: { title: { ver: 1, seq: 4, val: '  手动名称  ' } } },
          'session-two': { rows: { title: { val: 'Second title' } } },
        },
      },
    })
    expect(await readPersistedSessionTitles(directory)).toEqual({
      'session-one': '手动名称',
      'session-two': 'Second title',
    })
  })

  it('ignores malformed sessions and empty titles', async () => {
    const directory = fixture({
      tables: {
        sessions: {
          '': { rows: { title: { val: 'invalid id' } } },
          empty: { rows: { title: { val: '   ' } } },
          missing: { rows: {} },
          malformed: 'bad row',
          valid: { rows: { title: { val: 'Kept' } } },
        },
      },
    })
    expect(await readPersistedSessionTitles(directory)).toEqual({ valid: 'Kept' })
  })

  it('returns an empty map for missing or invalid cache files', async () => {
    expect(await readPersistedSessionTitles(fixture())).toEqual({})
    expect(await readPersistedSessionTitles(fixture({ tables: { sessions: [] } }))).toEqual({})
  })
})
