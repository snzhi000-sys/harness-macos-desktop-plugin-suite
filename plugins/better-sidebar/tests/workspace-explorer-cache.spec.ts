import { describe, expect, it } from 'vitest'
import {
  clearWorkspaceExplorerCache, explorerDataForWorkspace, storeExplorerDataForWorkspace,
} from '../src/client/workspace-explorer-cache.ts'

describe('workspace Explorer cache', () => {
  it('shares listings between conversations with the same workspace root', () => {
    clearWorkspaceExplorerCache()
    const listing = { '/project': { entries: [{ name: 'README.md', path: '/project/README.md', isDir: false, hidden: false }] } }
    storeExplorerDataForWorkspace('/project', listing)
    expect(explorerDataForWorkspace('/project')).toBe(listing)
    expect(explorerDataForWorkspace('/other')).toEqual({})
  })

  it('keeps each workspace cache independent', () => {
    clearWorkspaceExplorerCache()
    const first = { '/first': { entries: [] } }
    const second = { '/second': { entries: [] } }
    storeExplorerDataForWorkspace('/first', first)
    storeExplorerDataForWorkspace('/second', second)

    expect(explorerDataForWorkspace('/first')).toBe(first)
    expect(explorerDataForWorkspace('/second')).toBe(second)
  })
})
