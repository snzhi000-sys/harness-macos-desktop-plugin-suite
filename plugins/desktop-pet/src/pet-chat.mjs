/** Compact pet input shares the Host's latest conversation; reply lifetime follows playback acknowledgement. */
import { conversationApi as api } from './conversation-api.mjs'
import { renderBubbleText } from './bubble-text.mjs'
export function mountPetChat(bubble, command, onInputFocus) {
  const form = document.getElementById('pet-chat'), input = document.getElementById('pet-input'), send = form.querySelector('button')
  const toggle = document.querySelector('[data-action="chat"]'), events = new EventSource('/desktop-pet/api/conversation/events')
  let open = false, sending = false, generating = false, recording = false, disposed = false, timer, sessionId, held = false
  const show = text => { renderBubbleText(bubble, text); bubble.scrollTop = bubble.scrollHeight }
  const render = () => { send.disabled = sending || generating || recording; input.placeholder = generating ? '正在回复…' : '想聊些什么？' }
  const reply = value => {
    clearTimeout(timer); held = true; show(value.text || '正在想…')
    if (value.generating || value.speaking) return
    if (value.voiced) { held = false; show(''); return }
    timer = setTimeout(() => { held = false; show('') }, Math.min(10000, Math.max(2000, [...value.text].length * 220)))
  }
  events.addEventListener('state', e => { const state = JSON.parse(e.data); if (sessionId !== state.session.id) { clearTimeout(timer); held = false; show(''); sessionId = state.session.id } generating = state.generating; recording = Boolean(state.recording); render(); if (state.reply && (state.reply.generating || state.reply.speaking)) reply(state.reply) })
  events.addEventListener('reply', e => reply(JSON.parse(e.data)))
  events.addEventListener('notice', e => { if (!held) local(JSON.parse(e.data).message) })
  events.onerror = () => { clearTimeout(timer); held = false; local('连接中断，正在重连…') }
  function local(text) { if (held || disposed) return; clearTimeout(timer); show(text); timer = setTimeout(() => show(''), 2800) }
  const submit = async () => {
    const text = input.value.trim(); if (!text || sending || generating || recording) return
    sending = true; render()
    try { await api('/send', { text }); if (!disposed) input.value = '' }
    catch (error) { local(error.message) }
    finally { sending = false; if (!disposed) render() }
  }
  form.onsubmit = e => { e.preventDefault(); void submit() }
  input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); void submit() } }
  const updateFocus = () => onInputFocus(open && document.hasFocus() && document.activeElement === input)
  input.addEventListener('focus', updateFocus)
  input.addEventListener('blur', updateFocus)
  window.addEventListener('focus', updateFocus)
  window.addEventListener('blur', updateFocus)
  return {
    local,
    async toggle() {
      const next = !open
      await command({ action: 'chat-input', open: next })
      if (disposed) return
      open = next; form.hidden = !open; document.body.classList.toggle('chat-open', open); toggle.textContent = open ? '关闭聊天' : '聊天'
      if (open) input.focus(); else input.blur()
      updateFocus()
    },
    dispose() { disposed = true; clearTimeout(timer); events.close(); form.onsubmit = null; input.onkeydown = null; input.removeEventListener('focus', updateFocus); input.removeEventListener('blur', updateFocus); window.removeEventListener('focus', updateFocus); window.removeEventListener('blur', updateFocus); onInputFocus(false) },
  }
}
