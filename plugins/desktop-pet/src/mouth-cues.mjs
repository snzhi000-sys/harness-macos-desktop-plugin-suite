/** Timestamped authored mouth poses. Clock values are seconds on the audio playback timeline. */
export class MouthCues {
  constructor(apply, shapes, neutral) { this.apply = apply; this.shapes = shapes; this.neutral = neutral; this.active = false; this.current = null }
  start({ cues, duration }, clock) {
    if (!Array.isArray(cues) || cues.length > 10000 || !Number.isFinite(duration) || duration <= 0 || typeof clock !== 'function') throw new Error('口型时间轴无效')
    let previous = -1
    for (const cue of cues) {
      if (!Number.isFinite(cue.time) || cue.time < 0 || cue.time < previous || cue.time >= duration || !this.shapes.includes(cue.shape) || (cue.weight !== undefined && (!Number.isFinite(cue.weight) || cue.weight < 0 || cue.weight > 1))) throw new Error('口型时间或姿态无效')
      previous = cue.time
    }
    this.cancel(); this.cues = cues.map(cue => ({ ...cue })); this.duration = duration; this.clock = clock; this.active = true; this.update()
  }
  set(shape, weight = 1) { if (this.current !== shape || this.weight !== weight) { this.apply(shape); this.current = shape; this.weight = weight } }
  update() {
    if (!this.active) return
    const time = this.clock()
    if (!Number.isFinite(time) || time < 0 || time >= this.duration) { this.cancel(); return }
    let low = 0, high = this.cues.length
    while (low < high) { const mid = (low + high) >>> 1; if (this.cues[mid].time <= time) low = mid + 1; else high = mid }
    const cue = low ? this.cues[low - 1] : { shape: this.neutral, weight: 1 }
    this.remaining = (this.cues.slice(low).find(c => c.shape !== cue.shape || (c.weight ?? 1) !== (cue.weight ?? 1))?.time ?? this.duration) - time
    this.set(this.silent ? this.neutral : cue.shape, this.silent ? 1 : cue.weight ?? 1)
  }
  cancel() { this.active = false; this.silent = false; this.clock = null; this.cues = []; this.set(this.neutral) }
  dispose() { this.active = false; this.clock = null; this.cues = []; this.apply = () => {} }
}
