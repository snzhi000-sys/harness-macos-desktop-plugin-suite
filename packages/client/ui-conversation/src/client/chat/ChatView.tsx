// ChatView: the default conversation view — one stable keyed parent list over
// final business Nodes, plus paging, pending steering and bottom-follow.
// Each row dispatches through 'conversation.chat.node'; ui-tool owns the
// tool-call renderer and its recursive root/subcall composition.
//
// Scroll: when nested under `[data-conversation-scroll]` (active conversation
// column), that host is the scrollport and this view is flow content; when
// mounted alone (unit tests), `.scroll` owns overflow. Bottom-follow and
// prepend anchoring always target the resolved scrollport.
//
// Render economics: order changes only when rows enter, leave or move. Each
// ChatNodeSeat subscribes to one Node key, so Assistant deltas and Tool
// lifecycle updates replace only their own row without remounting it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { PendingSteeringBubble, PendingSubmissionBubble } from './MessageItem.tsx'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { TurnNavigator } from './TurnNavigator.tsx'
import { turnRailItems, type TurnRailItem } from './turn-rail-items.ts'
import { formatRunDuration } from './message-chrome.ts'
import css from './ChatView.module.css'

const FOLLOW_THRESHOLD = 24

/** Active column host when present; otherwise the view-local scroller. */
function scrollerOf(from: HTMLElement): HTMLElement {
  return (from.closest('[data-conversation-scroll]')) ?? from
}

interface PagingAnchor {
  /** Stable node/call identity, independent of boundary-spanning group keys. */
  key: string
  /** Row top relative to the scrollport after the latest user scroll. */
  top: number
}

/** Find an already-rendered settled row without interpolating a selector. */
function anchorElement(list: HTMLElement, key: string): HTMLElement | null {
  for (const row of list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
    if (row.dataset.chatAnchorKey === key) return row
  }
  return null
}

/** Row position in scrollport coordinates (viewport-independent). */
function flowTop(row: HTMLElement, scrollport: HTMLElement): number {
  return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
}

/** Select a visible stable node/call identity, falling back only when layout
 * has not exposed a visible box yet. */
function pagingAnchor(list: HTMLElement, scrollport: HTMLElement): HTMLElement | null {
  const viewport = scrollport.getBoundingClientRect()
  const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
  const visibleBottom = composer?.getBoundingClientRect().top ?? viewport.bottom
  // Scroll events are hot: hit-test a few points through the stretched flow
  // rows before considering the full mounted set. The fallback keeps jsdom
  // and pre-layout states deterministic; a virtualizer naturally bounds it.
  if (typeof document.elementsFromPoint === 'function' && visibleBottom > viewport.top) {
    const content = list.getBoundingClientRect()
    const left = Math.max(viewport.left, content.left)
    const right = Math.min(viewport.right, content.right)
    const x = left + Math.max(0, right - left) / 2
    const height = visibleBottom - viewport.top
    const points = [1, Math.min(32, height / 3), height / 2, Math.max(1, height - 1)]
    for (const offset of points) {
      for (const element of document.elementsFromPoint(x, viewport.top + offset)) {
        const row = element instanceof HTMLElement
          ? element.closest<HTMLElement>('[data-chat-anchor-key]')
          : null
        if (row !== null && list.contains(row)) return row
      }
    }
  }
  const rows = [...list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
  const visibleRows = rows.filter((row) => {
    const rect = row.getBoundingClientRect()
    return rect.bottom > viewport.top && rect.top < visibleBottom
  })
  return visibleRows[0] ?? rows[0] ?? null
}

type ChatScrollPosition = NonNullable<ReturnType<ChatViewSlotProps['chatScroll']['read']>>

/** Capture a reflow-resistant reader position from the current rendered window. */
function scrollPosition(list: HTMLElement, scrollport: HTMLElement): ChatScrollPosition | null {
  const row = pagingAnchor(list, scrollport)
  const anchorKey = row?.dataset.chatAnchorKey
  if (row === null || anchorKey === undefined) return null
  return {
    anchorKey,
    anchorTop: flowTop(row, scrollport),
    scrollTop: scrollport.scrollTop,
  }
}

function runningTurnStartTime(timeline: ConversationTimelineSnapshot): number | null {
  let latest: number | null = null
  for (const turn of timeline.turns.values()) {
    if (turn.status === 'open' && turn.start !== undefined) latest = turn.start.time
  }
  return latest
}

/** Turn-level model activity label retained across first-token, tool, and streaming phases. */
function TurnStatus({ startTime, t }: {
  /** The running turn's logged `turn/start` time; null falls back to mount
   *  time when that boundary is outside the window. */
  startTime: number | null
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}) {
  const [mountedAt] = useState(() => Date.now())
  // Anchored to turn/start so a mid-turn reload keeps the real
  // elapsed time and the final footer's Ran-for label matches this clock.
  const anchor = startTime ?? mountedAt
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))
  useEffect(() => {
    const tick = (): void => {
      setElapsedMs(Math.max(0, Date.now() - anchor))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => { clearInterval(id) }
  }, [anchor])
  // Short turns keep the plain label; the clock only appears once the turn
  // has clearly been running for a while.
  const showClock = elapsedMs >= 15_000
  return (
    <div className={css.turnStatus} role="status" aria-live="polite">
      Deep diving...
      {showClock && (
        <span className={css.turnStatusClock} aria-hidden>
          {formatRunDuration(elapsedMs, t)}
        </span>
      )}
    </div>
  )
}

