/** Integrating resampler: retain fractional sample bins across render quanta, emit 200 ms PCM16 chunks. */
class PetRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.phase = 0; this.sum = 0; this.count = 0; this.output = []; this.port.onmessage = e => { if (e.data === 'flush') { this.flush(); this.port.postMessage({ flushed: true }) } } }
  flush() { if (!this.output.length) return; const pcm = new Int16Array(this.output); this.output = []; this.port.postMessage({ pcm: pcm.buffer }, [pcm.buffer]) }
  process(inputs) {
    const channels = inputs[0]; if (!channels?.length) return true
    for (let i = 0; i < channels[0].length; i++) {
      const sample = channels.reduce((n, c) => n + c[i], 0) / channels.length
      let remaining = 1
      while (remaining > 0) {
        const portion = Math.min(remaining, this.ratio - this.phase); this.sum += sample * portion; this.phase += portion; remaining -= portion
        if (this.phase >= this.ratio - 1e-9) { this.output.push(Math.round(Math.max(-1, Math.min(1, this.sum / this.ratio)) * 32767)); this.sum = 0; this.phase = 0; if (this.output.length >= 3200) this.flush() }
      }
    }
    return true
  }
}
registerProcessor('pet-recorder', PetRecorder)
