/** Visible pets schedule one non-mouth action after each uninterrupted idle interval. */
export class AutomaticActions {
  constructor(renderer, intervalMs, random = Math.random) { this.renderer=renderer;this.intervalMs=intervalMs;this.random=random;this.next=null;this.previous=null }
  interrupt(now) { this.renderer.cancelAutomatic();this.next=now+this.intervalMs }
  update(now, available) {
    if (!available) { this.interrupt(now);return }
    if (this.renderer.state !== 'idle') { this.next=now+this.intervalMs;return }
    this.next ??= now+this.intervalMs
    if (now<this.next) return
    this.next=now+this.intervalMs
    const candidates=this.renderer.info.actionModules.filter(a=>a.automaticEligible)
    const alternatives=candidates.filter(a=>a.id!==this.previous), pool=alternatives.length?alternatives:candidates
    if (!pool.length) return
    const selected=pool[Math.floor(this.random()*pool.length)];this.previous=selected.id
    void this.renderer.playAutomatic(selected)
  }
}
