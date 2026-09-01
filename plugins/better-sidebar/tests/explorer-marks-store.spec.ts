import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExplorerMarksStore, sanitizeExplorerMarks } from '../src/explorer-marks-store.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(): { directory: string; root: string; state: string } {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-explorer-marks-'))
  temporaryDirectories.push(directory)
  const root = join(directory, 'workspace')
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'note.md'), '# note\n')
  return { directory, root, state: join(directory, 'state', 'explorer-marks.json') }
}

describe('ExplorerMarksStore', () => {
  it('persists workspace marks across fresh Host instances', async () => {
    const { root, state } = fixture()
    const first = new ExplorerMarksStore(state)
    await first.set(root, [
      { path: join(root, 'docs'), emoji: '🍿', isDir: true },
      { path: join(root, 'note.md'), emoji: '🍔', isDir: false },
    ])

    const restored = await new ExplorerMarksStore(state).get(root)
    expect(restored.initialized).toBe(true)
    expect(restored.marks).toEqual([
      { path: join(root, 'docs'), emoji: '🍿', isDir: true },
      { path: join(root, 'note.md'), emoji: '🍔', isDir: false },
    ])
  })

  it('distinguishes a saved empty set and prunes entries deleted on disk', async () => {
    const { root, state } = fixture()
    const store = new ExplorerMarksStore(state)
    await store.set(root, [])
    expect(await new ExplorerMarksStore(state).get(root)).toEqual({ marks: [], initialized: true })

    await store.set(root, [{ path: join(root, 'note.md'), emoji: '🍟', isDir: false }])
    rmSync(join(root, 'note.md'))
    expect(await new ExplorerMarksStore(state).get(root)).toEqual({ marks: [], initialized: true })
  })

  it('rejects paths outside the workspace and duplicate marker slots', () => {
    const { root } = fixture()
    expect(sanitizeExplorerMarks(root, [
      { path: '/tmp/outside', emoji: '🍿', isDir: false },
      { path: join(root, 'docs'), emoji: '🍔', isDir: true },
      { path: join(root, 'note.md'), emoji: '🍔', isDir: false },
    ])).toEqual([{ path: join(root, 'docs'), emoji: '🍔', isDir: true }])
  })
})
