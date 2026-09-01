// @vitest-environment jsdom

import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import type { Context } from '../src/context-types.ts'
import { api } from '../src/client/api.ts'
import { formatVideoTime, VideoView } from '../src/client/VideoView.tsx'
import { createSidebarStore } from '../src/client/state.ts'

const MEDIA_URL = '/sidebar/file?sessionId=s1&path=%2Fwork%2Fmovie.mp4'

describe('Harness video controls', () => {
  let host: HTMLDivElement
  let root: Root
  let playSpy: MockInstance
  let pauseSpy: MockInstance
  let fullscreenSpy: MockInstance
  let pictureInPictureSpy: MockInstance

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
    playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    fullscreenSpy = vi.fn(async () => {})
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { value: fullscreenSpy, configurable: true })
    Object.defineProperty(document, 'exitFullscreen', { value: vi.fn(async () => {}), configurable: true })
    pictureInPictureSpy = vi.fn(async () => ({}))
    Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', { value: pictureInPictureSpy, configurable: true })
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
    delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestPictureInPicture
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  })

  async function renderPlayer() {
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
    await act(async () => { await Promise.resolve() })
    const video = host.querySelector('video')!
    Object.defineProperty(video, 'duration', { value: 120, configurable: true })
    Object.defineProperty(video, 'videoWidth', { value: 1920, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: 1080, configurable: true })
    Object.defineProperty(video, 'buffered', {
      value: { length: 1, start: () => 0, end: () => 80 },
      configurable: true,
    })
    act(() => { video.dispatchEvent(new Event('loadedmetadata', { bubbles: true })) })
    return video
  }

  it('formats short and long media durations', () => {
    expect(formatVideoTime(0)).toBe('0:00')
    expect(formatVideoTime(65.9)).toBe('1:05')
    expect(formatVideoTime(3661)).toBe('1:01:01')
    expect(formatVideoTime(Number.NaN)).toBe('0:00')
  })

  it('exposes play, timeline, buffer, volume, speed, PiP and fullscreen controls', async () => {
    const video = await renderPlayer()
    const speed = host.querySelector('select[aria-label="播放速度"]') as HTMLSelectElement
    expect(Array.from(speed.options).map(option => option.textContent)).toEqual(['0.5×', '0.75×', '1×', '1.25×', '1.5×', '2×'])
    expect(host.querySelector('button[aria-label="进入画中画"]')?.hasAttribute('disabled')).toBe(false)
    expect(host.querySelector('button[aria-label="进入全屏"]')).not.toBeNull()
    expect(host.querySelector('input[aria-label="播放进度"]')?.getAttribute('aria-valuetext')).toBe('0:00 / 2:00')
    expect(host.querySelector('[class*="videoBufferedTrack"]')?.getAttribute('style')).toContain('66.666')

    act(() => { (host.querySelector('button[aria-label="播放"]') as HTMLButtonElement).click() })
    expect(playSpy.mock.contexts).toContain(video)
    act(() => { video.dispatchEvent(new Event('play', { bubbles: true })) })
    expect(host.querySelector('button[aria-label="暂停"]')).not.toBeNull()
    Object.defineProperty(video, 'paused', { value: false, configurable: true })
    pauseSpy.mockClear()
    act(() => { (host.querySelector('button[aria-label="暂停"]') as HTMLButtonElement).click() })
    expect(pauseSpy.mock.contexts).toContain(video)

    const timeline = host.querySelector('input[aria-label="播放进度"]') as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(timeline, '70')
    act(() => { timeline.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(video.currentTime).toBe(70)

    const volume = host.querySelector('input[aria-label="音量"]') as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(volume, '0.4')
    act(() => { volume.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(video.volume).toBe(0.4)

    speed.value = '1.5'
    act(() => { speed.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(video.playbackRate).toBe(1.5)

    act(() => { (host.querySelector('button[aria-label="进入画中画"]') as HTMLButtonElement).click() })
    expect(pictureInPictureSpy.mock.contexts).toContain(video)
  })

  it('seeks and adjusts audio with local keyboard shortcuts only', async () => {
    const video = await renderPlayer()
    video.currentTime = 30
    const frame = host.querySelector('[tabindex="0"]')!

    act(() => { frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(video.currentTime).toBe(35)
    act(() => { frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })) })
    expect(video.currentTime).toBe(25)
    act(() => { frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(video.volume).toBe(1)
    act(() => { frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true })) })
    expect(video.muted).toBe(true)

    const seek = host.querySelector('input[aria-label="播放进度"]')!
    act(() => { seek.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(video.currentTime).toBe(25)
    act(() => { frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, isComposing: true })) })
    expect(video.currentTime).toBe(25)
  })

  it('supports fullscreen by button, keyboard and double click without global listeners', async () => {
    await renderPlayer()
    act(() => { (host.querySelector('button[aria-label="进入全屏"]') as HTMLButtonElement).click() })
    expect(fullscreenSpy).toHaveBeenCalledTimes(1)
    act(() => { host.querySelector('[tabindex="0"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true })) })
    expect(fullscreenSpy).toHaveBeenCalledTimes(2)
    act(() => { host.querySelector('video')!.parentElement!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(fullscreenSpy).toHaveBeenCalledTimes(3)
  })

  it('shows loading state separately and removes it when native playback can continue', async () => {
    const video = await renderPlayer()
    expect(host.querySelector('[role="status"][aria-label="视频缓冲中"]')).not.toBeNull()
    act(() => { video.dispatchEvent(new Event('canplay', { bubbles: true })) })
    expect(host.querySelector('[role="status"][aria-label="视频缓冲中"]')).toBeNull()
    act(() => { video.dispatchEvent(new Event('waiting', { bubbles: true })) })
    expect(host.querySelector('[role="status"][aria-label="视频缓冲中"]')).not.toBeNull()
  })

  it('offers system-player and download actions after a decode failure', async () => {
    const video = await renderPlayer()
    act(() => { video.dispatchEvent(new Event('error', { bubbles: true })) })
    const open = vi.spyOn(api, 'fsOpen').mockResolvedValue({ ok: true })
    const button = Array.from(host.querySelectorAll('button')).find(candidate => candidate.textContent === '使用系统播放器打开')!
    await act(async () => { button.click() })
    expect(open).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/work' }, '/work/movie.mp4')
    const download = host.querySelector('a[download]')
    expect(download?.getAttribute('href')).toContain('download=1')
  })
})
