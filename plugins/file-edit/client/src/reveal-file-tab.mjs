const animations = new WeakMap()

/** Reveal only this scrollport. Returns cleanup; newer requests and manual input cancel motion. */
export function revealFileTab(scroller, tab, { animate = false } = {}) {
  const noop = () => {}
  if (scroller) animations.get(scroller)?.()
  if (!scroller || !tab || scroller.clientWidth <= 0) return noop
  const viewport = scroller.getBoundingClientRect()
  const item = tab.getBoundingClientRect()
  const left = viewport.left + scroller.clientLeft
  const right = left + scroller.clientWidth
  const delta = item.width > scroller.clientWidth
    ? item.left - left
    : item.left < left ? item.left - left : item.right > right ? item.right - right : 0
  if (Math.abs(delta) < 1) return noop
  const start = scroller.scrollLeft
  const target = Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, start + delta))
  const view = scroller.ownerDocument?.defaultView
  const reducedMotion = view?.matchMedia('(prefers-reduced-motion: reduce)')
  if (!animate || !view || reducedMotion.matches) {
    scroller.scrollLeft = target
    return noop
  }
  const duration = Math.min(250, 180 + Math.abs(target - start) * 0.08)
  const started = view.performance.now()
  const events = ['wheel', 'pointerdown', 'touchstart', 'dragstart', 'keydown']
  let frame = null
  let stopped = false
  const cancel = () => {
    if (stopped) return
    stopped = true
    if (frame !== null) view.cancelAnimationFrame(frame)
    for (const event of events) scroller.removeEventListener(event, cancel, true)
    reducedMotion.removeEventListener('change', onMotionChange)
    if (animations.get(scroller) === cancel) animations.delete(scroller)
  }
  const onMotionChange = () => {
    if (!reducedMotion.matches) return
    cancel()
    scroller.scrollLeft = target
  }
  const step = now => {
    if (stopped) return
    if (!scroller.isConnected) { cancel(); return }
    const progress = Math.min(1, Math.max(0, (now - started) / duration))
    scroller.scrollLeft = start + (target - start) * (1 - Math.pow(1 - progress, 3))
    if (progress === 1) cancel()
    else frame = view.requestAnimationFrame(step)
  }
  animations.set(scroller, cancel)
  for (const event of events) scroller.addEventListener(event, cancel, { capture: true, passive: true })
  reducedMotion.addEventListener('change', onMotionChange)
  frame = view.requestAnimationFrame(step)
  return cancel
}
