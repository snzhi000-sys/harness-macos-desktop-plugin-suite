// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  allLeaves,
  createSidebarStore,
  makeDefaultState,
  openTabInActivePane,
  type SidebarState,
  type SidebarStatePersistence,
} from '../src/client/state.ts'

function restoredState(): SidebarState {
  let state = makeDefaultState(480, true, true)
  state = openTabInActivePane(state, {
    id: 'browser:1', type: 'browser', title: 'example.com', path: 'https://example.com/',
  })
  state = openTabInActivePane(state, {
    id: 'preview:/work/report.pdf', type: 'preview', title: 'report.pdf', path: '/work/report.pdf', viewerId: 'pdf',
  })
  return state
}

beforeEach(() => {
  localStorage.clear()
})

describe('Host-backed sidebar layout hydration', () => {
  it('defers Host layout I/O through the shared startup lane', async () => {
    let run: (() => void | Promise<void>) | undefined
    const load = vi.fn(async () => restoredState())
    const store = createSidebarStore({ load, save: async () => {} }, {
      schedule: async (task) => { run = task },
    })
    store.setSession('deferred')
    expect(load).not.toHaveBeenCalled()
    await run?.()
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('deferred'))
  })

  it('restores tab metadata but always keeps the right panel collapsed', async () => {
    const persistence: SidebarStatePersistence = {
      load: vi.fn(async () => restoredState()),
      save: vi.fn(async () => {}),
    }
    const store = createSidebarStore(persistence)
    store.setSession('session-a')

    await vi.waitFor(() => {
      const state = store.getSnapshot().state!
      expect(state.panelOpen).toBe(false)
      expect(allLeaves(state.splits).flatMap(leaf => leaf.tabs)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'browser', path: 'https://example.com/' }),
        expect.objectContaining({ type: 'preview', path: '/work/report.pdf', viewerId: 'pdf' }),
      ]))
    })
  })

  it('does not leak one session layout into another', async () => {
    const layouts = new Map<string, SidebarState>([
      ['one', openTabInActivePane(makeDefaultState(), { id: 'browser:one', type: 'browser', title: 'One' })],
      ['two', openTabInActivePane(makeDefaultState(), { id: 'preview:two', type: 'preview', title: 'two.png', path: '/two.png', viewerId: 'image' })],
    ])
    const store = createSidebarStore({
      load: async id => layouts.get(id),
      save: async () => {},
    })
    store.setSession('one')
    await vi.waitFor(() => expect(allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs).map(tab => tab.id)).toContain('browser:one'))
    store.setSession('two')
    await vi.waitFor(() => {
      const ids = allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs).map(tab => tab.id)
      expect(ids).toContain('preview:two')
      expect(ids).not.toContain('browser:one')
    })
  })

  it('never overwrites a user mutation with a late Host response', async () => {
    let resolveLoad: (state: SidebarState) => void = () => {}
    const store = createSidebarStore({
      load: async () => await new Promise<SidebarState>(resolve => { resolveLoad = resolve }),
      save: async () => {},
    })
    store.setSession('race')
    store.reduce(state => openTabInActivePane(state, { id: 'browser:new', type: 'browser', title: 'New' }))
    resolveLoad(openTabInActivePane(makeDefaultState(), { id: 'browser:stale', type: 'browser', title: 'Stale' }))
    await Promise.resolve()
    await Promise.resolve()
    const ids = allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs).map(tab => tab.id)
    expect(ids).toContain('browser:new')
    expect(ids).not.toContain('browser:stale')
  })

  it('does not start a deferred stale layout after a user mutation', async () => {
    let run: (() => void | Promise<void>) | undefined
    const load = vi.fn(async () => openTabInActivePane(
      makeDefaultState(),
      { id: 'browser:stale', type: 'browser', title: 'Stale' },
    ))
    const store = createSidebarStore({ load, save: async () => {} }, {
      schedule: async (task) => { run = task },
    })
    store.setSession('race-deferred')
    store.reduce(state => openTabInActivePane(state, { id: 'browser:new', type: 'browser', title: 'New' }))
    await run?.()
    await Promise.resolve()
    const ids = allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs).map(tab => tab.id)
    expect(ids).toContain('browser:new')
    expect(ids).not.toContain('browser:stale')
  })

  it('persists pending changes for two sessions independently', async () => {
    vi.useFakeTimers()
    const saved: Array<[string, SidebarState]> = []
    const save = vi.fn(async (sessionId: string, state: SidebarState) => { saved.push([sessionId, state]) })
    try {
      const store = createSidebarStore({ load: async () => undefined, save })
      store.setSession('one')
      store.reduce(state => openTabInActivePane(state, { id: 'browser:one', type: 'browser', title: 'One' }))
      store.setSession('two')
      store.reduce(state => openTabInActivePane(state, { id: 'browser:two', type: 'browser', title: 'Two' }))

      await vi.advanceTimersByTimeAsync(250)
      expect(saved.map(call => call[0]).sort()).toEqual(['one', 'two'])
      expect(saved.find(call => call[0] === 'one')?.[1].splits).toBeDefined()
      expect(saved.find(call => call[0] === 'two')?.[1].splits).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
