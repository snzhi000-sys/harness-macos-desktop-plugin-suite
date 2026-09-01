// @vitest-environment jsdom

import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import type { Context } from '../src/context-types.ts'
import { VideoView } from '../src/client/VideoView.tsx'
import { createSidebarStore } from '../src/client/state.ts'

const MEDIA_URL = '/sidebar/file?sessionId=s1&path=%2Fwork%2Fmovie.mp4'

describe('Video Preview lifecycle', () => {
  let host: HTMLDivElement
  let root: Root
  let pauseSpy: MockInstance
  let loadSpy: MockInstance
  let playSpy: MockInstance

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
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

  async function renderVideo(visible: boolean, path = '/work/movie.mp4', mediaUrl = MEDIA_URL) {
    act(() => {
      root.render(<VideoView
        ctx={{} as Context}
        store={createSidebarStore()}
        scope={{ sessionId: 's1', cwd: '/work' }}
        path={path}
        title={path.slice(path.lastIndexOf('/') + 1)}
        viewerId="video"
        visible={visible}
        mediaUrl={mediaUrl}
      />)
    })
    await act(async () => { await Promise.resolve() })
  }

  it('keeps a restored hidden player source-free until its first activation', async () => {
    await renderVideo(false)
    const video = host.querySelector('video')
    expect(video).not.toBeNull()
    expect(video?.getAttribute('src')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()

    await renderVideo(true)
    expect(host.querySelector('video')).toBe(video)
    expect(video?.getAttribute('src')).toBe(MEDIA_URL)
    expect(fetch).toHaveBeenCalledWith(MEDIA_URL, expect.objectContaining({ method: 'HEAD' }))
    expect(playSpy).not.toHaveBeenCalled()
  })

  it('pauses on hide, preserves the source and playback time, and never auto-resumes', async () => {
    await renderVideo(true)
    const video = host.querySelector('video')!
    video.currentTime = 42
    pauseSpy.mockClear()

    await renderVideo(false)
    expect(host.querySelector('video')).toBe(video)
    expect(pauseSpy.mock.contexts).toContain(video)
    expect(video.getAttribute('src')).toBe(MEDIA_URL)
    expect(video.currentTime).toBe(42)

    playSpy.mockClear()
    await renderVideo(true)
    expect(host.querySelector('video')).toBe(video)
    expect(video.currentTime).toBe(42)
    expect(playSpy).not.toHaveBeenCalled()
  })

  it('clears the media source and reloads the element when the tab closes', async () => {
    await renderVideo(true)
    const video = host.querySelector('video')!
    pauseSpy.mockClear()
    loadSpy.mockClear()

    act(() => { root.render(null) })

    expect(pauseSpy.mock.contexts).toContain(video)
    expect(loadSpy.mock.contexts).toContain(video)
    expect(video.getAttribute('src')).toBeNull()
  })

  it('performs the same cleanup when a session switch unmounts the old preview', async () => {
    await renderVideo(true)
    const oldVideo = host.querySelector('video')!
    pauseSpy.mockClear()
    loadSpy.mockClear()

    act(() => { root.render(<div data-session="next" />) })

    expect(pauseSpy.mock.contexts).toContain(oldVideo)
    expect(loadSpy.mock.contexts).toContain(oldVideo)
    expect(oldVideo.getAttribute('src')).toBeNull()
  })

  it('pauses every other mounted Preview when one video starts playing', async () => {
    act(() => {
      root.render(<>
        <VideoView
          ctx={{} as Context}
          store={createSidebarStore()}
          scope={{ sessionId: 's1', cwd: '/work' }}
          path="/work/a.mp4"
          title="a.mp4"
          viewerId="video"
          visible={true}
          mediaUrl="/sidebar/file?a"
        />
        <VideoView
          ctx={{} as Context}
          store={createSidebarStore()}
          scope={{ sessionId: 's1', cwd: '/work' }}
          path="/work/b.mp4"
          title="b.mp4"
          viewerId="video"
          visible={true}
          mediaUrl="/sidebar/file?b"
        />
      </>)
    })
    await act(async () => { await Promise.resolve() })
    const [first, second] = Array.from(host.querySelectorAll('video'))
    pauseSpy.mockClear()

    act(() => { second!.dispatchEvent(new Event('play', { bubbles: true })) })

    expect(pauseSpy.mock.contexts).toContain(first)
    expect(pauseSpy.mock.contexts).not.toContain(second)
  })
})
