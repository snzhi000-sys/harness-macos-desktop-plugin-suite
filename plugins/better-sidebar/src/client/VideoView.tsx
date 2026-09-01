/** Harness-styled native Chromium video player backed by the Host Range URL. */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api, downloadUrl } from './api.ts'
import type { FileViewerProps } from './service.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
export const VIDEO_METADATA_TIMEOUT_MS = 20_000
const players = new Set<HTMLVideoElement>()

export type VideoFailureKind =
  | 'missing'
  | 'too-large'
  | 'forbidden'
  | 'network'
  | 'range'
  | 'container'
  | 'decode'
  | 'no-video-track'
  | 'metadata'
  | 'unreadable'
  | 'aborted'

export interface VideoFailure { kind: VideoFailureKind; detail?: string }

type PictureInPictureVideo = HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }
type PictureInPictureDocument = Document & {
  pictureInPictureElement?: Element | null
  pictureInPictureEnabled?: boolean
  exitPictureInPicture?: () => Promise<void>
}

export function classifyVideoHeadFailure(status: number, marker: string | null): VideoFailure {
  if (marker === 'missing' || status === 404) return { kind: 'missing' }
  if (marker === 'too-large' || status === 413) return { kind: 'too-large' }
  if (marker === 'forbidden' || status === 403) return { kind: 'forbidden' }
  if (marker === 'range' || status === 416) return { kind: 'range' }
  if (marker === 'unreadable') return { kind: 'unreadable' }
  return { kind: 'network', detail: `HTTP ${status}` }
}

export function classifyVideoMediaFailure(code: number | undefined, canPlayType: CanPlayTypeResult, metadataReady: boolean): VideoFailure {
  if (code === 1) return { kind: 'aborted' }
  if (code === 2) return { kind: 'network' }
  if (code === 3) return { kind: 'decode' }
  if (code === 4 && canPlayType === '') return { kind: 'container' }
  if (code === 4) return { kind: metadataReady ? 'decode' : 'metadata' }
  return { kind: metadataReady ? 'decode' : 'metadata' }
}

function releasePlayer(player: HTMLVideoElement): void {
  players.delete(player)
  player.pause()
  player.removeAttribute('src')
  player.load()
}

export function formatVideoTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea, select, button, a, [contenteditable="true"]') !== null
}

function PlayIcon({ playing }: { playing: boolean }) {
  return playing
    ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3.25h2.25v9.5H4.5zm4.75 0h2.25v9.5H9.25z" fill="currentColor" /></svg>
    : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3.25 7.25 4.75L5 12.75z" fill="currentColor" /></svg>
}

function VolumeIcon({ muted }: { muted: boolean }) {
  return <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2.5 6h2.25L8 3.5v9L4.75 10H2.5z" fill="currentColor" />
    {muted
      ? <path d="m10.25 6 3.25 4m0-4-3.25 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      : <path d="M10.25 5.25c1.65 1.5 1.65 4 0 5.5M12 3.75c2.6 2.3 2.6 6.2 0 8.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />}
  </svg>
}

function FullscreenIcon({ active }: { active: boolean }) {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path
    d={active ? 'M6 2.5v3.25H2.75M10 2.5v3.25h3.25M6 13.5v-3.25H2.75M10 13.5v-3.25h3.25' : 'M6 2.5H2.75v3.25M10 2.5h3.25v3.25M6 13.5H2.75v-3.25M10 13.5h3.25v-3.25'}
    fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
  /></svg>
}

function PictureInPictureIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.25" /><rect x="7.5" y="7.25" width="5" height="3.75" rx=".75" fill="currentColor" /></svg>
}

