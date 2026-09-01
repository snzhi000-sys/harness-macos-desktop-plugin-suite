/** Stage 3 contract for the unified Explorer/chat/plugin file-open router. */

import { afterEach, describe, expect, it } from 'vitest'
import './browser-globals.ts'

import type { Context } from '../src/context-types.ts'
import { planFileOpen, resolveProbedFileOpen } from '../src/client/file-open-router.ts'
import { openSidebarFile } from '../src/client/intercept.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { allLeaves, createSidebarStore } from '../src/client/state.ts'

function setup() {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  const viewer = (id: string, exts: string[], fetchStrategy: 'mediaUrl' | 'fsRead' | 'binary-download', priority = 0) => {
    service.registerFileViewer({ id, exts, fetchStrategy, priority, component: () => null })
  }
  viewer('image', ['png', 'jpg'], 'mediaUrl')
  viewer('pdf', ['pdf'], 'mediaUrl')
  viewer('docx', ['docx'], 'mediaUrl')
  viewer('xlsx', ['xlsx'], 'mediaUrl')
  viewer('pptx', ['pptx'], 'mediaUrl')
  viewer('video', ['mp4', 'm4v', 'webm', 'mov', 'ogv'], 'mediaUrl')
  viewer('markdown', ['md', 'markdown'], 'fsRead')
  viewer('html', ['html', 'htm'], 'fsRead')
  viewer('binary-download', ['doc', 'xls', 'ppt', 'mkv', 'avi'], 'binary-download', -50)
  viewer('code', [], 'fsRead', -100)
  service.registerTab({
    id: 'preview', title: 'Preview', hidden: true, dedupeKey: tab => tab.path, component: () => null,
  })
  store.setSession('s1')
  const ctx = {
    betterSidebar: service,
    sessions: { list: { getSnapshot: () => ({ current: 's1', byId: { s1: { cwd: '/work' } } }) } },
  } as unknown as Context
  return { store, service, ctx }
}

afterEach(() => {
  delete (window as Window & { __dshFileEdit?: unknown }).__dshFileEdit
})

describe('unified file-open planning matrix', () => {
  it.each([
    ['photo.png', 'image'],
    ['manual.pdf', 'pdf'],
    ['report.docx', 'docx'],
    ['data.xlsx', 'xlsx'],
    ['slides.pptx', 'pptx'],
    ['movie.mp4', 'video'],
    ['movie.m4v', 'video'],
    ['movie.webm', 'video'],
    ['movie.mov', 'video'],
    ['movie.ogv', 'video'],
  ])('routes %s to the right Preview with %s', (path, viewerId) => {
    const { service } = setup()
    expect(planFileOpen(service, `/work/${path}`)).toMatchObject({ target: 'preview', viewer: { id: viewerId } })
  })

  it.each([
    ['README.md', 'markdown'],
    ['page.html', 'html'],
  ])('keeps %s in the top-level file workspace', (path, viewerId) => {
    const { service } = setup()
    expect(planFileOpen(service, `/work/${path}`)).toMatchObject({ target: 'file-edit', viewer: { id: viewerId } })
  })

  it('probes catch-all code: text goes to file-edit and binary falls back', () => {
    const { service } = setup()
    const plan = planFileOpen(service, '/work/main.ts')
    expect(plan).toMatchObject({ target: 'probe', viewer: { id: 'code' } })
    expect(resolveProbedFileOpen(plan, 'text')).toMatchObject({ target: 'file-edit', viewer: { id: 'code' } })
    expect(resolveProbedFileOpen(plan, 'binary')).toEqual({ target: 'fallback', reason: 'binary' })
  })

  it('falls back when the declared PDF viewer is disabled instead of letting code claim it', () => {
    const { store, service } = setup()
    store.setPrefs({ ...store.getPrefs(), viewersEnabled: { pdf: false } })
    expect(planFileOpen(service, '/work/manual.pdf')).toEqual({ target: 'fallback', reason: 'preview-disabled' })
  })

  it('falls back without creating a tab when the Video viewer is disabled', () => {
    const { store, service } = setup()
    store.setPrefs({ ...store.getPrefs(), viewersEnabled: { video: false } })
    expect(planFileOpen(service, '/work/movie.mp4')).toEqual({ target: 'fallback', reason: 'preview-disabled' })
  })

  it.each(['legacy.doc', 'legacy.xls', 'legacy.ppt'])('keeps %s download/system-open only', (path) => {
    const { service } = setup()
    expect(planFileOpen(service, `/work/${path}`)).toEqual({ target: 'fallback', reason: 'download-only' })
  })

  it.each(['movie.mkv', 'movie.avi'])('keeps unsupported video %s on download/system-open fallback', (path) => {
    const { service } = setup()
    expect(planFileOpen(service, `/work/${path}`)).toEqual({ target: 'fallback', reason: 'download-only' })
  })
})

