import { describe, expect, it } from 'vitest'
import { closeTabAndMaybeCollapseRightSurface, rightSurfaceTree } from '../src/client/browser-panel.ts'
import { makeDefaultState, type SplitNode } from '../src/client/state.ts'

describe('rightSurfaceTree', () => {
  it('preserves pane geometry while projecting Browser and Preview tabs only', () => {
    const tree: SplitNode = {
      kind: 'split', id: 'split:1', dir: 'row', sizes: [0.5, 0.5], children: [
        {
          kind: 'leaf', id: 'pane:1', active: 'git', tabs: [
            { id: 'git', type: 'git', title: 'Git' },
            { id: 'browser:1', type: 'browser', title: 'Browser' },
            { id: 'preview:/w/a.png', type: 'preview', title: 'a.png', path: '/w/a.png', viewerId: 'image' },
          ],
        },
        {
          kind: 'leaf', id: 'pane:2', active: 'editor:1', tabs: [
            { id: 'editor:1', type: 'editor', title: 'Editor' },
            { id: 'terminal:1', type: 'terminal', title: 'Terminal' },
            { id: 'diff:1', type: 'diff', title: 'Diff' },
            { id: 'subagent', type: 'subagent', title: 'Subagent' },
          ],
        },
      ],
    }
    const projected = rightSurfaceTree(tree)
    expect(projected.kind).toBe('split')
    if (projected.kind !== 'split') return
    expect(projected.sizes).toEqual([0.5, 0.5])
    expect(projected.children[0]).toMatchObject({
      kind: 'leaf', active: 'browser:1', tabs: [
        { id: 'browser:1', type: 'browser' },
        { id: 'preview:/w/a.png', type: 'preview' },
      ],
    })
    expect(projected.children[1]).toMatchObject({ kind: 'leaf', active: null, tabs: [] })
  })

  it('keeps an active Preview active', () => {
    const tree: SplitNode = {
      kind: 'leaf', id: 'pane:1', active: 'preview:/w/a.pdf', tabs: [
        { id: 'browser:1', type: 'browser', title: 'Browser' },
        { id: 'preview:/w/a.pdf', type: 'preview', title: 'a.pdf', path: '/w/a.pdf', viewerId: 'pdf' },
      ],
    }
    expect(rightSurfaceTree(tree)).toMatchObject({
      active: 'preview:/w/a.pdf',
      tabs: [{ type: 'browser' }, { type: 'preview' }],
    })
  })
})

describe('closeTabAndMaybeCollapseRightSurface', () => {
  it('keeps the rail open when closing the final Browser while Preview remains', () => {
    const state = makeDefaultState()
    state.panelOpen = true
    if (state.splits.kind !== 'leaf') throw new Error('expected default leaf')
    state.splits.tabs = [
      { id: 'browser:1', type: 'browser', title: 'Browser' },
      { id: 'preview:/w/a.png', type: 'preview', title: 'a.png', path: '/w/a.png', viewerId: 'image' },
    ]
    state.splits.active = 'browser:1'

    const next = closeTabAndMaybeCollapseRightSurface(state, state.splits.id, 'browser:1')
    expect(next.panelOpen).toBe(true)
    expect(next.splits).toMatchObject({
      kind: 'leaf', active: 'preview:/w/a.png', tabs: [{ type: 'preview' }],
    })
  })

  it('keeps the rail open when closing the final Preview while Browser remains', () => {
    const state = makeDefaultState()
    state.panelOpen = true
    if (state.splits.kind !== 'leaf') throw new Error('expected default leaf')
    state.splits.tabs = [
      { id: 'browser:1', type: 'browser', title: 'Browser' },
      { id: 'preview:/w/a.pdf', type: 'preview', title: 'a.pdf', path: '/w/a.pdf', viewerId: 'pdf' },
    ]
    state.splits.active = 'preview:/w/a.pdf'

    const next = closeTabAndMaybeCollapseRightSurface(state, state.splits.id, 'preview:/w/a.pdf')
    expect(next.panelOpen).toBe(true)
    expect(next.splits).toMatchObject({ kind: 'leaf', active: 'browser:1', tabs: [{ type: 'browser' }] })
  })

  it.each([
    { id: 'browser:1', type: 'browser', title: 'Browser' },
    { id: 'preview:/w/a.pdf', type: 'preview', title: 'a.pdf', path: '/w/a.pdf', viewerId: 'pdf' },
  ])('closes the rail atomically with its final $type surface', (tab) => {
    const state = makeDefaultState()
    state.panelOpen = true
    if (state.splits.kind !== 'leaf') throw new Error('expected default leaf')
    state.splits.tabs = [tab]
    state.splits.active = tab.id

    const next = closeTabAndMaybeCollapseRightSurface(state, state.splits.id, tab.id)
    expect(next.panelOpen).toBe(false)
    expect(next.splits).toMatchObject({ kind: 'leaf', active: null, tabs: [] })
  })
})
