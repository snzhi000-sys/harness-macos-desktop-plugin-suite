import assert from 'node:assert/strict'
import { test } from 'node:test'

import { clearDeletedTabState, markDeletedTabState } from '../client/src/deleted-tab-state.js'

test('a deletion recorded before opening remains available to the future tab', () => {
  const deleted = markDeletedTabState(new Set(), [], 'deleted-before-open.md')
  assert.equal(deleted.has('deleted-before-open.md'), true)
})

test('directory deletion marks its currently open descendants without inventing unrelated files', () => {
  const deleted = markDeletedTabState(new Set(), ['folder/a.md', 'folder/nested/b.md', 'other.md'], 'folder')
  assert.deepEqual([...deleted].sort(), ['folder', 'folder/a.md', 'folder/nested/b.md'])
})

test('restoring one file clears only that file deletion state', () => {
  const deleted = clearDeletedTabState(new Set(['a.md', 'b.md']), 'a.md')
  assert.deepEqual([...deleted], ['b.md'])
})
