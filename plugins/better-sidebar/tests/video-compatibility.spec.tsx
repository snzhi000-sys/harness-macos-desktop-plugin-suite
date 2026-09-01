// @vitest-environment jsdom

import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Context } from '../src/context-types.ts'
import {
  classifyVideoHeadFailure,
  classifyVideoMediaFailure,
  VIDEO_METADATA_TIMEOUT_MS,
  VideoView,
} from '../src/client/VideoView.tsx'
import { createSidebarStore } from '../src/client/state.ts'

const MEDIA_URL = '/sidebar/file?sessionId=s1&path=%2Fwork%2Fmovie.mp4'

describe('Video compatibility and fallback diagnosis', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    host.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  })

  function renderPlayer() {
    act(() => {
      root.render(<VideoView
        ctx={{} as Context}
        store={createSidebarStore()}
        scope={{ sessionId: 's1', cwd: '/work' }}
        path="/work/movie.mp4"
        title="movie.mp4"
        viewerId="video"
        visible={true}
        mediaUrl={MEDIA_URL}
      />)
    })
  }

  it('maps machine-readable Host failures to distinct user-facing categories', () => {
    expect(classifyVideoHeadFailure(404, 'missing').kind).toBe('missing')
    expect(classifyVideoHeadFailure(413, 'too-large').kind).toBe('too-large')
    expect(classifyVideoHeadFailure(403, 'forbidden').kind).toBe('forbidden')
    expect(classifyVideoHeadFailure(416, 'range').kind).toBe('range')
    expect(classifyVideoHeadFailure(400, 'unreadable').kind).toBe('unreadable')
    expect(classifyVideoHeadFailure(503, null)).toEqual({ kind: 'network', detail: 'HTTP 503' })
  })

  it('uses MediaError and canPlayType without pretending codec damage is perfectly distinguishable', () => {
    expect(classifyVideoMediaFailure(1, 'maybe', false).kind).toBe('aborted')
    expect(classifyVideoMediaFailure(2, 'maybe', false).kind).toBe('network')
    expect(classifyVideoMediaFailure(3, 'probably', true).kind).toBe('decode')
    expect(classifyVideoMediaFailure(4, '', false).kind).toBe('container')
    expect(classifyVideoMediaFailure(4, 'maybe', false).kind).toBe('metadata')
    expect(classifyVideoMediaFailure(4, 'maybe', true).kind).toBe('decode')
  })

  it('preflights with HEAD, reports a missing file, and retries with a fresh player', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404, headers: { 'x-dsh-media-error': 'missing' } }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'content-type': 'video/mp4' } }))
    vi.stubGlobal('fetch', request)
    const canPlayType = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably')

    renderPlayer()
    await act(async () => { await Promise.resolve() })

    expect(request).toHaveBeenNthCalledWith(1, MEDIA_URL, expect.objectContaining({ method: 'HEAD', cache: 'no-store' }))
    expect(host.textContent).toContain('视频文件不存在')
    expect(host.querySelector('video')).toBeNull()

    await act(async () => {
      const retry = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '重试')!
      retry.click()
      await Promise.resolve()
    })

    expect(host.querySelector('video')).not.toBeNull()
    expect(request).toHaveBeenCalledTimes(2)
    expect(canPlayType).toHaveBeenCalledWith('video/mp4')
  })

  it('turns an endless initial metadata load into an actionable error', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200, headers: { 'content-type': 'video/mp4' } })))
    renderPlayer()
    await act(async () => { await Promise.resolve() })
    expect(host.querySelector('[role="status"]')).not.toBeNull()

    act(() => { vi.advanceTimersByTime(VIDEO_METADATA_TIMEOUT_MS) })

    expect(host.querySelector('video')).toBeNull()
    expect(host.textContent).toContain('无法读取视频元数据')
    expect(host.textContent).toContain('重试')
    expect(host.textContent).toContain('使用系统播放器打开')
    expect(host.querySelector('a[download]')).not.toBeNull()
  })

  it('reports an audio-only container instead of leaving a black video canvas', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200, headers: { 'content-type': 'video/mp4' } })))
    renderPlayer()
    await act(async () => { await Promise.resolve() })
    const video = host.querySelector('video')!
    Object.defineProperty(video, 'videoWidth', { value: 0, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: 0, configurable: true })
    act(() => { video.dispatchEvent(new Event('loadedmetadata', { bubbles: true })) })
    expect(host.querySelector('video')).toBeNull()
    expect(host.textContent).toContain('没有可显示的视频轨道')
  })
})