function NativeVideoPlayer(props: { mediaUrl?: string; title: string; visible: boolean; onError: (failure: VideoFailure) => void }) {
  const { mediaUrl, title, visible, onError } = props
  const playerRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const metadataReadyRef = useRef(false)
  const canPlayTypeRef = useRef<CanPlayTypeResult>('')
  const [validatedUrl, setValidatedUrl] = useState<string>()
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(mediaUrl !== undefined)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  const [pictureInPicture, setPictureInPicture] = useState(false)

  useEffect(() => {
    const player = playerRef.current
    if (player === null) return
    players.add(player)
    return () => { releasePlayer(player) }
  }, [])

  useEffect(() => {
    setLoading(mediaUrl !== undefined)
    setCurrentTime(0)
    setDuration(0)
    setBuffered(0)
    setValidatedUrl(undefined)
    metadataReadyRef.current = false
    canPlayTypeRef.current = ''
  }, [mediaUrl])

  useEffect(() => {
    if (mediaUrl === undefined) return
    const controller = new AbortController()
    let active = true
    void fetch(mediaUrl, { method: 'HEAD', signal: controller.signal, cache: 'no-store' }).then((response) => {
      if (!active) return
      if (!response.ok) {
        onError(classifyVideoHeadFailure(response.status, response.headers.get('x-dsh-media-error')))
        return
      }
      const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
      if (mime !== undefined && mime !== '') canPlayTypeRef.current = playerRef.current?.canPlayType(mime) ?? ''
      setValidatedUrl(mediaUrl)
    }).catch((error: unknown) => {
      if (active && !controller.signal.aborted) onError({ kind: 'network', detail: error instanceof Error ? error.message : String(error) })
    })
    return () => { active = false; controller.abort() }
  }, [mediaUrl, onError])

  useEffect(() => {
    if (validatedUrl === undefined) return
    const timer = window.setTimeout(() => {
      if (!metadataReadyRef.current) onError({ kind: 'metadata' })
    }, VIDEO_METADATA_TIMEOUT_MS)
    return () => { window.clearTimeout(timer) }
  }, [validatedUrl, onError])

  useEffect(() => {
    if (!visible) playerRef.current?.pause()
  }, [visible])

  useEffect(() => {
    const update = () => { setFullscreen(document.fullscreenElement === frameRef.current) }
    document.addEventListener('fullscreenchange', update)
    return () => { document.removeEventListener('fullscreenchange', update) }
  }, [])

  useEffect(() => {
    const player = playerRef.current
    if (player === null) return
    const enter = () => { setPictureInPicture(true) }
    const leave = () => { setPictureInPicture(false) }
    player.addEventListener('enterpictureinpicture', enter)
    player.addEventListener('leavepictureinpicture', leave)
    return () => {
      player.removeEventListener('enterpictureinpicture', enter)
      player.removeEventListener('leavepictureinpicture', leave)
    }
  }, [])

  const updateTimeline = useCallback(() => {
    const player = playerRef.current
    if (player === null) return
    setCurrentTime(Number.isFinite(player.currentTime) ? player.currentTime : 0)
    setDuration(Number.isFinite(player.duration) ? player.duration : 0)
    const last = player.buffered.length > 0 ? player.buffered.end(player.buffered.length - 1) : 0
    setBuffered(Number.isFinite(last) ? last : 0)
  }, [])

  const handlePlay = useCallback(() => {
    const current = playerRef.current
    if (current === null) return
    for (const player of players) if (player !== current) player.pause()
    setPlaying(true)
    setLoading(false)
  }, [])

  const togglePlay = useCallback(() => {
    const player = playerRef.current
    if (player === null || validatedUrl === undefined) return
    if (player.paused) void player.play().catch((error: unknown) => { onError({ kind: 'decode', detail: error instanceof Error ? error.message : String(error) }) })
    else player.pause()
  }, [validatedUrl, onError])

  const seekBy = useCallback((seconds: number) => {
    const player = playerRef.current
    if (player === null || !Number.isFinite(player.duration)) return
    player.currentTime = Math.min(player.duration, Math.max(0, player.currentTime + seconds))
    updateTimeline()
  }, [updateTimeline])

  const changeVolume = useCallback((next: number) => {
    const player = playerRef.current
    if (player === null) return
    player.volume = Math.min(1, Math.max(0, next))
    if (player.volume > 0) player.muted = false
    setVolume(player.volume)
    setMuted(player.muted)
  }, [])

  const toggleMute = useCallback(() => {
    const player = playerRef.current
    if (player === null) return
    player.muted = !player.muted
    setMuted(player.muted)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const frame = frameRef.current
    if (frame === null) return
    if (document.fullscreenElement === frame) void document.exitFullscreen().catch(() => {})
    else void frame.requestFullscreen().catch(() => {})
  }, [])

  const togglePictureInPicture = useCallback(() => {
    const player = playerRef.current as PictureInPictureVideo | null
    if (player === null) return
    const pipDocument = document as PictureInPictureDocument
    if (pipDocument.pictureInPictureElement === player) void pipDocument.exitPictureInPicture?.().catch(() => {})
    else void player.requestPictureInPicture?.().catch(() => {})
  }, [])

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || isInteractiveTarget(event.target)) return
    let handled = true
    switch (event.key.toLowerCase()) {
      case ' ':
      case 'spacebar': togglePlay(); break
      case 'arrowleft': seekBy(-5); break
      case 'arrowright': seekBy(5); break
      case 'j': seekBy(-10); break
      case 'l': seekBy(10); break
      case 'arrowup': changeVolume(volume + 0.05); break
      case 'arrowdown': changeVolume(volume - 0.05); break
      case 'm': toggleMute(); break
      case 'f': toggleFullscreen(); break
      default: handled = false
    }
    if (handled) event.preventDefault()
  }, [changeVolume, seekBy, toggleFullscreen, toggleMute, togglePlay, volume])

  const progress = duration > 0 ? Math.min(100, currentTime / duration * 100) : 0
  const bufferedProgress = duration > 0 ? Math.min(100, buffered / duration * 100) : 0
  const pipDocument = document as PictureInPictureDocument
  const pipSupported = pipDocument.pictureInPictureEnabled !== false
    && typeof (playerRef.current as PictureInPictureVideo | null)?.requestPictureInPicture === 'function'

  return <div ref={frameRef} className={css.videoFrame} tabIndex={0} onKeyDown={handleKeyDown} aria-label={t('videoPlayer', { title })}>
    <div className={css.videoStage} onDoubleClick={toggleFullscreen}>
      <video
        ref={playerRef}
        className={css.videoPlayer}
        src={validatedUrl}
        aria-label={title}
        controls={false}
        playsInline
        preload="metadata"
        onLoadedMetadata={() => {
          const player = playerRef.current
          metadataReadyRef.current = true
          if (player !== null && player.videoWidth === 0 && player.videoHeight === 0) {
            onError({ kind: 'no-video-track' })
            return
          }
          updateTimeline()
        }}
        onDurationChange={updateTimeline}
        onTimeUpdate={updateTimeline}
        onProgress={updateTimeline}
        onPlay={handlePlay}
        onPlaying={() => { setPlaying(true); setLoading(false) }}
        onPause={() => { setPlaying(false) }}
        onWaiting={() => { setLoading(true) }}
        onStalled={() => { setLoading(true) }}
        onCanPlay={() => { setLoading(false) }}
        onVolumeChange={() => {
          const player = playerRef.current
          if (player !== null) { setVolume(player.volume); setMuted(player.muted) }
        }}
        onRateChange={() => { setPlaybackRate(playerRef.current?.playbackRate ?? 1) }}
        onError={() => { onError(classifyVideoMediaFailure(playerRef.current?.error?.code, canPlayTypeRef.current, metadataReadyRef.current)) }}
      />
      {loading && mediaUrl !== undefined && <div className={css.videoLoading} role="status" aria-label={t('videoLoading')}><span /></div>}
    </div>
    <div className={css.videoControls}>
      <div className={css.videoTimelineRow}>
        <span className={css.videoBufferedTrack} style={{ width: `${bufferedProgress}%` }} aria-hidden="true" />
        <span className={css.videoPlayedTrack} style={{ width: `${progress}%` }} aria-hidden="true" />
        <input className={css.videoTimeline} type="range" min={0} max={duration || 0} step="any" value={Math.min(currentTime, duration || 0)} disabled={duration <= 0} aria-label={t('videoSeek')} aria-valuetext={`${formatVideoTime(currentTime)} / ${formatVideoTime(duration)}`} onChange={(event) => {
          const player = playerRef.current
          if (player === null) return
          player.currentTime = Number(event.currentTarget.value)
          updateTimeline()
        }} />
      </div>
      <div className={css.videoControlRow}>
        <button type="button" className={css.videoControlButton} onClick={togglePlay} aria-label={playing ? t('videoPause') : t('videoPlay')}><PlayIcon playing={playing} /></button>
        <span className={css.videoTime}>{formatVideoTime(currentTime)} / {formatVideoTime(duration)}</span>
        <span className={css.videoControlSpacer} />
        <button type="button" className={css.videoControlButton} onClick={toggleMute} aria-label={muted ? t('videoUnmute') : t('videoMute')}><VolumeIcon muted={muted || volume === 0} /></button>
        <input className={css.videoVolume} type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label={t('videoVolume')} onChange={(event) => { changeVolume(Number(event.currentTarget.value)) }} />
        <select className={css.videoRate} value={playbackRate} aria-label={t('videoSpeed')} onChange={(event) => {
          const player = playerRef.current
          if (player === null) return
          player.playbackRate = Number(event.currentTarget.value)
          setPlaybackRate(player.playbackRate)
        }}>
          {PLAYBACK_RATES.map(rate => <option key={rate} value={rate}>{rate}×</option>)}
        </select>
        <button type="button" className={css.videoControlButton} disabled={!pipSupported} onClick={togglePictureInPicture} aria-label={pictureInPicture ? t('videoExitPip') : t('videoPip')}><PictureInPictureIcon /></button>
        <button type="button" className={css.videoControlButton} onClick={toggleFullscreen} aria-label={fullscreen ? t('videoExitFullscreen') : t('videoFullscreen')}><FullscreenIcon active={fullscreen} /></button>
      </div>
    </div>
  </div>
}