/**
 * The chat view slot entry: pure component over the composed props; each
 * ordered business Node crosses the keyed renderer seat.
 */
export function ChatView({
  useSession, useProjection, useSessions, useStore, renderSlot, sessionId,
  openFile, loadOlder, loadThrough, loadImage, inspectCall, chatScroll, forkAt,
  fileMentions, t,
}: ChatViewSlotProps) {
  const order = useSession(s => s.chat.order)
  const nodeStore = useSession(s => s.chat.nodes)
  const timeline = useSession(s => s.chat.timeline)
  const locations = useSession(s => s.chat.locations)
  const turnOutline = useProjection('turnOutline')
  const inbox = useSession(s => s.queue)
  // Fixture/third-party snapshot producers compiled against the older face
  // degrade to no local echoes instead of crashing the whole conversation.
  const pendingSubmissions = useSession(s => s.pendingSubmissions ?? [])
  // Workspace root off the session list row: path summaries display relative to it.
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const running = useSession(s => s.running)
  const openState = useSession(s => s.openState)
  const openError = useSession(s => s.openError)
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const historyError = useSession(s => s.historyError)
  const [pagePhase, setPagePhase] = useState<'idle' | 'loading' | 'leaving'>('idle')
  const pageLock = useRef(false)
  const upwardIntentUntil = useRef(0)
  const requestPageRef = useRef(() => {})
  const pageRestoreRef = useRef<PagingAnchor | null>(null)
  const selectedCallId = useStore(s => s.selection?.callId)

  const pendingSteering = useMemo(
    () => inbox.filter(item => item.placement === 'steering'),
    [inbox],
  )
  const mirroredSubmissionIds = useRef(new Set<string>())
  const visiblePendingSubmissions = useMemo(() => {
    // Once Host admission publishes the same pure-text occurrence through the
    // Queue mirror, that authoritative row/bubble owns its presentation. Keep
    // only unmatched local echoes so a slow admission is still immediate while
    // queued and steering messages never render twice. Consume as a multiset:
    // repeated equal prompts correspond to distinct queue occurrences.
    const mirrored = new Map<string, number>()
    for (const item of inbox) {
      if (item.text === null) continue
      mirrored.set(item.text, (mirrored.get(item.text) ?? 0) + 1)
    }
    return pendingSubmissions.filter((submission) => {
      const scopedId = `${sessionId}:${submission.id}`
      if (mirroredSubmissionIds.current.has(scopedId)) return false
      if (submission.images.length > 0) return true
      const count = mirrored.get(submission.text) ?? 0
      if (count === 0) return true
      mirrored.set(submission.text, count - 1)
      mirroredSubmissionIds.current.add(scopedId)
      return false
    })
  }, [inbox, pendingSubmissions, sessionId])
  const runningTurnStart = useMemo(() => runningTurnStartTime(timeline), [timeline])
  const railItems = useMemo(
    () => turnRailItems(turnOutline, locations),
    [turnOutline, locations, timeline],
  )

  const listRef = useRef<HTMLDivElement | null>(null)
  const columnRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [activeTurn, setActiveTurn] = useState<number | null>(null)
  const [busyTurn, setBusyTurn] = useState<number | null>(null)
  const [jumpSettleTick, setJumpSettleTick] = useState(0)
  /** Last position delivered or written on the main thread. */
  const observedTopRef = useRef(0)
  /** Paging anchor: semantic row/position at click, updated by reader scrolls
   * while the request is pending and restored after the prepend lands. */
  const anchorRef = useRef<PagingAnchor | null>(null)
  const pendingJumpRef = useRef<{ turn: number; seq: number; requested: boolean } | null>(null)
  const firstSeqRef = useRef<number | null>(null)
  const openedRef = useRef(false)
  const lastKeyRef = useRef<string | null>(null)
  const lastSteeringIdRef = useRef<string | null>(null)
  /** Flow tip signature — follow-scroll only when this moves, never on a
   *  scroll-driven at-bottom chrome re-render (which would snap inertial
   *  scrolls the rest of the way to the floor). */
  const followSigRef = useRef<string | null>(null)

  const firstKey = order[0]
  const firstSeq = firstKey === undefined ? null : nodeStore.get(firstKey)?.anchorSeq ?? null
  const lastKey = order.at(-1) ?? null
  const lastNode = lastKey === null ? undefined : nodeStore.get(lastKey)
  const lastSteeringId = pendingSteering[pendingSteering.length - 1]?.id ?? null
  const followSig = `${openState}:${firstSeq}:${lastKey}:${order.length}:${running ? 1 : 0}:${lastSteeringId ?? ''}`

  const toBottom = (el: HTMLElement): void => {
    pageRestoreRef.current = null
    anchorRef.current = null
    pendingJumpRef.current = null
    setBusyTurn(null)
    el.scrollTop = el.scrollHeight
    observedTopRef.current = el.scrollTop
    atBottomRef.current = true
    setAtBottom(true)
    chatScroll.save(null)
    setActiveTurn(railItems.at(-1)?.turn ?? null)
  }

  const landTurn = useCallback((local: HTMLElement, el: HTMLElement, turn: number): boolean => {
    const row = [...local.querySelectorAll<HTMLElement>('[data-chat-turn]')]
      .find(candidate => Number(candidate.dataset.chatTurn) === turn)
    if (row === undefined) return false
    pageRestoreRef.current = null
    el.scrollTop += flowTop(row, el) - 24
    observedTopRef.current = el.scrollTop
    atBottomRef.current = false
    setAtBottom(false)
    setActiveTurn(turn)
    const position = scrollPosition(local, el)
    if (position !== null) chatScroll.save(position)
    pendingJumpRef.current = null
    setBusyTurn(null)
    anchorRef.current = null
    return true
  }, [chatScroll])

  useLayoutEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: React attaches the ref before layout effects run. */
    if (local === null) return
    const el = scrollerOf(local)
    // Open completed: jump to the bottom once — unless a scroll position
    // survives from a previous mount (view-tab switch away and back), which
    // is restored instead of snapping the reader back to the floor.
    if (openState === 'open' && !openedRef.current) {
      openedRef.current = true
      const saved = chatScroll.read()
      if (saved === null) {
        toBottom(el)
      } else {
        el.scrollTop = saved.scrollTop
        const row = anchorElement(local, saved.anchorKey)
        if (row !== null) el.scrollTop += flowTop(row, el) - saved.anchorTop
        observedTopRef.current = el.scrollTop
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
        atBottomRef.current = isAtBottom
        setAtBottom(isAtBottom)
        const normalized = isAtBottom ? null : scrollPosition(local, el)
        if (isAtBottom) chatScroll.save(null)
        else if (normalized !== null) chatScroll.save(normalized)
      }
      firstSeqRef.current = firstSeq
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      followSigRef.current = followSig
      return
    }
    // Prepend (head seq decreased): preserve the same settled row at the
    // position established by the reader's latest scroll. This excludes
    // unrelated tail/composer growth while the request was in flight.
    if (anchorRef.current !== null && firstSeq !== null && firstSeqRef.current !== null && firstSeq < firstSeqRef.current) {
      const anchor = anchorRef.current
      anchorRef.current = null
      const row = anchorElement(local, anchor.key)
      if (row !== null) el.scrollTop += flowTop(row, el) - anchor.top
      pageRestoreRef.current = row === null ? null : { key: anchor.key, top: flowTop(row, el) }
      if (typeof window.matchMedia === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        for (const added of local.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
          const seq = nodeStore.get(added.dataset.chatAnchorKey ?? '')?.anchorSeq
          if (seq === undefined || seq >= firstSeqRef.current) continue
          const top = flowTop(added, el)
          if (top < el.clientHeight && top + added.getBoundingClientRect().height > 0 && typeof added.animate === 'function') {
            added.animate([{ opacity: 0.65 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' })
          }
        }
      }
      observedTopRef.current = el.scrollTop
      const pending = pendingJumpRef.current
      if (pending !== null && !landTurn(local, el, pending.turn) && row !== null) {
        anchorRef.current = { key: anchor.key, top: flowTop(row, el) }
      }
      firstSeqRef.current = firstSeq
      /* v8 ignore next -- ?? arm: a prepend adds nodes, so the flow list here is never empty. */
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      followSigRef.current = followSig
      return
    }
    firstSeqRef.current = firstSeq
    // Own words must be visible: a new trailing user node force-scrolls
    // (send lives in the composer, so arrival is detected here, not armed there).
    const appendedUser = lastKey !== lastKeyRef.current && lastNode?.kind === 'user'
    const appendedSteering = lastSteeringId !== null && lastSteeringId !== lastSteeringIdRef.current
    const tipMoved = followSigRef.current !== followSig
    lastKeyRef.current = lastKey
    lastSteeringIdRef.current = lastSteeringId
    followSigRef.current = followSig
    // Follow new flow content while pinned; do NOT re-pin on every render
    // merely because atBottomRef is true (scroll threshold → setState → snap).
    if (appendedUser || appendedSteering || (tipMoved && atBottomRef.current)) toBottom(el)
    else if (pendingJumpRef.current !== null) landTurn(local, el, pendingJumpRef.current.turn)
  })

  const onScrollRef = useRef(() => {})
  onScrollRef.current = () => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the handler only fires while mounted. */
    if (local === null) return
    const el = scrollerOf(local)
    // Only reader input may make raw scroll geometry change follow ownership:
    // a delivered position that deviates from the observed-top ledger (every
    // programmatic write records itself there synchronously). This covers
    // wheel, touch, scrollbar, and keyboard alike without naming devices.
    // Browser shrink-clamps land exactly on the floor min and delayed
    // programmatic deliveries land on the ledger itself, so both preserve
    // the current ownership state.
    const floor = Math.max(0, el.scrollHeight - el.clientHeight)
    const movedByReader = Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > 0.5
    const movedUp = movedByReader && el.scrollTop < observedTopRef.current
    if (movedByReader) pageRestoreRef.current = null
    const isAtBottom = movedByReader
      ? floor - el.scrollTop <= FOLLOW_THRESHOLD + 1
      : atBottomRef.current
    if (!movedByReader && isAtBottom) {
      toBottom(el)
      return
    }
    atBottomRef.current = isAtBottom
    setAtBottom(isAtBottom)
    const position = isAtBottom ? null : scrollPosition(local, el)
    const activeRow = pagingAnchor(local, el)
    const visibleTurn = Number(activeRow?.dataset.chatTurn)
    if (Number.isSafeInteger(visibleTurn)) setActiveTurn(visibleTurn)
    if (isAtBottom) {
      anchorRef.current = null
    } else if (anchorRef.current !== null && position !== null) {
      anchorRef.current = { key: position.anchorKey, top: position.anchorTop }
    }
    // Continuous save (unmount happens after ref detach, so saving there is
    // too late); pinned-to-bottom clears so a remount keeps following.
    if (isAtBottom) chatScroll.save(null)
    else if (position !== null) chatScroll.save(position)
    observedTopRef.current = el.scrollTop
    if (movedUp && el.scrollTop <= 2 && performance.now() < upwardIntentUntil.current) requestPageRef.current()
  }

  // Bind the scroll listener on the resolved scrollport once per mount;
  // reader-input attribution rides the observed-top ledger, not per-device
  // input listeners.
  useEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: effect runs after the list node commits. */
    if (local === null) return
    const el = scrollerOf(local)
    const onScroll = (): void => { onScrollRef.current() }
    // At an already-reached top (including a short page), no scroll event is emitted.
    const atTopInput = (): void => {
      upwardIntentUntil.current = performance.now() + 500
      if (el.scrollTop <= 2) requestPageRef.current()
    }
    const onWheel = (event: WheelEvent): void => { if (event.deltaY < 0) atTopInput() }
    let touchY: number | null = null
    const onTouchStart = (event: TouchEvent): void => { touchY = event.touches[0]?.clientY ?? null }
    const onTouchMove = (event: TouchEvent): void => {
      const next = event.touches[0]?.clientY ?? null
      if (next !== null && touchY !== null && next > touchY) atTopInput()
      touchY = next
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) atTopInput()
    }
    const onPointer = (): void => { upwardIntentUntil.current = performance.now() + 500 }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('keydown', onKey)
    el.addEventListener('pointerdown', onPointer, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('pointerdown', onPointer)
    }
  }, [])

  // The ref starts null and is assigned every render, so the placeholder
  // initializer a function initial value would need never exists.
  const followRef = useRef<(() => void) | null>(null)
  followRef.current = () => {
    const local = listRef.current
    if (local !== null && !atBottomRef.current && pageRestoreRef.current !== null) {
      const el = scrollerOf(local)
      const anchor = pageRestoreRef.current
      const row = anchorElement(local, anchor.key)
      if (row !== null) {
        el.scrollTop += flowTop(row, el) - anchor.top
        observedTopRef.current = el.scrollTop
      }
    }
    if (local !== null && atBottomRef.current) {
      const el = scrollerOf(local)
      el.scrollTop = el.scrollHeight
      observedTopRef.current = el.scrollTop
      chatScroll.save(null)
    }
  }
  // Streaming, tool disclosures, and other flow changes resize the column;
  // the sticky composer resizes outside it. This observer owns ChatView's
  // dynamic-height follow decisions and writes only while the reader is pinned.
  useEffect(() => {
    const column = columnRef.current
    const local = listRef.current
    if (column === null || local === null || typeof ResizeObserver === 'undefined') return
    const scrollport = scrollerOf(local)
    const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
    const observer = new ResizeObserver(() => { followRef.current?.() })
    observer.observe(column)
    if (composer !== null) observer.observe(composer)
    return () => { observer.disconnect() }
  }, [])

  // A failed/empty page leaves the head unchanged. Once the request leaves
  // its busy state there is no future prepend for the saved anchor to own.
  useEffect(() => {
    if (!loadingOlder) anchorRef.current = null
  }, [loadingOlder])

  useEffect(() => {
    const pending = pendingJumpRef.current
    const local = listRef.current
    if (pending === null || local === null) return
    const el = scrollerOf(local)
    if (landTurn(local, el, pending.turn)) return
    // A reader-owned page keeps the target pending. Its snapshot edge reruns
    // this effect after ownership is released, without issuing a competing
    // history request in the meantime.
    if (loadingOlder) return
    if (!pending.requested && hasMore && (firstSeq === null || firstSeq > pending.seq)) {
      const held = pagingAnchor(local, el)
      if (held?.dataset.chatAnchorKey !== undefined) {
        anchorRef.current = { key: held.dataset.chatAnchorKey, top: flowTop(held, el) }
      }
      pending.requested = true
      void loadThrough(pending.seq).finally(() => { setJumpSettleTick(value => value + 1) })
      return
    }
    pendingJumpRef.current = null
    setBusyTurn(null)
  }, [firstSeq, hasMore, jumpSettleTick, landTurn, loadingOlder, loadThrough, railItems])

  const loadOlderAnchored = (): void => {
    if (openState !== 'open' || !hasMore || loadingOlder || pageLock.current || pendingJumpRef.current !== null) return
    pageLock.current = true
    upwardIntentUntil.current = 0
    setPagePhase('loading')
    atBottomRef.current = false
    setAtBottom(false)
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the paging button renders inside the list tree. */
    if (local !== null) {
      const el = scrollerOf(local)
      const row = pagingAnchor(local, el)
      if (row !== null && row.dataset.chatAnchorKey !== undefined) {
        anchorRef.current = {
          key: row.dataset.chatAnchorKey,
          top: flowTop(row, el),
        }
      }
    }
    loadOlder()
  }
  requestPageRef.current = () => { if (historyError == null) loadOlderAnchored() }

  // Keep fast responses visible without delaying the data commit. The seat never changes height.
  useEffect(() => {
    if (pagePhase === 'idle' || loadingOlder) return
    const timer = window.setTimeout(() => {
      if (pagePhase === 'loading') setPagePhase('leaving')
      else {
        pageLock.current = false
        setPagePhase('idle')
      }
    }, pagePhase === 'loading' ? 180 : 150)
    return () => { window.clearTimeout(timer) }
  }, [loadingOlder, pagePhase])

  const navigateToTurn = useCallback((item: TurnRailItem): void => {
    const local = listRef.current
    if (local === null) return
    const el = scrollerOf(local)
    if (item.anchor.kind === 'loaded') {
      pendingJumpRef.current = null
      setBusyTurn(null)
      landTurn(local, el, item.turn)
      return
    }
    const held = pagingAnchor(local, el)
    if (held?.dataset.chatAnchorKey !== undefined) {
      anchorRef.current = { key: held.dataset.chatAnchorKey, top: flowTop(held, el) }
    }
    pendingJumpRef.current = { turn: item.turn, seq: item.anchor.seq, requested: !loadingOlder }
    setBusyTurn(item.turn)
    if (!loadingOlder) {
      void loadThrough(item.anchor.seq).finally(() => { setJumpSettleTick(value => value + 1) })
    }
  }, [landTurn, loadingOlder, loadThrough])

  return (
    <div className={css.root}>
      <div ref={listRef} className={css.scroll}>
        <TurnNavigator
          items={railItems}
          activeTurn={activeTurn}
          busyTurn={busyTurn}
          onNavigate={navigateToTurn}
          t={t}
        />
        <div ref={columnRef} className={css.column} data-chat-flow="">
          {openState === 'loading' && <div className={css.hint}>{t('chat.loadingHistory')}</div>}
          {openState === 'error' && openError !== null && (
            <div className={css.openError}>
              {t('chat.loadError', { message: openError.message, code: openError.code })}
            </div>
          )}
          <div className={css.older} data-history-pager={pagePhase} aria-live="polite">
            <span className={css.pageLoading} data-visible={pagePhase === 'loading' && historyError == null}
              aria-hidden={pagePhase !== 'loading' || historyError != null}>
              <span className={css.pageSpinner} aria-hidden="true" />{t('chat.loadingOlder')}
            </span>
            {pagePhase === 'idle' && (historyError != null
              ? <button type="button" disabled={loadingOlder} onClick={loadOlderAnchored}>{t('chat.retryOlder')}</button>
              : hasMore
                ? <button type="button" disabled={loadingOlder} onClick={loadOlderAnchored}>{t('chat.loadOlder')}</button>
                : order.length > 0 && openState === 'open' ? <span className={css.hint}>{t('chat.historyStart')}</span> : null)}
          </div>
          {order.map(nodeKey => (
            <ChatNodeSeat
              key={nodeKey}
              nodeKey={nodeKey}
              useSession={useSession}
              selectedCallId={selectedCallId}
              cwd={cwd}
              openFile={openFile}
              inspectCall={inspectCall}
              forkAt={forkAt}
              loadImage={loadImage}
              fileMentions={fileMentions}
              renderSlot={renderSlot}
              t={t}
            />
          ))}
          {visiblePendingSubmissions.map(submission => (
            <PendingSubmissionBubble key={submission.id} submission={submission} />
          ))}
          {/* No pending placeholders: questions (ui-user-questions) and approvals
              (ApprovalPanel) both take over the composer, so a flow card would
              double-render the same wait. */}
          {/* Turn-level loading signal: rides the whole running turn (first-token
              wait, tool execution, streaming) so it never flickers per step. */}
          {running && <TurnStatus startTime={runningTurnStart} t={t} />}
          {pendingSteering.map(item => (
            <PendingSteeringBubble key={item.id} content={item.content} loadImage={loadImage} t={t} />
          ))}
        </div>
        {!atBottom && (
          <div className={css.toBottomSlot}>
            <button
              type="button"
              className={css.toBottom}
              aria-label={t('chat.toBottom')}
              onClick={() => {
                const local = listRef.current
                /* v8 ignore next -- ref-null guard: the button only renders alongside the mounted list. */
                if (local !== null) toBottom(scrollerOf(local))
              }}
            >
              <IconChevronDownOutline14 />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
