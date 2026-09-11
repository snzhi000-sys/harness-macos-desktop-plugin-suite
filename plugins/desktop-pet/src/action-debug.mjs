/** Settings holds are scoped to a character and expire if their owning page disappears. */
import { validWeight } from './action-presets.mjs'
export function mountActionDebug(container, { api, status, animated }) {
  const channel = new BroadcastChannel('dsh-pet-action-debug')
  let revision = 0, held, timer
  const send = () => channel.postMessage({ ...held, kind: 'hold' })
  const stop = () => {
    clearInterval(timer)
    if (held) channel.postMessage({ kind: 'release', token: held.token, modelId: held.modelId })
    held = null
    for (const button of container.querySelectorAll('button')) button.setAttribute('aria-pressed', 'false')
  }
  const suspend = () => { ++revision; stop(); container.replaceChildren() }
  window.addEventListener('blur', stop)
  const visibility = () => { if (document.hidden) stop() }
  document.addEventListener('visibilitychange', visibility)
  return {
    stop, suspend,
    async load(modelId) {
      suspend(); const token = revision
      try {
        const info = await api(`model?id=${encodeURIComponent(modelId)}`)
        if (token !== revision) return
        const title = document.createElement('summary'); title.textContent = '动作调试 · 按住预览，松开恢复'
        const details = document.createElement('details'); details.append(title); container.append(details)
        const items = info.actionModules
        const buttons = document.createElement('div'); buttons.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:10px 0'; details.append(buttons)
        details.addEventListener('toggle', () => { if (!details.open) stop() })
        for (const category of ['body','mouth']) {
        const group = items.filter(item=>item.category===category)
        if (!group.length) continue
        const label = document.createElement('strong'); label.textContent = category === 'mouth' ? '嘴型动作' : '肢体动作'; label.style.width='100%'; buttons.append(label)
        for (const item of group) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = item.label; button.setAttribute('aria-pressed', 'false')
          const start = () => { stop(); if (!animated()) { status('请先开启并保存动画设置，再预览动作。'); return } held = { modelId, token: crypto.randomUUID(), selection: item }; button.setAttribute('aria-pressed', 'true'); send(); timer = setInterval(send, 250) }
          button.onpointerdown = event => { if (event.button !== 0) return; event.preventDefault(); button.setPointerCapture(event.pointerId); start() }
          button.onpointerup = stop; button.onpointercancel = stop; button.onlostpointercapture = stop
          button.onkeydown = event => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); if (!event.repeat) start() } }
          button.onkeyup = event => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); stop() } }
          button.onblur = stop; buttons.append(button)
        }
        }
        if (!items.length) buttons.textContent = '此角色没有内置动作。'
      } catch (error) { if (token === revision) status(error.message) }
    },
    dispose() { suspend(); channel.close(); window.removeEventListener('blur', stop); document.removeEventListener('visibilitychange', visibility) },
  }
}

/** Apply holds to both the settings portrait and the existing desktop character without reloading either. */
export function receiveActionDebug(renderer, onError) {
  const channel = new BroadcastChannel('dsh-pet-action-debug')
  let token, timer
  const stop = () => { clearTimeout(timer); if (token) renderer.stopDebug(); token = null }
  channel.onmessage = ({ data }) => {
    if (data?.modelId !== renderer.info.id) return
    if (data.kind === 'release') { if (data.token === token) stop(); return }
    if (data.kind !== 'hold' || typeof data.token !== 'string') return
    if (data.token !== token) {
      stop()
      const s = data.selection
      if (s?.weight !== undefined && !validWeight(s.weight)) return
      const mouthRecipe = renderer.info.kind === 'dragonbones' && /^__speech_[aoim]$/.test(s?.animation ?? '')
      const valid = s && (mouthRecipe || (s.animation ? renderer.info.animations?.some(a => a.name === s.animation) : s.motion ? renderer.info.motions?.some(m => m.group === s.motion.group && m.index === s.motion.index) : renderer.info.expressions?.some(e => e.name === s.expression)))
      if (!valid) return
      token = data.token
      Promise.resolve(renderer.startDebug(s)).catch(onError)
    }
    if (data.selection?.weight !== undefined) {
      if (!validWeight(data.selection.weight)) return
      renderer.updateDebugWeight?.(data.selection.weight)
    }
    clearTimeout(timer); timer = setTimeout(stop, 1000)
  }
  return () => { stop(); channel.close() }
}
