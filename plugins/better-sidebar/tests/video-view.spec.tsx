// @vitest-environment jsdom

import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Context } from '../src/context-types.ts'
import { registerBuiltins } from '../src/client/builtins/index.ts'
import { PreviewHost } from '../src/client/preview.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { VideoView } from '../src/client/VideoView.tsx'
import { createSidebarStore } from '../src/client/state.ts'

describe('Video Preview component', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200, headers: { 'content-type': 'video/mp4' } })))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  })

  it('uses the streaming media URL with custom accessible controls and metadata-only preload', async () => {
    const mediaUrl = '/sidebar/file?sessionId=s1&path=%2Fwork%2Fmovie.mp4'
    act(() => {
      root.render(<VideoView
        ctx={{} as Context}
        store={createSidebarStore()}
        scope={{ sessionId: 's1', cwd: '/work' }}
        path="/work/movie.mp4"
        title="movie.mp4"
        viewerId="video"
        visible={true}
        mediaUrl={mediaUrl}
      />)
    })
    await act(async () => { await Promise.resolve() })
    const video = host.querySelector('video')
    expect(video).not.toBeNull()
    expect(video?.getAttribute('src')).toBe(mediaUrl)
    expect(video?.controls).toBe(false)
    expect(video?.playsInline).toBe(true)
    expect(video?.preload).toBe('metadata')
    expect(video?.autoplay).toBe(false)
    expect(video?.getAttribute('autoplay')).toBeNull()
    expect(host.querySelector('button[aria-label="播放"]')).not.toBeNull()
    expect(host.querySelector('input[aria-label="播放进度"]')).not.toBeNull()
    expect(host.querySelector('input[aria-label="音量"]')).not.toBeNull()
    expect(host.querySelector('select[aria-label="播放速度"]')).not.toBeNull()
    expect(host.querySelector('button[aria-label="进入全屏"]')).not.toBeNull()
  })

  it('switches to a clear error state when native playback loading fails', async () => {
    act(() => {
      root.render(<VideoView
        ctx={{} as Context}
        store={createSidebarStore()}
        scope={{ sessionId: 's1', cwd: '/work' }}
        path="/work/broken.mp4"
        title="broken.mp4"
        viewerId="video"
        visible={true}
        mediaUrl="/sidebar/file?broken=1"
      />)
    })
    await act(async () => { await Promise.resolve() })
    act(() => {
      host.querySelector('video')?.dispatchEvent(new Event('error', { bubbles: true }))
    })
    expect(host.querySelector('video')).toBeNull()
    expect(host.textContent).toContain('无法读取视频元数据')
  })

  it('does not mount a video source for a restored tab while the right panel is collapsed', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const ctx = { betterSidebar: service } as Context
    const dispose = registerBuiltins(ctx, service)
    store.setSession('restored')
    try {
      act(() => {
        root.render(<PreviewHost
          ctx={ctx}
          store={store}
          scope={{ sessionId: 'restored', cwd: '/work' }}
          tab={{
            id: 'preview:/work/movie.mp4',
            type: 'preview',
            title: 'movie.mp4',
            path: '/work/movie.mp4',
            viewerId: 'video',
          }}
          visible={false}
        />)
      })
      expect(host.querySelector('video')).not.toBeNull()
      expect(host.querySelector('[src*="/sidebar/file"]')).toBeNull()
    } finally {
      dispose()
    }
  })
})
