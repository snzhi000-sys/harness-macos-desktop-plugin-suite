/** Host-only speech clients. No provider response or transport error may expose request credentials. */
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { ttsPacket, asrPacket, decodeVoicePacket } from './voice-protocol.mjs'

async function channel(url, headers, signal, tts) {
  signal?.throwIfAborted()
  const ws = new WebSocket(url, { headers, handshakeTimeout: 15000, maxPayload: 8 * 1024 * 1024 })
  const queue = []; let pending, failure
  const fail = error => { failure = error; pending?.reject(error); pending = null }
  ws.on('message', data => { try { const value = decodeVoicePacket(data, tts); if (pending) { pending.resolve(value); pending = null } else { if (queue.length >= 512) throw new Error('语音接收缓冲已满'); queue.push(value) } } catch (error) { fail(error); ws.terminate() } })
  ws.on('error', () => fail(new Error('语音连接失败，请检查网络、凭据及服务权限')))
  ws.on('close', () => fail(new Error('语音连接已关闭')))
  const abort = () => { fail(new DOMException('已停止', 'AbortError')); ws.terminate() }
  signal?.addEventListener('abort', abort, { once: true })
  const closed = new Promise(resolve => ws.once('close', resolve))
  const close = async () => { signal?.removeEventListener('abort', abort); ws.terminate(); await closed }
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(new Error('语音连接失败，请检查凭据或权限'))); ws.once('close', () => reject(new Error('语音连接已关闭'))) })
    signal?.throwIfAborted()
  } catch (error) { await close(); throw error }
  return {
    send(bytes) { if (failure) throw failure; signal?.throwIfAborted(); if (ws.bufferedAmount > 2 * 1024 * 1024) throw new Error('语音上传缓冲已满'); ws.send(bytes) },
    async next() { if (queue.length) return queue.shift(); if (failure) throw failure; return new Promise((resolve, reject) => { pending = { resolve, reject } }) },
    close,
  }
}
export async function synthesize(config, key, text, signal) {
  if (!key) throw new Error('请先填写 TTS API Key')
  const bounded = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(config.timeoutMs)])
  const resource = config.voiceKind === 'clone' ? 'seed-icl-2.0' : 'seed-tts-2.0'
  const socket = await channel('wss://openspeech.bytedance.com/api/v3/tts/bidirection', { 'X-Api-Key': key, 'X-Api-Resource-Id': resource, 'X-Api-Connect-Id': randomUUID() }, bounded, true)
  const id = randomUUID(), chunks = [], subtitles = []; let size = 0, firstAudioMs = null
  const started = performance.now()
  const params = { speaker: config.speaker, audio_params: { format: 'pcm', sample_rate: 24000, enable_subtitle: true, speech_rate: config.speechRate } }
  if (config.voiceKind === 'clone') params.model = 'seed-tts-2.0-standard'
  const request = { user: { uid: 'desktop-pet' }, namespace: 'BidirectionalTTS', req_params: params }
  try {
    socket.send(ttsPacket(1))
    for (;;) {
      const m = await socket.next()
      if (m.code || [51, 153].includes(m.event)) throw new Error(`TTS 请求失败（${m.code || m.event}），请检查音色与资源权限`)
      if (m.event === 50) socket.send(ttsPacket(100, id, request))
      else if (m.event === 150) { socket.send(ttsPacket(200, id, { ...request, req_params: { ...params, text } })); socket.send(ttsPacket(102, id)) }
      else if (m.event === 352 || m.type === 11) { if (firstAudioMs === null) firstAudioMs = performance.now() - started; size += m.payload.length; if (size > 16 * 1024 * 1024) throw new Error('合成音频过长'); chunks.push(m.payload) }
      else if ([350, 351, 364].includes(m.event)) subtitles.push({ event: m.event, payload: m.payload })
      else if (m.event === 152) break
    }
    if (!size || size % 2) throw new Error('TTS 未返回有效音频')
    return { pcm: Buffer.concat(chunks), sampleRate: 24000, duration: size / 48000, subtitles, firstAudioMs }
  } finally { await socket.close() }
}

/** Consume live 16 kHz signed little-endian mono PCM chunks and replace interim text on each result. */
export async function recognize(config, key, chunks, onText, signal) {
  if (!key) throw new Error('请先填写 ASR API Key')
  const controller = new AbortController()
  const bounded = AbortSignal.any([controller.signal, signal ?? new AbortController().signal, AbortSignal.timeout(config.recordingSeconds * 1000 + config.timeoutMs)])
  const socket = await channel('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async', { 'X-Api-Key': key, 'X-Api-Resource-Id': config.asrResource, 'X-Api-Request-Id': randomUUID() }, bounded, false)
  const endInput = () => chunks.end?.()
  bounded.addEventListener('abort', endInput, { once: true })
  let sender, text = '', size = 0, sequence = 1
  const check = m => { if (m.code) throw new Error(`ASR 请求失败（${m.code}），请检查语音服务权限`) }
  try {
    socket.send(asrPacket(sequence++, { user: { uid: 'desktop-pet' }, audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 }, request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, show_utterances: true } }))
    check(await socket.next())
    sender = (async () => {
      for await (const chunk of chunks) { bounded.throwIfAborted(); size += chunk.length; if (size > config.recordingSeconds * 32000 || chunk.length % 2) throw new Error('录音长度或格式无效'); socket.send(asrPacket(sequence++, chunk, true)) }
      socket.send(asrPacket(sequence, Buffer.alloc(0), true, true))
    })()
    sender.catch(() => controller.abort())
    for (;;) { const m = await socket.next(); check(m); if (typeof m.payload?.result?.text === 'string') { text = m.payload.result.text; onText(text, m.last) } if (m.last) break }
    await sender
    return text
  } finally { controller.abort(); endInput(); bounded.removeEventListener('abort', endInput); await socket.close(); await sender?.catch(() => {}) }
}

/** Stream only assistant content from the configured Ark endpoint; never mix reasoning into spoken text. */
export async function converse(config, key, messages, onText, signal) {
  if (!key) throw new Error('请先填写对话 API Key')
  const response = await fetch(`${config.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: config.model, messages, stream: true, max_tokens: config.maxTokens }), signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(config.timeoutMs)]) })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`对话请求失败（HTTP ${response.status}），请检查模型接入点与权限`) }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', finished = false, count = 0
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break
      buffer += decoder.decode(value, { stream: true }); if (buffer.length > 1024 * 1024) throw new Error('模型事件过长')
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim(); if (data === '[DONE]') { finished = true; continue }
        const payload = JSON.parse(data); if (payload.error) throw new Error('模型返回错误')
        const choice = payload.choices?.[0]; if (choice?.finish_reason) finished = true
        const text = choice?.delta?.content; if (typeof text === 'string') { count += text.length; if (count > 32000) throw new Error('模型回复过长'); onText(text) }
      }
    }
    if (!finished) throw new Error('模型连接中断，回复不完整')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
