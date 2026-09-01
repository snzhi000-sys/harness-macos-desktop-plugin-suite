import assert from 'node:assert/strict'
import { test } from 'node:test'

import { closeProcessedTabState } from '../client/src/file-tab-state.js'

test('close processed tabs keeps pending review and unsaved draft tabs', () => {
  const result = closeProcessedTabState(
    ['clean-a', 'pending-b', 'dirty-c', 'clean-d'],
    'clean-a',
    ['pending-b'],
    ['dirty-c'],
  )
  assert.deepEqual(result.tabs, ['pending-b', 'dirty-c'])
  assert.equal(result.active, 'pending-b')
  assert.deepEqual(result.closed, ['clean-a', 'clean-d'])
})

test('close processed tabs preserves an active protected tab and tab order', () => {
  const result = closeProcessedTabState(['clean-a', 'pending-b', 'dirty-c'], 'dirty-c', ['pending-b'], ['dirty-c'])
  assert.deepEqual(result.tabs, ['pending-b', 'dirty-c'])
  assert.equal(result.active, 'dirty-c')
})

test('close processed tabs empties a fully processed tab bar', () => {
  const result = closeProcessedTabState(['clean-a', 'clean-b'], 'clean-b', [], [])
  assert.deepEqual(result.tabs, [])
  assert.equal(result.active, null)
  assert.deepEqual(result.closed, ['clean-a', 'clean-b'])
})

test('close processed tabs changes nothing when every tab is protected', () => {
  const result = closeProcessedTabState(['pending-a', 'dirty-b'], 'pending-a', ['pending-a'], ['dirty-b'])
  assert.deepEqual(result.tabs, ['pending-a', 'dirty-b'])
  assert.equal(result.active, 'pending-a')
  assert.deepEqual(result.closed, [])
})

test('close processed tabs treats opaque external review ids like ordinary tab ids', () => {
  const externalId = 'external:opaque-review-id'
  const result = closeProcessedTabState([externalId, 'clean-a'], 'clean-a', [externalId], [])
  assert.deepEqual(result.tabs, [externalId])
  assert.equal(result.active, externalId)
})
