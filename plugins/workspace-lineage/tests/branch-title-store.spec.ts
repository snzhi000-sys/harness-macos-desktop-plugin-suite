import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BranchTitleStore } from '../src/branch-title-store.ts'

describe('BranchTitleStore', () => {
  it('persists multiple titles and reads them after reconstructing the store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-branch-titles-'))
    const path = join(directory, 'nested', 'branch-titles.json')
    const store = new BranchTitleStore(path)
    expect(await store.get()).toEqual({})

    await store.set('branch-a', '  设计方案  ')
    await store.set('branch-b', '测试记录')

    expect(await new BranchTitleStore(path).get()).toEqual({
      'branch-a': '设计方案',
      'branch-b': '测试记录',
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 })
  })

  it('degrades damaged state to no overrides and rejects empty keys or titles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-branch-titles-damaged-'))
    const path = join(directory, 'branch-titles.json')
    await writeFile(path, '{not json', 'utf8')
    const store = new BranchTitleStore(path)

    expect(await store.get()).toEqual({})
    await expect(store.set(' ', 'name')).rejects.toThrow('sessionId')
    await expect(store.set('branch', ' ')).rejects.toThrow('title')
  })
})
