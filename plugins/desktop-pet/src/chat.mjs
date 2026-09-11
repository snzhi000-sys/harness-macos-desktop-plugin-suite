/** A focused chat surface owns microphone capture; ASR drafts require explicit send. */
import { conversationApi as api } from './conversation-api.mjs'
const find = id => document.getElementById(id), events = new EventSource('/desktop-pet/api/conversation/events')
let state, disposed = false, recorder, opening = false, recordingGeneration = 0, sending = false
const status = text => { if (!disposed) find('status').textContent = text }
const render = () => {
  const list = find('messages'), bottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60
  list.replaceChildren()
  if (!state?.session.messages.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '我在这里，随时可以聊聊。'; list.append(empty) }
  for (const message of state?.session.messages ?? []) { const node = document.createElement('div'); node.className = `message ${message.role}`; node.textContent = message.content || '…'; if (['failed', 'interrupted'].includes(message.status)) { const note = document.createElement('small'); note.textContent = message.status === 'failed' ? '回复未完成' : '已停止'; node.append(note) } node.dataset.id = message.id; list.append(node) }
  find('send').disabled = Boolean(state?.generating || recorder || opening || sending)
  if (bottom) list.scrollTop = list.scrollHeight
}
const run = fn => async () => { try { await fn() } catch (e) { status(e.message) } }
events.addEventListener('state', e => { const wasGenerating = state?.generating; state = JSON.parse(e.data); if (wasGenerating && !state.generating) status('回复已完成。'); if (recorder?.id && !recorder.ending && state.recording !== recorder.id) { status('识别已结束。'); void cancelRecording() } render() })
events.addEventListener('text', e => { const { id, delta } = JSON.parse(e.data), message = state?.session.messages.find(m => m.id === id); if (message) { message.content += delta; render() } })
events.addEventListener('notice', e => status(JSON.parse(e.data).message))
events.addEventListener('transcript', e => { const value = JSON.parse(e.data); if (recorder?.id === value.id) { find('input').value = value.text; status(value.final ? '识别完成，可修改后发送。' : '正在听…') } })
events.onerror = () => { status('连接中断，正在重连…'); void cancelRecording() }
async function releaseCapture(rec) { clearTimeout(rec.timer); rec.stream?.getTracks().forEach(t => t.stop()); rec.node?.disconnect(); rec.source?.disconnect(); await rec.context?.close() }
async function cancelRecording() { recordingGeneration++; const rec = recorder; recorder = null; opening = false; if (rec) { rec.cancelled = true; await releaseCapture(rec) } await api('/stop', {}).catch(() => {}); if (!disposed) { find('record').textContent = '录音'; render() } }
async function endRecording() {
  const rec = recorder; if (!rec || rec.ending) return; rec.ending = true; clearTimeout(rec.timer)
  try {
    await new Promise(resolve => { rec.flushed = resolve; rec.node.port.postMessage('flush'); setTimeout(resolve, 300) })
    await releaseCapture(rec); await rec.upload
    const result = await api('/record/end', { id: rec.id })
    if (!rec.cancelled && !disposed) { find('input').value = result.text; status(result.text ? '识别完成，可修改后发送。' : '没有听清，请重试或打字。') }
  } finally { if (recorder === rec) recorder = null; find('record').textContent = '录音'; render() }
}
find('record').onclick = run(async () => {
  if (recorder) return endRecording(); if (opening) return
  opening = true; const generation = ++recordingGeneration; render(); status('正在请求麦克风…')
  let rec
  try {
    await api('/stop', {})
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false })
    if (disposed || generation !== recordingGeneration) { stream.getTracks().forEach(t => t.stop()); return }
    rec = { stream, context: new AudioContext(), upload: Promise.resolve(), pending: 0 }; recorder = rec
    await rec.context.audioWorklet.addModule('/desktop-pet/recorder-worklet.js')
    const started = await api('/record/start', {}); rec.id = started.id
    if (disposed || generation !== recordingGeneration) { await cancelRecording(); return }
    rec.node = new AudioWorkletNode(rec.context, 'pet-recorder'); rec.source = rec.context.createMediaStreamSource(stream)
    rec.node.port.onmessage = event => {
      if (event.data.flushed) { rec.flushed?.(); return }
      if (rec.cancelled || !event.data.pcm) return
      if (++rec.pending > 10) { status('网络较慢，录音已停止。'); void cancelRecording(); return }
      const bytes = new Uint8Array(event.data.pcm); let binary = ''; for (const b of bytes) binary += String.fromCharCode(b)
      rec.upload = rec.upload.then(() => rec.cancelled ? undefined : api('/record/chunk', { id: rec.id, pcm: btoa(binary) })).finally(() => rec.pending--)
      rec.upload.catch(e => { if (!rec.cancelled) { status(e.message); void cancelRecording() } })
    }
    rec.source.connect(rec.node); const mute = rec.context.createGain(); mute.gain.value = 0; rec.node.connect(mute).connect(rec.context.destination); await rec.context.resume()
    rec.timer = setTimeout(() => void endRecording().catch(e => status(e.message)), started.seconds * 1000)
    find('record').textContent = '结束录音'; status('正在听…结束录音后可修改文字。')
  } catch (e) { if (rec) await cancelRecording(); throw e }
  finally { opening = false; render() }
})
const send = async () => { if (sending || state?.generating || recorder || opening) return; const text = find('input').value.trim(); if (!text) return; sending = true; render(); try { await api('/send', { text }); find('input').value = ''; status('正在回复…') } finally { sending = false; render() } }
find('send').onclick = run(send)
find('input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); void send().catch(e => status(e.message)) } }
find('stop').onclick = run(async () => { await cancelRecording(); status('已停止。') })
const pause = document.createElement('button'); pause.textContent = '暂停朗读'; find('stop').after(pause); let paused = false
events.addEventListener('speech-stop', () => { paused = false; pause.textContent = '暂停朗读' })
pause.onclick = run(async () => { paused = !paused; await api('/pause', { paused }); pause.textContent = paused ? '继续朗读' : '暂停朗读' })
find('new').onclick = run(async () => { await cancelRecording(); state = await api('/new', {}); render(); status('已开始新对话。') })
window.addEventListener('pagehide', () => { disposed = true; events.close(); recordingGeneration++; if (recorder || opening) { if (recorder) { recorder.cancelled = true; void releaseCapture(recorder) } void api('/stop', {}, { keepalive: true }).catch(() => {}) } }, { once: true })
state = await api(); render()