describe('unified file-open execution', () => {
  it('opens Preview formats in the right tree without touching file-edit', async () => {
    const { ctx, store } = setup()
    ;(window as Window & { __dshFileEdit?: unknown }).__dshFileEdit = { open: () => { throw new Error('must not open') } }
    await expect(openSidebarFile(ctx, store, 's1', 'photo.png', '/work')).resolves.toBe('preview')
    expect(allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)).toContainEqual(expect.objectContaining({
      type: 'preview', path: '/work/photo.png', viewerId: 'image',
    }))
  })

  it('opens video in Preview and stores viewerId without creating a Browser tab', async () => {
    const { ctx, store } = setup()
    await expect(openSidebarFile(ctx, store, 's1', 'movie.mp4', '/work')).resolves.toBe('preview')
    const tabs = allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
    expect(tabs).toContainEqual(expect.objectContaining({
      type: 'preview', title: 'movie.mp4', path: '/work/movie.mp4', viewerId: 'video',
    }))
    expect(tabs.some(tab => tab.type === 'browser')).toBe(false)
  })

  it('uses the explicit fallback for a disabled Video viewer without leaving an empty tab', async () => {
    const { ctx, store } = setup()
    store.setPrefs({ ...store.getPrefs(), viewersEnabled: { video: false } })
    let fallbackCalls = 0
    await expect(openSidebarFile(ctx, store, 's1', '/work/movie.mp4', '/work', {
      fallback: () => { fallbackCalls += 1 },
    })).resolves.toBe('fallback')
    expect(fallbackCalls).toBe(1)
    expect(allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)).toHaveLength(0)
  })

  it('opens probed text in dsh-file-edit and preserves session-relative addressing', async () => {
    const { ctx, store } = setup()
    const calls: unknown[] = []
    ;(window as Window & { __dshFileEdit?: unknown }).__dshFileEdit = { open: (request: unknown) => { calls.push(request) } }
    await expect(openSidebarFile(ctx, store, 's1', '/work/main.ts', '/work', { probe: async () => 'text' })).resolves.toBe('file-edit')
    expect(calls).toEqual([{ sessionId: 's1', cwd: '/work', absolutePath: '/work/main.ts', path: 'main.ts' }])
  })

  it('awaits an external artifact open and preserves its absolute target', async () => {
    const { ctx, store } = setup()
    const calls: unknown[] = []
    ;(window as Window & { __dshFileEdit?: unknown }).__dshFileEdit = {
      open: async (request: unknown) => { calls.push(request); return true },
    }
    await expect(openSidebarFile(ctx, store, 's1', '/tmp/generated.md', '/work')).resolves.toBe('file-edit')
    expect(calls).toEqual([{
      sessionId: 's1', cwd: '/work', absolutePath: '/tmp/generated.md', path: '/tmp/generated.md',
    }])
  })

  it('sends an external code file to the Host resolver without using the workspace-only probe', async () => {
    const { ctx, store } = setup()
    let opened = 0
    ;(window as Window & { __dshFileEdit?: unknown }).__dshFileEdit = {
      open: async () => { opened += 1; return true },
    }
    await expect(openSidebarFile(ctx, store, 's1', '/tmp/generated.ts', '/work')).resolves.toBe('file-edit')
    expect(opened).toBe(1)
  })

  it('falls back when dsh-file-edit rejects an external open', async () => {
    const { ctx, store } = setup()
    let fallbackCalls = 0
    ;(window as Window & { __dshFileEdit?: unknown }).__dshFileEdit = {
      open: async () => false,
    }
    await expect(openSidebarFile(ctx, store, 's1', '/tmp/missing.md', '/work', {
      fallback: () => { fallbackCalls += 1 },
    })).resolves.toBe('fallback')
    expect(fallbackCalls).toBe(1)
  })

  it('uses the explicit system fallback for a disabled Preview viewer', async () => {
    const { ctx, store } = setup()
    store.setPrefs({ ...store.getPrefs(), viewersEnabled: { pdf: false } })
    let fallbackCalls = 0
    await expect(openSidebarFile(ctx, store, 's1', '/work/manual.pdf', '/work', {
      fallback: async () => { fallbackCalls += 1 },
    })).resolves.toBe('fallback')
    expect(fallbackCalls).toBe(1)
    expect(allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)).toHaveLength(0)
  })

  it('falls back for an unknown binary after probing it', async () => {
    const { ctx, store } = setup()
    let fallbackCalls = 0
    await expect(openSidebarFile(ctx, store, 's1', '/work/blob.unknown', '/work', {
      probe: async () => 'binary',
      fallback: () => { fallbackCalls += 1 },
    })).resolves.toBe('fallback')
    expect(fallbackCalls).toBe(1)
  })
})