function videoFailureMessage(failure: VideoFailure): string {
  switch (failure.kind) {
    case 'missing': return t('videoErrorMissing')
    case 'too-large': return t('videoErrorTooLarge')
    case 'forbidden': return t('videoErrorForbidden')
    case 'network': return t('videoErrorNetwork')
    case 'range': return t('videoErrorRange')
    case 'container': return t('videoErrorContainer')
    case 'decode': return t('videoErrorDecode')
    case 'no-video-track': return t('videoErrorNoVideoTrack')
    case 'metadata': return t('videoErrorMetadata')
    case 'unreadable': return t('videoErrorUnreadable')
    case 'aborted': return t('videoErrorAborted')
  }
}

function VideoError(props: Pick<FileViewerProps, 'scope' | 'path'> & { failure: VideoFailure; onRetry: () => void }) {
  const { scope, path, failure, onRetry } = props
  const [openError, setOpenError] = useState<string>()
  return <div className={css.videoError} role="alert">
    <strong>{videoFailureMessage(failure)}</strong>
    {failure.detail !== undefined && <span className={css.videoErrorDetail}>{failure.detail}</span>}
    {openError !== undefined && <span className={css.videoErrorDetail}>{openError}</span>}
    <div className={css.videoErrorActions}>
      <button type="button" className={css.editorDownloadLink} onClick={onRetry}>{t('retry')}</button>
      <button type="button" className={css.editorDownloadLink} onClick={() => {
        setOpenError(undefined)
        void api.fsOpen(scope, path).catch(error => { setOpenError(t('videoSystemOpenFailed', { message: error instanceof Error ? error.message : String(error) })) })
      }}>{t('videoOpenSystem')}</button>
      <a className={css.editorDownloadLink} href={downloadUrl(scope, path)} download>{t('download')}</a>
    </div>
  </div>
}

/** Attach the stream only on first activation; later hiding only pauses it. */
export function VideoView({ mediaUrl, title, visible, scope, path }: FileViewerProps) {
  const [failure, setFailure] = useState<VideoFailure>()
  const [attachedUrl, setAttachedUrl] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const handleFailure = useCallback((next: VideoFailure) => { setFailure(next) }, [])

  useEffect(() => {
    setFailure(undefined)
    setAttempt(0)
    setAttachedUrl(previous => previous === mediaUrl ? previous : undefined)
  }, [mediaUrl])

  useEffect(() => {
    if (visible && mediaUrl !== undefined) setAttachedUrl(mediaUrl)
  }, [visible, mediaUrl])

  if (failure !== undefined || mediaUrl === undefined) {
    return <VideoError
      scope={scope}
      path={path}
      failure={failure ?? { kind: 'unreadable' }}
      onRetry={() => { setFailure(undefined); setAttempt(value => value + 1) }}
    />
  }

  return <div className={css.videoWrap}>
    <NativeVideoPlayer key={`${mediaUrl}:${attempt}`} mediaUrl={attachedUrl === mediaUrl ? attachedUrl : undefined} title={title} visible={visible} onError={handleFailure} />
  </div>
}
