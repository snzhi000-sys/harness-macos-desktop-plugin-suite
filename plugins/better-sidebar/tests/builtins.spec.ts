/**
 * Built-in registration tests: the plugin registers 8 tabs and 10 file
 * viewers through the same service external plugins use (dogfooding);
 * the catch-all `code` viewer, the NUL-sniffing `binary-download` viewer,
 * and the HTML sandbox / Browser link settings pin the registry's behavior.
 */
import { describe, expect, it } from 'vitest'
// First import: browser globals before the xterm-carrying builtin graph loads.
import './browser-globals.ts'

import type { Context } from '../src/context-types.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { allLeaves } from '../src/client/state.ts'
import { registerBuiltins } from '../src/client/builtins/index.ts'

function setup(): { service: ReturnType<typeof createBetterSidebarService>; store: ReturnType<typeof createSidebarStore>; dispose: () => void } {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  const dispose = registerBuiltins({} as Context, service)
  return { service, store, dispose }
}

describe('built-in tab registrations', () => {
  it('registers the 8 built-in tabs', () => {
    const { service } = setup()
    expect(service.getTabs().map(t => t.id).sort()).toEqual(
      ['browser', 'diff', 'editor', 'explorer', 'git', 'preview', 'subagent', 'terminal'],
    )
  })

  it('editor, preview, diff and explorer are hidden from the + menu (opened by derived flows)', () => {
    const { service } = setup()
    expect(service.getTabs().filter(t => t.hidden).map(t => t.id).sort()).toEqual(['diff', 'editor', 'explorer', 'preview'])
  })

  it('preview is independent from editor and dedupes by file path', () => {
    const { service } = setup()
    const preview = service.getTab('preview')
    expect(preview?.hidden).toBe(true)
    expect(preview?.dedupeKey?.({ id: 'p1', type: 'preview', title: 'a.png', path: '/w/a.png', viewerId: 'image' })).toBe('/w/a.png')
    expect(service.getTab('editor')).not.toBe(preview)
  })

  it('single-instance tabs use the single sugar', () => {
    const { service } = setup()
    for (const id of ['explorer', 'git', 'subagent']) {
      expect(service.getTab(id)?.single).toBe(true)
    }
  })

  it('the subagent tab declares its auto-open related settings', () => {
    const { service } = setup()
    const toggles = service.getTab('subagent')?.settings?.toggles ?? []
    expect(toggles.map(t => t.key)).toEqual(['autoOpenSubagent', 'autoOpenJobs'])
  })

  it('the terminal tab declares the model terminal-tools related setting', () => {
    const { service } = setup()
    const toggles = service.getTab('terminal')?.settings?.toggles ?? []
    expect(toggles.map(t => t.key)).toEqual(['agentTerminalTools', 'bottomPanelAutoTerminal'])
  })

  it('the browser tab declares only its link-takeover related setting', () => {
    const { service } = setup()
    const toggles = service.getTab('browser')?.settings?.toggles ?? []
    expect(toggles.map(t => t.key)).toEqual(['browserInterceptLinks'])
    expect(toggles[0]?.title).toBeDefined()
    expect(toggles[0]?.desc).toBeDefined()
  })

  it('the browser createTab has no three-tab quota and keeps minting browser:<n>', () => {
    const { service, store } = setup()
    store.setSession('s1')
    for (let index = 0; index < 12; index += 1) service.openTab({ type: 'browser' })
    const state = store.getSnapshot().state!
    const tabs = allLeaves(state.splits).flatMap(leaf => leaf.tabs).filter(t => t.type === 'browser')
    expect(tabs).toHaveLength(12)
    expect(tabs[0]!.id).toBe('browser:1')
    expect(tabs[11]!.id).toBe('browser:12')
    expect(state.nextBrowser).toBe(13)
  })

  it('every built-in tab carries the settings-surface icon', () => {
    const { service } = setup()
    for (const tab of service.getTabs()) {
      expect(tab.icon, tab.id).toBeDefined()
    }
  })
})

