/** Stage 1 contract for the independent media/document preview tab. */

import { describe, expect, it } from 'vitest'
import './browser-globals.ts'

import type { Context } from '../src/context-types.ts'
import { registerBuiltins } from '../src/client/builtins/index.ts'
import { previewTabIcon, previewViewerForPath, shouldMountPreviewContent, shouldOfferPreviewExpansion, tryOpenFilePreview } from '../src/client/preview.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, sanitizeState, type SidebarTab } from '../src/client/state.ts'

function setup() {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  const ctx = { betterSidebar: service } as Context
  const dispose = registerBuiltins(ctx, service)
  store.setSession('preview-session')
  return { ctx, store, service, dispose }
}

function previewTabs(store: ReturnType<typeof createSidebarStore>): SidebarTab[] {
  const state = store.getSnapshot().state!
  return allLeaves(state.splits).concat(allLeaves(state.bottomSplits))
    .flatMap(leaf => leaf.tabs)
    .filter(tab => tab.type === 'preview')
}

describe('independent preview tab', () => {
  it('opens a supported image with its absolute path, filename and viewer type', () => {
    const { ctx, store } = setup()
    expect(tryOpenFilePreview(ctx, store, 'preview-session', 'assets/photo.png', '/work')).toBe(true)
    expect(previewTabs(store)).toEqual([{
      id: 'preview:/work/assets/photo.png',
      type: 'preview',
      title: 'photo.png',
      path: '/work/assets/photo.png',
      viewerId: 'image',
    }])
    expect(allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs).some(tab => tab.type === 'browser')).toBe(false)
    expect(store.getSnapshot().state!.panelOpen).toBe(true)
  })

  it('focuses the same path instead of duplicating it and keeps distinct files separate', () => {
    const { ctx, store } = setup()
    expect(tryOpenFilePreview(ctx, store, 'preview-session', '/work/a.png', '/work')).toBe(true)
    expect(tryOpenFilePreview(ctx, store, 'preview-session', '/work/a.png', '/work')).toBe(true)
    expect(tryOpenFilePreview(ctx, store, 'preview-session', '/work/b.pdf', '/work')).toBe(true)
    const tabs = previewTabs(store)
    expect(tabs.map(tab => tab.path)).toEqual(['/work/a.png', '/work/b.pdf'])
    expect(tabs.map(tab => tab.viewerId)).toEqual(['image', 'pdf'])
    expect(allLeaves(store.getSnapshot().state!.splits).find(leaf => leaf.active === tabs[1]!.id)?.active).toBe(tabs[1]!.id)

    store.reduce(state => ({ ...state, panelOpen: false }))
    expect(tryOpenFilePreview(ctx, store, 'preview-session', '/work/a.png', '/work')).toBe(true)
    const focused = store.getSnapshot().state!
    expect(focused.panelOpen).toBe(true)
    expect(allLeaves(focused.splits).find(leaf => leaf.active === tabs[0]!.id)?.active).toBe(tabs[0]!.id)
  })

  it('dedupes one video path, keeps distinct videos separate, and never creates Browser', () => {
    const { ctx, store } = setup()
    expect(tryOpenFilePreview(ctx, store, 'preview-session', '/work/a.mp4', '/work')).toBe(true)
    expect(tryOpenFilePreview(ctx, store, 'preview-session', '/work/a.mp4', '/work')).toBe(true)
    expect(tryOpenFilePreview(ctx, store, 'preview-session', '/work/b.webm', '/work')).toBe(true)
    expect(previewTabs(store).map(tab => ({ path: tab.path, viewerId: tab.viewerId }))).toEqual([
      { path: '/work/a.mp4', viewerId: 'video' },
      { path: '/work/b.webm', viewerId: 'video' },
    ])
    expect(allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs).some(tab => tab.type === 'browser')).toBe(false)
  })

  it('coexists with Browser, image and PDF in the same right-tab tree', () => {
    const { ctx, store, service } = setup()
    tryOpenFilePreview(ctx, store, 'preview-session', '/work/movie.mp4', '/work')
    tryOpenFilePreview(ctx, store, 'preview-session', '/work/photo.png', '/work')
    tryOpenFilePreview(ctx, store, 'preview-session', '/work/manual.pdf', '/work')
    service.openTab({ type: 'browser', url: 'https://example.com/' })
    const tabs = allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
    expect(tabs.map(tab => tab.type)).toEqual(['preview', 'preview', 'preview', 'browser'])
    expect(tabs.filter(tab => tab.type === 'preview').map(tab => tab.viewerId)).toEqual(['video', 'image', 'pdf'])
  })

  it('offers manual expansion only for compact Office previews', () => {
    expect(shouldOfferPreviewExpansion('docx', 519)).toBe(true)
    expect(shouldOfferPreviewExpansion('xlsx', 400)).toBe(true)
    expect(shouldOfferPreviewExpansion('pptx', 300)).toBe(true)
    expect(shouldOfferPreviewExpansion('docx', 520)).toBe(false)
    expect(shouldOfferPreviewExpansion('image', 400)).toBe(false)
    expect(shouldOfferPreviewExpansion('pdf', 400)).toBe(false)
  })

  it('unmounts only inactive heavy Office content while keeping video lifecycle state', () => {
    for (const viewer of ['docx', 'xlsx', 'pptx']) {
      expect(shouldMountPreviewContent(viewer, false), viewer).toBe(false)
      expect(shouldMountPreviewContent(viewer, true), viewer).toBe(true)
    }
    for (const viewer of ['image', 'pdf', 'video']) {
      expect(shouldMountPreviewContent(viewer, false), viewer).toBe(true)
    }
  })

  it('refuses creation when the preview tab type is disabled', () => {
    const { ctx, store } = setup()
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { preview: false } })
    expect(tryOpenFilePreview(ctx, store, 'preview-session', '/work/a.png', '/work')).toBe(false)
    expect(previewTabs(store)).toHaveLength(0)
  })

  it('refuses creation when the matching viewer is disabled instead of falling through to code', () => {
    const { ctx, store } = setup()
    store.setPrefs({ ...store.getPrefs(), viewersEnabled: { image: false } })
    expect(tryOpenFilePreview(ctx, store, 'preview-session', '/work/a.png', '/work')).toBe(false)
    expect(previewTabs(store)).toHaveLength(0)
  })

  it('keeps code, Markdown, HTML and legacy Office out of the preview surface', () => {
    const { ctx, store, service } = setup()
    for (const path of ['/work/main.ts', '/work/README.md', '/work/index.html', '/work/legacy.doc']) {
      expect(previewViewerForPath(service, path), path).toBeUndefined()
      expect(tryOpenFilePreview(ctx, store, 'preview-session', path, '/work'), path).toBe(false)
    }
    expect(previewTabs(store)).toHaveLength(0)
  })

  it('uses the stored viewer icon for the tab strip', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileViewer({
      id: 'image',
      title: 'Image',
      icon: size => `image-icon-${size}`,
      exts: ['png'],
      fetchStrategy: 'mediaUrl',
      component: () => null,
    })
    const tab: SidebarTab = {
      id: 'preview:/work/a.png',
      type: 'preview',
      title: 'a.png',
      path: '/work/a.png',
      viewerId: 'image',
    }
    expect(previewTabIcon(service, tab, 14)).toBe('image-icon-14')
  })

  it('preserves the selected viewer type through persisted-state sanitization', () => {
    const { ctx, store } = setup()
    tryOpenFilePreview(ctx, store, 'preview-session', '/work/deck.pptx', '/work')
    const raw = JSON.parse(JSON.stringify(store.getSnapshot().state)) as unknown
    const restored = sanitizeState(raw)!
    const tab = allLeaves(restored.splits).flatMap(leaf => leaf.tabs).find(candidate => candidate.type === 'preview')
    expect(tab?.path).toBe('/work/deck.pptx')
    expect(tab?.viewerId).toBe('pptx')
  })

  it('persists the video viewer type through state sanitization', () => {
    const { ctx, store } = setup()
    tryOpenFilePreview(ctx, store, 'preview-session', '/work/movie.mp4', '/work')
    const restored = sanitizeState(JSON.parse(JSON.stringify(store.getSnapshot().state)) as unknown)!
    expect(allLeaves(restored.splits).flatMap(leaf => leaf.tabs)).toContainEqual(expect.objectContaining({
      type: 'preview', path: '/work/movie.mp4', viewerId: 'video',
    }))
  })
})
