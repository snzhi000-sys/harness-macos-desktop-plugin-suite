/** Scoped fixes for the pinned 6.0.2 adapter's angular blending, transform constraints and held mesh poses. */
const installed = new WeakSet()
export function installDragonBonesCompatibility(db) {
  if (installed.has(db)) return
  if (db.DragonBones.VERSION !== '6.0.001') throw new Error('龙骨驱动版本变化，需要复核约束适配')
  const prototype = db.TransformConstraint.prototype, compute = prototype._compute, init = prototype.init
  const helpers = new WeakMap()
  prototype._compute = function () {
    const data = this._constraintData, offset = data.offsetRotation
    if (!data.local && this._rotateWeight !== 0) {
      let helper = helpers.get(this)
      if (!helper) { helper = { root: new db.Transform(), target: new db.Transform() }; helpers.set(this, helper) }
      const current = helper.root.fromMatrix(this._root.globalTransformMatrix).rotation
      const target = helper.target.fromMatrix(this._target.globalTransformMatrix).rotation
      // The upstream weighted average treats equivalent angles separated by 2π as a full turn.
      data.offsetRotation = current + db.Transform.normalizeRadian(target + offset - current) - target
    }
    try { return compute.call(this) } finally { data.offsetRotation = offset }
  }
  prototype.init = function (data, armature) {
    const bone = armature.getBone(data.bones[this.index]?.name)
    const previous = bone?._transformConstraint
    init.call(this, data, armature)
    if (!previous || previous === this || bone?._transformConstraint !== this) return
    const constraints = previous.constraints ?? [previous]
    if (!constraints.includes(this)) constraints.push(this)
    // Bone.update and Armature teardown consume exactly these three members in the pinned runtime.
    bone._transformConstraint = {
      constraints,
      get _dirty() { return constraints.some(constraint => constraint._dirty) },
      set _dirty(value) { for (const constraint of constraints) constraint._dirty = value },
      update() { for (const constraint of constraints) constraint.update() },
      returnToPool() { for (const constraint of constraints) constraint.returnToPool() },
    }
  }
  const deform = db.DeformTimelineState.prototype, updateDeform = deform.update
  deform.update = function (time) {
    updateDeform.call(this, time)
    // This adapter skips completed slot-deform timelines before blending their weights.
    // Held mesh poses must keep contributing, just like completed bone poses; action completion is separate.
    if (this.playState > 0) this.playState = 0
  }
  installed.add(db)
}