describe('built-in file viewer registrations', () => {
  it('registers the 10 built-in file viewers', () => {
    const { service } = setup()
    expect(service.getFileViewers().map(v => v.id).sort()).toEqual(
      ['binary-download', 'code', 'docx', 'html', 'image', 'markdown', 'pdf', 'pptx', 'video', 'xlsx'],
    )
  })

  it('registers the streaming video viewer and keeps unsupported containers on fallback', () => {
    const { service } = setup()
    const video = service.getFileViewers().find(v => v.id === 'video')
    expect(video).toMatchObject({
      exts: ['mp4', 'm4v', 'webm', 'mov', 'ogv'],
      fetchStrategy: 'mediaUrl',
    })
    for (const ext of ['mp4', 'm4v', 'webm', 'mov', 'ogv']) {
      expect(service.matchFileViewer(`movie.${ext}`)?.id, ext).toBe('video')
    }
    expect(service.matchFileViewer('movie.mkv')?.id).toBe('binary-download')
    expect(service.matchFileViewer('movie.avi')?.id).toBe('binary-download')
  })

  it('code is the catch-all at the lowest priority', () => {
    const { service } = setup()
    const code = service.getFileViewers().find(v => v.id === 'code')
    expect(code?.exts).toEqual([])
    expect(code?.priority).toBe(-100)
    expect(code?.fetchStrategy).toBe('fsRead')
    expect(service.matchFileViewer('anything.zzz')?.id).toBe('code')
  })

  it('markdown claims md/markdown before the catch-all', () => {
    const { service } = setup()
    expect(service.matchFileViewer('readme.md')?.id).toBe('markdown')
    expect(service.matchFileViewer('readme.markdown')?.id).toBe('markdown')
    expect(service.matchFileViewer('readme.md', new Uint8Array([0x61]))?.id).toBe('markdown')
  })

  it('html claims html/htm before the catch-all', () => {
    const { service } = setup()
    expect(service.matchFileViewer('index.html')?.id).toBe('html')
    expect(service.matchFileViewer('page.htm')?.id).toBe('html')
    expect(service.matchFileViewer('index.html', new Uint8Array([0x3c, 0x21]))?.id).toBe('html')
    expect(service.matchFileViewer('index.HTML')?.id).toBe('html')
  })

  it('the html viewer declares its sandbox and default-unsafe related settings', () => {
    const { service } = setup()
    const toggles = service.getFileViewers().find(v => v.id === 'html')?.settings?.toggles ?? []
    expect(toggles.map(t => t.key)).toEqual(['htmlViewerNoSandbox', 'htmlViewerDefaultUnsafe'])
    expect(toggles[0]?.title).toBeDefined()
    expect(toggles[0]?.desc).toBeDefined()
    expect(toggles[1]?.title).toBeDefined()
    expect(toggles[1]?.desc).toBeDefined()
  })

  it('binary-download claims legacy office by extension', () => {
    const { service } = setup()
    expect(service.matchFileViewer('old.doc')?.id).toBe('binary-download')
    expect(service.matchFileViewer('old.xls')?.id).toBe('binary-download')
    expect(service.matchFileViewer('old.ppt')?.id).toBe('binary-download')
  })

  it('binary-download NUL detect claims unknown-extension binaries over code', () => {
    const { service } = setup()
    // First match (no head) falls to the catch-all code viewer...
    expect(service.matchFileViewer('blob.zzz')?.id).toBe('code')
    // ...but the head re-match (NUL probe) routes it to binary-download.
    expect(service.matchFileViewer('blob.zzz', new Uint8Array([0x01, 0x00, 0x02]))?.id).toBe('binary-download')
    // A NUL-free blob stays with code.
    expect(service.matchFileViewer('blob.zzz', new Uint8Array([0x61, 0x62]))?.id).toBe('code')
  })

  it('office mediaUrl viewers beat the binary sniffers for their own extensions', () => {
    const { service } = setup()
    // A .docx is a zip (no NUL in its head): the docx viewer (priority 0)
    // claims it before binary-download (-50) is consulted.
    expect(service.matchFileViewer('book.docx', new Uint8Array([0x50, 0x4b, 0x03, 0x04]))?.id).toBe('docx')
  })

  it('every built-in viewer carries the declarative settings surface (title + icon)', () => {
    const { service } = setup()
    for (const viewer of service.getFileViewers()) {
      expect(viewer.title, viewer.id).toBeDefined()
      expect(viewer.icon, viewer.id).toBeDefined()
    }
  })
})

describe('built-in disposer', () => {
  it('unregisters everything (HMR-safe)', () => {
    const { service, dispose } = setup()
    dispose()
    expect(service.getTabs()).toHaveLength(0)
    expect(service.getFileViewers()).toHaveLength(0)
    // The disposer is idempotent.
    dispose()
  })
})
