/** Pet page coordinates local input with the selected built-in animation engine. */
import { mountPetChat } from './pet-chat.mjs'
import { receiveActionDebug } from './action-debug.mjs'
import { PetGestures } from './gestures.mjs'
import { mountSpeechPlayer } from './speech-player.mjs'
import { AutomaticActions } from './automatic-actions.mjs'
import { conversationActions } from './conversation-actions.mjs'
const stage = document.getElementById('stage')
const message = document.getElementById('message')
const query = new URLSearchParams(location.search)
const bridge = query.has('preview') ? null : window.harnessPet
let renderer
let automatic
let dialogueActions
let petChat
let disposeSpeech
let disposeDebug
let frame
let disposed = false
let lastHit
let gestures
let settings
let lastReaction = -Infinity
let clicks = []
let bubbleUntil = 0
let pendingStatus = null
let unsubscribeStatus
let unsubscribe
let unsubscribeReaction
const pointer = { x: innerWidth / 2, y: innerHeight / 3 }
const bubble = document.getElementById('bubble')
const menu = document.getElementById('menu')
const command = value => bridge?.command(value).catch(error => { message.textContent = error.message })

const phrases = { touch: '嗯，这样很舒服。', click: '我在呢，怎么啦？', annoyed: '慢一点啦，我会害羞的。', drag: '要带我去哪里？', release: '就在这里陪你。', thinking: '正在想办法…', working: '正在处理任务…', replying: '正在整理回复…', waiting: '需要你看一下。', complete: '这次任务结束啦。', error: '遇到一点问题。' }
function say(name) { if (petChat) petChat.local(phrases[name] ?? ''); else { bubble.textContent = phrases[name] ?? ''; bubbleUntil = performance.now() + 2800 } }
function interact(event, external = false) {
  if (!renderer || !settings?.animated) return
  const now = performance.now(), state = renderer.state
  if (!external) automatic?.interrupt(now)
  if (!external) dialogueActions?.interrupt()
  if (state === 'debug') { if (external) pendingStatus = event; return }
  if (state === 'drag' && event !== 'release') return
  if (external && (state !== 'idle' || gestures?.down)) { pendingStatus = event; return }
  if (!['drag', 'release'].includes(event) && now - lastReaction < (renderer.profile?.cooldownMs ?? 650)) return
  if (event === 'click' || event === 'touch') {
    clicks = clicks.filter(at => now - at < 3000); clicks.push(now)
    if (clicks.length >= 3) { event = 'annoyed'; clicks = [] }
  }
  lastReaction = now
  if (event !== state) renderer.react(event)
  say(event)
  stage.dataset.action = event
}
function updatePointer(point) {
  pointer.x = point.x; pointer.y = point.y
  const target = document.elementFromPoint(point.x, point.y)
  const hit = Boolean(renderer?.hit(point.x, point.y)) || Boolean(target?.closest('#menu, #pet-chat')) || Boolean(message.textContent && target === message)
  if (hit !== lastHit) { lastHit = hit; command({ action: 'hit', hit }) }
  const event = gestures?.move(point.x, point.y, performance.now())
  if (event) { interact(event); if (event === 'drag') command({ action: 'drag-start' }) }
}
stage.onpointerdown = event => {
  if (event.button !== 0 || !renderer?.hit(event.clientX, event.clientY)) return
  menu.hidden = true
  automatic?.interrupt(performance.now())
  dialogueActions?.interrupt()
  const region = renderer.region?.(event.clientX, event.clientY) ?? (event.clientY < innerHeight * 0.3 ? 'head' : 'body')
  gestures.start(event.clientX, event.clientY, region, performance.now())
  stage.setPointerCapture(event.pointerId)
}
stage.onpointermove = event => {
  updatePointer({ x: event.clientX, y: event.clientY })
}
const release = () => {
  const event = gestures?.end()
  if (event === 'release') command({ action: 'drag-end' })
  if (event) interact(event)
}
stage.onpointerup = release
stage.onpointercancel = release
stage.onlostpointercapture = release
const openMenu = event => {
  automatic?.interrupt(performance.now())
  dialogueActions?.interrupt()
  event.preventDefault(); menu.hidden = false
  menu.style.left = `${Math.max(8, Math.min(innerWidth - 172, event.clientX))}px`
  menu.style.top = `${Math.max(8, Math.min(innerHeight - 250, event.clientY))}px`
  command({ action: 'hit', hit: true }); lastHit = true
}
stage.oncontextmenu = openMenu
menu.onclick = event => {
  const action = event.target.closest('button')?.dataset.action
  if (!action) return
  menu.hidden = true
  if (action === 'hide') { if (bridge) command({ action: 'hide' }); else say('release') }
  else if (action === 'settings') { if (bridge) command({ action: 'open-settings' }); else parent.postMessage({ type: 'dsh-pet-settings' }, location.origin) }
  else if (action === 'chat') void petChat?.toggle().catch(error => { message.textContent = error.message })
  else { lastReaction = -Infinity; interact(action) }
}
const preview = event => {
  if (event.origin !== location.origin || event.source !== parent || !query.has('preview') || event.data?.type !== 'dsh-pet-preview' || !renderer?.info) return
  const { motion, expression } = event.data
  if (motion && !renderer.info.motions.some(item => item.group === motion.group && item.index === motion.index)) return
  if (expression && !renderer.info.expressions.some(item => item.name === expression)) return
  renderer.preview(motion, expression)
}
window.addEventListener('message', preview)

