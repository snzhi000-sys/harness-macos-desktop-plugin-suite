import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { revealFileTab } from '../client/src/reveal-file-tab.mjs'

function fixture(left, width = 80, scrollLeft = 200) {
  const scroller = { clientWidth: 300, clientLeft: 2, scrollWidth: 1400, scrollLeft, scrollTop: 71,
    getBoundingClientRect: () => ({ left: 100 }) }
  const tab = { getBoundingClientRect: () => ({ left, right: left + width, width }) }
  return { scroller, tab }
}

test('active file tabs reveal the nearest obscured edge, without moving vertical scroll', () => {
  for (const [left, expected] of [[150, 200], [82, 180], [360, 238], [-250, 0], [1500, 1100]]) {
    const { scroller, tab } = fixture(left)
    revealFileTab(scroller, tab)
    assert.equal(scroller.scrollLeft, expected)
    assert.equal(scroller.scrollTop, 71)
  }
})

test('oversized tabs align their beginning; hidden and absent elements do nothing', () => {
  const { scroller, tab } = fixture(130, 400)
  revealFileTab(scroller, tab)
  assert.equal(scroller.scrollLeft, 228)
  scroller.clientWidth = 0
  revealFileTab(scroller, tab)
  assert.equal(scroller.scrollLeft, 228)
  revealFileTab(null, tab)
  revealFileTab(scroller, null)
})

test('FileView uses committed active refs and explicit reopen requests, not polling revisions', () => {
  const source = readFileSync(new URL('../client/src/client.js', import.meta.url), 'utf8')
  assert.match(source, /this\.active = path\s+this\.tabRevealTick\+\+/)
  assert.match(source, /activate\(path\) \{ this\.active = path; this\.tabRevealTick\+\+/)
  assert.match(source, /return revealFileTab\(tabScrollRef\.current, activeTabRef\.current, \{ animate \}\)\s+\}, \[sid, store\.active, store\.tabRevealTick\]\)/)
  assert.match(source, /const animate = revealedSessionRef\.current === sid/)
  assert.match(source, /ref: t === active \? activeTabRef : null/)
})

function animatedFixture() {
  const { scroller } = fixture(360)
  const frames = new Map(), listeners = new Map()
  let clock = 0, id = 0
  const media = new EventTarget()
  media.matches = false
  scroller.isConnected = true
  scroller.addEventListener = (name, fn) => listeners.set(name, fn)
  scroller.removeEventListener = name => listeners.delete(name)
  scroller.ownerDocument = { defaultView: {
    matchMedia: () => media, performance: { now: () => clock },
    requestAnimationFrame: fn => { frames.set(++id, fn); return id },
    cancelAnimationFrame: key => frames.delete(key),
  } }
  const tab = contentLeft => ({ getBoundingClientRect: () => ({ left: 102 + contentLeft - scroller.scrollLeft, right: 182 + contentLeft - scroller.scrollLeft, width: 80 }) })
  const tick = time => { clock = time; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time)) }
  return { scroller, frames, listeners, media, tab, tick }
}

test('animation progresses smoothly and ends at the nearest edge within 250ms', () => {
  const f = animatedFixture()
  revealFileTab(f.scroller, f.tab(1000), { animate: true })
  assert.equal(f.scroller.scrollLeft, 200)
  f.tick(70)
  const first = f.scroller.scrollLeft
  assert.ok(first > 200 && first < 780)
  f.tick(140)
  assert.ok(f.scroller.scrollLeft > first && f.scroller.scrollLeft < 780)
  f.tick(250)
  assert.equal(f.scroller.scrollLeft, 780)
  assert.equal(f.scroller.scrollTop, 71)
  assert.equal(f.frames.size, 0)
  assert.equal(f.listeners.size, 0)
})

test('latest selection replaces motion from its current position without queued jumps', () => {
  const f = animatedFixture()
  const oldCleanup = revealFileTab(f.scroller, f.tab(1000), { animate: true })
  f.tick(60)
  const interrupted = f.scroller.scrollLeft
  revealFileTab(f.scroller, f.tab(0), { animate: true })
  oldCleanup()
  assert.equal(f.scroller.scrollLeft, interrupted)
  assert.equal(f.frames.size, 1)
  f.tick(310)
  assert.equal(f.scroller.scrollLeft, 0)
})

test('manual input, cleanup and detached scrollports stop animation and release listeners', () => {
  for (const event of ['wheel', 'pointerdown', 'touchstart', 'dragstart', 'keydown', 'cleanup', 'detach']) {
    const f = animatedFixture()
    const cleanup = revealFileTab(f.scroller, f.tab(1000), { animate: true })
    f.tick(60)
    const position = f.scroller.scrollLeft
    if (event === 'cleanup') cleanup()
    else if (event === 'detach') f.scroller.isConnected = false
    else f.listeners.get(event)()
    f.tick(300)
    assert.equal(f.scroller.scrollLeft, position, event)
    assert.equal(f.frames.size, 0)
    assert.equal(f.listeners.size, 0)
  }
})

test('restoration and reduced motion locate instantly, including preference changes mid-animation', () => {
  const f = animatedFixture()
  revealFileTab(f.scroller, f.tab(1000))
  assert.equal(f.scroller.scrollLeft, 780)
  assert.equal(f.frames.size, 0)
  f.media.matches = true
  revealFileTab(f.scroller, f.tab(0), { animate: true })
  assert.equal(f.scroller.scrollLeft, 0)
  f.media.matches = false
  revealFileTab(f.scroller, f.tab(1000), { animate: true })
  f.tick(60)
  f.media.matches = true
  f.media.dispatchEvent(new Event('change'))
  assert.equal(f.scroller.scrollLeft, 780)
  assert.equal(f.frames.size, 0)
})
