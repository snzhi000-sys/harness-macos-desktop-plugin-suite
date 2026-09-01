import { describe, expect, it } from 'vitest'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { decodePersistedTitles, overlayPersistedTitles } from '../src/client/session-titles.ts'

const sid = (id: string) => id as SessionId
const summary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id),
  displayTitle: id,
  running: false,
  blank: false,
  updatedAt: 1,
  ...overrides,
})
const list = (...items: SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  current: undefined,
  phase: 'ready',
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
})

describe('overlayPersistedTitles', () => {
  it('restores a persisted title onto a cold session summary', () => {
    const raw = list(summary('cold', { displayTitle: 'project-folder' }))
    expect(overlayPersistedTitles(raw, { cold: '手动修改后的名称' }).byId[sid('cold')]).toMatchObject({
      title: '手动修改后的名称',
      displayTitle: '手动修改后的名称',
    })
  })

  it('never lets a cached title replace the current live title', () => {
    const live = summary('live', { title: '刚修改的新名称', displayTitle: '刚修改的新名称' })
    const hydrated = overlayPersistedTitles(list(live), { live: '缓存中的旧名称' })
    expect(hydrated.byId[live.id]).toBe(live)
  })

  it('ignores cache rows that are absent from the current session list', () => {
    const raw = list(summary('present'))
    expect(overlayPersistedTitles(raw, { missing: 'Unused' })).toBe(raw)
  })
})

describe('decodePersistedTitles', () => {
  it('unwraps the sidebar response and keeps only non-empty string titles', () => {
    expect(decodePersistedTitles({
      ok: true,
      value: { titles: { one: '  First  ', two: '', three: 3 } },
    })).toEqual({ one: 'First' })
    expect(decodePersistedTitles({ titles: [] })).toEqual({})
  })
})