function dispose() { disposed = true; cancelAnimationFrame(frame); disposeDebug?.(); disposeSpeech?.(); dialogueActions?.dispose(); petChat?.dispose(); unsubscribe?.(); unsubscribeReaction?.(); unsubscribeStatus?.(); window.removeEventListener('message', preview); renderer?.dispose() }
window.addEventListener('pagehide', dispose, { once: true })
try {
  const response = await fetch('/desktop-pet/api/settings')
  settings = await response.json()
  if (!response.ok) throw new Error(settings.error)
  if (query.has('model')) settings.modelId = query.get('model')
  {
    const descriptorResponse = await fetch(`/desktop-pet/api/model${settings.modelId ? `?id=${encodeURIComponent(settings.modelId)}` : ''}`)
    const descriptor = await descriptorResponse.json()
    if (!descriptorResponse.ok) throw new Error(descriptor.error)
    const loadScript = src => new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = () => reject(new Error('内置动画驱动加载失败')); document.head.append(script) })
    if (descriptor.kind === 'spine') {
      await loadScript('/desktop-pet/spine-core.js')
      const module = await import('/desktop-pet/spine.js')
      renderer = await module.createSpineRenderer(stage, settings, error => { message.textContent = error.message }, descriptor)
    } else if (descriptor.kind === 'dragonbones') {
      await loadScript('/desktop-pet/pixi8.js')
      await loadScript('/desktop-pet/dragonbones-core.js')
      const module = await import('/desktop-pet/dragonbones.js')
      renderer = await module.createDragonBonesRenderer(stage, settings, error => { message.textContent = error.message }, descriptor)
    } else {
    const legacy = descriptor.kind === 'cubism2'
    await loadScript(legacy ? '/desktop-pet/core2.js' : '/desktop-pet/core.js')
    const module = await import(legacy ? '/desktop-pet/live2d2.js' : '/desktop-pet/live2d.js')
    renderer = await module.createLive2DRenderer(stage, settings, error => { message.textContent = error.message }, descriptor)
    }
  }
  if (disposed) renderer.dispose()
  else {
    if (!query.has('preview')) automatic = new AutomaticActions(renderer, renderer.info.automaticActionIntervalMs)
    disposeDebug = receiveActionDebug(renderer, error => { message.textContent = error.message })
    if (!query.has('preview')) {
      dialogueActions = conversationActions(renderer, () => settings.animated && !gestures?.down && menu.hidden && !document.hidden, error => { message.textContent = error.message })
      petChat = mountPetChat(bubble, value => bridge ? bridge.command(value) : Promise.resolve(), focused => renderer.setInputFocused(focused)); disposeSpeech = mountSpeechPlayer(renderer, text => petChat.local(text), dialogueActions)
    }
    gestures = new PetGestures(renderer.profile ?? { dragThreshold: 28, strokeThreshold: 7, strokeMs: 220 })
    const tick = now => {
      if (!petChat && now >= bubbleUntil) bubble.textContent = ''
      if (pendingStatus && !gestures?.down && renderer.state === 'idle' && now - lastReaction >= (renderer.profile?.cooldownMs ?? 650)) { const value = pendingStatus; pendingStatus = null; interact(value, true) }
      renderer.update(now, pointer)
      automatic?.update(now, settings.animated && !dialogueActions?.speaking && !document.hidden && !gestures?.down && menu.hidden)
      stage.dataset.state = renderer.state
      const input = document.getElementById('pet-chat')
      if (!input.hidden) input.style.top = `${Math.max(8, Math.min(innerHeight - input.offsetHeight - 8, (renderer.contentBottom ?? stage.clientHeight) + 12))}px`
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    unsubscribe = bridge?.onPointer(updatePointer)
    unsubscribeReaction = bridge?.onReaction(interact)
    unsubscribeStatus = bridge?.onStatus?.(value => {
      if (value.kind === 'idle') { pendingStatus = null; return }
      if (Object.hasOwn(phrases, value.kind)) interact(value.kind, true)
    })
  }
} catch (error) { if (!disposed) { message.textContent = `桌宠暂时无法显示\n${error.message}`; command({ action: 'hit', hit: true }) } }
