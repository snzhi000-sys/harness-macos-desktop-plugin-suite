/** One private pet conversation coordinates generation, synthesis, recording and a single playback owner. */
import { randomUUID } from 'node:crypto'
import { conversationStore } from './conversation-store.mjs'
import { converse, synthesize, recognize } from './voice-services.mjs'
import { speechCues } from './speech-cues.mjs'
import { createSpeechTextFilter, speechSegmentLength } from './speech-text.mjs'
import { dialoguePrompt, recentTurns, recentEmotionMessages, emotionHistoryText, expandEmotionPrompt, normalizeEmotionOutput } from './satellites.mjs'
import { intimacyState, intimacyPrompt } from './intimacy.mjs'

function inputQueue() {
  const queue = []; let waiter, ended = false, bytes = 0
  return {
    push(value) { if (ended) throw new Error('录音已结束'); bytes += value.length; if (bytes > 128000) throw new Error('录音上传过快'); queue.push(value); waiter?.(); waiter = null },
    end() { ended = true; waiter?.(); waiter = null },
    async *[Symbol.asyncIterator]() { for (;;) { if (queue.length) { const b = queue.shift(); bytes -= b.length; yield b } else if (ended) return; else await new Promise(r => { waiter = r }) } },
  }
}
export function createConversationHost(root, defaults = {}, services = { converse, synthesize, recognize }) {
  const store = conversationStore(root, defaults), clients = new Set(), audio = new Map(), tasks = new Set(), checks = new Set()
  let reply, turn, recording, speechController = new AbortController(), speechEpoch = randomUUID(), disposed = false, playback, speechTail = Promise.resolve(), queued = 0
  let emotionJob, emotionError = ''
  const emotionState = () => ({ ...store.session.emotion, generating: Boolean(emotionJob), error: emotionError })
  const snapshot = () => ({ session: { id: store.session.id, messages: store.session.messages }, intimacy: intimacyState(store.session, store.config.intimacyLevels), emotion: emotionState(), generating: Boolean(turn), recording: recording?.id ?? null, ttsEnabled: store.config.ttsEnabled, reply })
  const emit = (type, value, role) => { if (disposed) return; const frame = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`; for (const client of clients) if (!role || client.role === role) { if (client.res.writableLength > 1024 * 1024) client.res.destroy(); else client.res.write(frame) } }
  const track = promise => { tasks.add(promise); promise.finally(() => tasks.delete(promise)).catch(() => {}); return promise }
  const updateEmotion = (config, key, context, sourceReplyId) => {
    emotionJob?.controller.abort()
    const session = store.session, controller = new AbortController(), job = { controller }
    emotionJob = job; emotionError = ''
    const history = emotionHistoryText(context, config.emotionCharacterName)
    const relation = intimacyPrompt('{{亲密情况}}', intimacyState(session, config.intimacyLevels))
    const messages = [{ role: 'system', content: expandEmotionPrompt(config.emotionPrompt, history, relation) }, { role: 'user', content: '请根据以上聊天记录生成当前情绪。' }]
    const request = { id: randomUUID(), kind: 'emotion', model: config.model, messages, sourceReplyId, at: new Date().toISOString(), status: 'streaming' }
    session.requests.push(request); store.persist(); emit('emotion', emotionState())
    return track((async () => {
      let text = ''
      try {
        await services.converse(config, key, messages, delta => { if (!controller.signal.aborted) text += delta }, controller.signal)
        if (controller.signal.aborted || disposed || store.session !== session || emotionJob !== job) { request.status = 'interrupted'; return }
        request.output = text.trim()
        const formatted = normalizeEmotionOutput(text)
        request.status = 'complete'
        session.emotion = { text: formatted, updatedAt: new Date().toISOString(), sourceReplyId }
      } catch (error) {
        request.status = controller.signal.aborted ? 'interrupted' : 'failed'
        if (!controller.signal.aborted && emotionJob === job) emotionError = '情绪更新失败，沿用上一份情绪。'
      } finally {
        if (emotionJob === job) emotionJob = undefined
        if (!disposed && store.session === session) { store.persist(); emit('emotion', emotionState()) }
      }
    })())
  }
  const publishReply = () => { if (reply) { reply.generating = Boolean(turn && turn.id === reply.id); reply.speaking = queued > 0; emit('reply', reply) } }
  const stopSpeech = () => { speechController.abort(); speechController = new AbortController(); speechEpoch = randomUUID(); audio.clear(); queued = 0; speechTail = Promise.resolve(); emit('speech-stop', { epoch: speechEpoch }); publishReply() }
  const stop = () => { turn?.controller.abort(); emotionJob?.controller.abort(); recording?.controller.abort(); recording?.queue.end(); for (const controller of checks) controller.abort(); stopSpeech() }
  const enqueue = (text, config, key, epoch, asides = []) => {
    if (!/[\p{L}\p{N}]/u.test(text) || epoch !== speechEpoch || !store.config.ttsEnabled || !playback) return
    if (++queued > config.queueSegments) { stopSpeech(); emit('notice', { message: '回复较长，已停止朗读，文字继续显示。' }); return }
    const signal = speechController.signal
    publishReply()
    const job = speechTail.then(async () => {
      if (signal.aborted || epoch !== speechEpoch) return
      const result = await services.synthesize(config, key, text, signal)
      if (signal.aborted || epoch !== speechEpoch || !playback) return
      if ([...audio.values()].reduce((n, a) => n + a.pcm.length, 0) + result.pcm.length > 16 * 1024 * 1024) throw new Error('语音播放缓冲已满，请缩短回复')
      const id = randomUUID(), cues = speechCues(text, result.duration, result.subtitles)
      audio.set(id, { ...result, epoch }); emit('speech', { id, epoch, sampleRate: result.sampleRate, timeline: cues, asides, actionKeywords: config.actionKeywords, actionPresets: config.actionPresets, mouthRecipes: config.mouthRecipes }, 'player')
    }).catch(error => { if (!signal.aborted && epoch === speechEpoch) { queued = Math.max(0, queued - 1); publishReply(); emit('notice', { message: error.message }) } })
    speechTail = track(job)
  }
  const start = text => {
    if (turn || recording) throw new Error('请先停止当前回复或结束录音')
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('请输入 1–8000 字的消息')
    const config = { ...store.config }, key = store.keys.llm, ttsKey = store.keys.tts
    if (!key || !config.model) throw new Error('请先设置对话 API Key 和模型接入点')
    stopSpeech()
    const epoch = speechEpoch, controller = new AbortController(), id = randomUUID()
    const first = store.session.messages.length === 0
    const history = recentTurns(store.session.messages, config.historyTurns)
    const previousEmotion = store.session.emotion?.text ?? ''
    if (JSON.stringify(history).length + text.length + config.prompt.length + previousEmotion.length > 150000) throw new Error('对话上下文过长，请开始新对话')
    const answer = { id, role: 'assistant', content: '', status: 'streaming' }
    store.session.messages.push({ id: randomUUID(), role: 'user', content: text.trim(), status: 'complete' }, answer)
    store.persist()
    reply = { id, text: '', generating: true, speaking: false, voiced: false }
    turn = { id, controller }; publishReply(); emit('state', snapshot())
    const work = (async () => {
      let sentence = '', asides = []
      const speechText = createSpeechTextFilter(text => {
        if (/(?:…|\.{3})$/.test(sentence)) {
          const length = speechSegmentLength(sentence + ' ', config.sentenceChars)
          if (length && length <= sentence.length) { if (config.ttsEnabled) enqueue(sentence.slice(0,length),config,ttsKey,epoch,asides.splice(0)); sentence = sentence.slice(length) }
        }
        if (config.ttsEnabled && store.config.ttsEnabled && playback) asides.push(text)
        else emit('action-aside', { text, actionKeywords: config.actionKeywords, actionPresets: config.actionPresets, mouthRecipes: config.mouthRecipes }, 'player')
      })
      try {
        if (first) await updateEmotion(config, key, [{ role: 'user', content: text.trim() }], id)
        controller.signal.throwIfAborted()
        const messages = [{ role: 'system', content: dialoguePrompt(config.prompt, first ? store.session.emotion?.text : previousEmotion) }, ...history, { role: 'user', content: text.trim() }]
        store.session.requests.push({ id, kind: 'dialogue', model: config.model, messages, at: new Date().toISOString() }); store.persist()
        await services.converse(config, key, messages, delta => {
          if (controller.signal.aborted || turn?.id !== id) return
          answer.content += delta; reply.text = answer.content; publishReply(); emit('text', { id, delta })
          for (const ch of delta) {
            const spoken = speechText(ch)
            sentence += spoken
            for (;;) { const length = speechSegmentLength(sentence, config.sentenceChars); if (!length) break; if (config.ttsEnabled) enqueue(sentence.slice(0, length), config, ttsKey, epoch, asides.splice(0)); sentence = sentence.slice(length) }
          }
        }, controller.signal)
        answer.status = controller.signal.aborted ? 'interrupted' : 'complete'
        if (!controller.signal.aborted && config.ttsEnabled) {
          if (/[\p{L}\p{N}]/u.test(sentence)) enqueue(sentence, config, ttsKey, epoch, asides)
          else for (const text of asides) emit('action-aside', { text, actionKeywords: config.actionKeywords, actionPresets: config.actionPresets, mouthRecipes: config.mouthRecipes }, 'player')
        }
      } catch (error) { answer.status = controller.signal.aborted ? 'interrupted' : 'failed'; if (!controller.signal.aborted) emit('notice', { message: error.message }) }
      finally {
        if (turn?.id === id) turn = undefined
        store.completeTurn(id)
        store.persist(); publishReply(); emit('state', snapshot())
        if (answer.status === 'complete' && !disposed) void updateEmotion(config, key, recentEmotionMessages(store.session.messages, config.emotionHistoryMessages), id)
      }
    })()
    track(work); return { id }
  }
  const readJson = async req => { let size = 0; const chunks = []; for await (const b of req) { size += b.length; if (size > 8 * 1024 * 1024) throw new Error('请求过大'); chunks.push(b) } return JSON.parse(Buffer.concat(chunks).toString()) }
  return {
    store,
    async handle(req, res, url) {
      if (!url.pathname.startsWith('/desktop-pet/api/conversation')) return false
      const action = url.pathname.slice('/desktop-pet/api/conversation'.length), method = req.method
      const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
      try {
        if (disposed) throw new Error('桌宠已卸载')
        if (action === '/events' && method === 'GET') {
          const role = url.searchParams.get('role') === 'player' ? 'player' : 'chat'
          if (role === 'player' && playback) throw new Error('已有桌宠播放窗口')
          const client = { res, role }; clients.add(client); if (role === 'player') playback = client
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`)
          const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000)
          res.on('close', () => { clearInterval(timer); clients.delete(client); if (playback === client) { playback = null; stop() } })
          return true
        }
        if (action === '/config' && method === 'GET') { json(200, store.publicConfig()); return true }
        if (action === '' && method === 'GET') { json(200, snapshot()); return true }
        if (action === '/audio' && method === 'GET') { const item = audio.get(url.searchParams.get('id')); if (!item) { json(404, { error: '音频已过期' }); return true } res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }); res.end(item.pcm); return true }
        if (method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) { json(405, { error: 'JSON POST required' }); return true }
        const body = await readJson(req)
        if (action === '/config') { const wasEnabled = store.config.ttsEnabled, value = store.save(body); if (wasEnabled && !store.config.ttsEnabled) stopSpeech(); emit('state', snapshot()); json(200, value) }
        else if (action === '/send') json(200, start(body.text))
        else if (action === '/stop') { if (body.speechOnly) stopSpeech(); else stop(); json(200, { ok: true }) }
        else if (action === '/pause') { if (typeof body.paused !== 'boolean') throw new Error('暂停状态无效'); emit('speech-pause', { paused: body.paused }, 'player'); json(200, { ok: true }) }
        else if (action === '/new') { stop(); await Promise.allSettled([...tasks]); store.reset(); reply = undefined; emit('state', snapshot()); json(200, snapshot()) }
        else if (action === '/ack') { const item = audio.get(body.id); if (item?.epoch === body.epoch) { audio.delete(body.id); queued = Math.max(0, queued - 1); if (reply && body.played !== false) reply.voiced = true; publishReply() } json(200, { ok: true }) }
        else if (action === '/test') {
          let result = ''; const c = { ...store.config, maxTokens: 64 }, controller = new AbortController(); checks.add(controller)
          const messages = [{ role: 'system', content: dialoguePrompt(c.prompt, store.session.emotion?.text) }, { role: 'user', content: '请用一句话打个招呼。' }]
          store.session.requests.push({ id: randomUUID(), kind: 'connection-test', model: c.model, messages, at: new Date().toISOString() }); store.persist()
          try { await track(services.converse(c, store.keys.llm, messages, t => result += t, controller.signal)); json(200, { text: result }) }
          finally { checks.delete(controller) }
        }
        else if (action === '/sample') {
          if (!playback) throw new Error('请先显示桌宠再试听')
          stopSpeech(); const config = { ...store.config }, epoch = speechEpoch, signal = speechController.signal
          const job = services.synthesize(config, store.keys.tts, '你好，我是你的桌面伙伴。今天过得怎么样？', signal).then(result => { if (signal.aborted || epoch !== speechEpoch) return; const id = randomUUID(); audio.set(id, { ...result, epoch }); emit('speech', { id, epoch, sampleRate: result.sampleRate, timeline: speechCues('你好，我是你的桌面伙伴。今天过得怎么样？', result.duration, result.subtitles) }, 'player') })
          await track(job); json(200, { ok: true })
        }
        else if (action === '/record/start') {
          if (recording) throw new Error('已经在录音'); if (!store.keys.asr) throw new Error('请先填写 ASR API Key')
          stop(); const queue = inputQueue(), controller = new AbortController(), id = randomUUID()
          const rec = { id, queue, controller, bytes: 0 }; recording = rec
          controller.signal.addEventListener('abort', () => queue.end(), { once: true })
          rec.done = track(services.recognize(store.config, store.keys.asr, queue, (text, final) => emit('transcript', { id, text, final }), controller.signal).then(text => { if (!controller.signal.aborted) emit('transcript', { id, text, final: true }); return text }).catch(error => { if (!controller.signal.aborted) emit('notice', { message: error.message }); return '' }).finally(() => { queue.end(); if (recording === rec) recording = null; emit('state', snapshot()) }))
          json(200, { id, seconds: store.config.recordingSeconds }); emit('state', snapshot())
        }
        else if (action === '/record/chunk') { if (!recording || body.id !== recording.id) throw new Error('录音已过期'); if (typeof body.pcm !== 'string' || body.pcm.length > 20000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.pcm)) throw new Error('录音分片无效'); const b = Buffer.from(body.pcm, 'base64'); recording.bytes += b.length; if (b.length % 2 || recording.bytes > store.config.recordingSeconds * 32000) { recording.controller.abort(); throw new Error('录音超出限制') } recording.queue.push(b); json(200, { ok: true }) }
        else if (action === '/record/end') { const rec = recording; if (!rec || rec.id !== body.id) throw new Error('录音已过期'); rec.queue.end(); json(200, { text: await rec.done }) }
        else json(404, { error: '未知对话接口' })
      } catch (error) { if (!res.headersSent) json(400, { error: error.name === 'AbortError' ? '已停止' : error.message }); else res.end() }
      return true
    },
    async dispose() { if (disposed) return; disposed = true; stop(); for (const c of clients) c.res.end(); clients.clear(); await Promise.allSettled([...tasks]); audio.clear() },
  }
}
