/** Pointer gesture recognition keeps short head strokes separate from deliberate window dragging. */
export class PetGestures {
  constructor(profile) { this.profile = profile; this.down = null }
  start(x, y, region, now) { this.down = { x, y, lastX: x, direction: 0, turns: 0, region, at: now, dragging: false, stroked: false } }
  move(x, y, now) {
    const down = this.down
    if (!down || down.dragging) return null
    if (Math.hypot(x - down.x, y - down.y) >= this.profile.dragThreshold) { down.dragging = true; return 'drag' }
    const delta = x - down.lastX
    if (Math.abs(delta) >= this.profile.strokeThreshold) {
      const direction = Math.sign(delta)
      if (down.direction && direction !== down.direction) down.turns++
      down.direction = direction; down.lastX = x
    }
    if (!down.stroked && down.region === 'head' && down.turns >= 1 && now - down.at >= this.profile.strokeMs) { down.stroked = true; return 'touch' }
    return null
  }
  end() {
    const down = this.down; this.down = null
    if (!down) return null
    return down.dragging ? 'release' : down.stroked ? null : down.region === 'head' ? 'touch' : 'click'
  }
}
