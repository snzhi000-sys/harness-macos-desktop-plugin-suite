import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SidebarLayoutStore } from '../src/sidebar-layout-store.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-sidebar-layout-'))
  directories.push(directory)
  return join(directory, 'state', 'layouts.json')
}

describe('SidebarLayoutStore', () => {
  it('restores Browser and Preview metadata across fresh Host instances', async () => {
    const path = fixture()
    const state = {
      panelOpen: true,
      splits: {
        kind: 'leaf', id: 'pane:1', active: 'preview:/work/report.pdf', tabs: [
          { id: 'browser:1', type: 'browser', title: 'example.com', path: 'https://example.com/' },
          { id: 'preview:/work/report.pdf', type: 'preview', title: 'report.pdf', path: '/work/report.pdf', viewerId: 'pdf' },
        ],
      },
    }
    await new SidebarLayoutStore(path).set('session-a', state)
    expect(await new SidebarLayoutStore(path).get('session-a')).toEqual(state)
    expect(await new SidebarLayoutStore(path).get('session-b')).toBeUndefined()
  })

  it('recovers from a corrupt file and keeps sessions isolated', async () => {
    const path = fixture()
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '{broken')
    const store = new SidebarLayoutStore(path)
    await store.set('one', { value: 1 })
    await store.set('two', { value: 2 })
    const restored = new SidebarLayoutStore(path)
    expect(await restored.get('one')).toEqual({ value: 1 })
    expect(await restored.get('two')).toEqual({ value: 2 })
  })

  it('rejects invalid ids and oversized layouts', async () => {
    const store = new SidebarLayoutStore(fixture())
    await expect(store.set('bad\nkey', {})).rejects.toThrow('invalid session id')
    await expect(store.set('large', { value: 'x'.repeat(901 * 1024) })).rejects.toThrow('too large')
  })
})
