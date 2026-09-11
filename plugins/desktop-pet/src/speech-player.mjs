/** The visible pet owns audio playback and mouth timing; settings previews never instantiate this player. */
import { conversationApi as api } from './conversation-api.mjs'
import { weightedTimeline } from './action-presets.mjs'
export function mountSpeechPlayer(renderer, notice, actions) {
  const events = new EventSource('/desktop-pet/api/conversation/events?role=player')
  let context, source, frame, disposed = false, generation = 0, active = false, paused = false, queue = [], controller = new AbortController()
  const stop = () => { generation++; paused = false; queue = []; controller.abort(); controller = new AbortController(); source?.stop(); source = null; cancelAnimationFrame(frame); renderer.speech?.cancel(); actions?.reset(); active = false; void context?.close(); context = null }
  const play = async () => {
    if (active || disposed || paused || !queue.length) return
    active = true; const item = queue.shift(), token = generation, signal = controller.signal
    try {
      const response = await fetch(`/desktop-pet/api/conversation/audio?id=${encodeURIComponent(item.id)}`, { signal })
      if (!response.ok) throw new Error('音频已过期')
      const bytes = await response.arrayBuffer(); if (token !== generation || disposed) return
      context ??= new AudioContext({ sampleRate: item.sampleRate }); await context.resume()
      if (token !== generation || disposed) return
      if (context.state !== 'running') throw new Error('请点击桌宠以允许播放声音')
      const buffer = context.createBuffer(1, bytes.byteLength / 2, item.sampleRate), channel = buffer.getChannelData(0), view = new DataView(bytes)
      for (let i = 0; i < channel.length; i++) channel[i] = view.getInt16(i * 2, true) / 32768
      source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination)
      let lastSound = 0
      const started = context.currentTime
      renderer.speech?.start(weightedTimeline(item.timeline, item.mouthRecipes?.[renderer.info.id]), () => context ? context.currentTime - started : -1)
      actions?.beginSpeech()
      source.start()
      actions?.play((item.asides ?? []).join('\n'), item.actionKeywords, item.actionPresets)
      const tick = () => {
        if (token !== generation || disposed) return
        // Silence gating also applies when timing had to be estimated from text.
        const at = Math.floor((context.currentTime - started) * item.sampleRate); let peak = 0
        for (let i = at; i < Math.min(channel.length, at + 240); i++) peak = Math.max(peak, Math.abs(channel[i]))
        const audioTime = context.currentTime - started
        if (peak >= .008) lastSound = audioTime
        if (renderer.speech?.silence) renderer.speech.silence(peak < .008 && audioTime - lastSound > .09)
        frame = requestAnimationFrame(tick)
      }; tick()
      await new Promise(resolve => { source.onended = resolve; signal.addEventListener('abort', resolve, { once: true }) })
      if (token !== generation) return
      cancelAnimationFrame(frame); renderer.speech?.cancel(); actions?.endSpeech(); source.disconnect(); source = null
      await api('/ack', { id: item.id, epoch: item.epoch, played: true })
    } catch (error) { if (!signal.aborted && !disposed) { notice(error.message); await api('/ack', { id: item.id, epoch: item.epoch, played: false }).catch(() => {}) } }
    finally { if (token === generation) { cancelAnimationFrame(frame); renderer.speech?.cancel(); actions?.endSpeech(); source?.disconnect(); source = null; active = false; if (queue.length) void play(); else { void context?.close(); context = null } } }
  }
  events.addEventListener('speech', e => { if (!disposed) { queue.push(JSON.parse(e.data)); void play() } })
  events.addEventListener('action-aside', e => { if (!disposed) { const value = JSON.parse(e.data); actions?.play(value.text, value.actionKeywords, value.actionPresets) } })
  events.addEventListener('speech-stop', stop)
  events.addEventListener('speech-pause', e => { paused = JSON.parse(e.data).paused; if (paused) void context?.suspend(); else { void context?.resume(); void play() } })
  events.addEventListener('notice', e => notice(JSON.parse(e.data).message))
  events.onerror = stop
  return () => { disposed = true; events.close(); stop() }
}
