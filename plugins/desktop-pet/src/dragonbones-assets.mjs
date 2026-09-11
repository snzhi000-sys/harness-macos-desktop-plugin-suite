/** Prepare the authored 6.0 export without dropping constraints or changing bone names. */
export function prepareDragonBones(source) {
  const data = structuredClone(source)
  if (data.version !== '6.0' || data.armature?.length !== 1) throw new Error('需要单骨架 DragonBones 6.0 资源')
  const arm = data.armature[0]
  const names = new Set([...arm.ik ?? [], ...arm.transform ?? []].map(c => c.name))
  const mapping = new Map()
  for (const c of arm.physics ?? []) {
    const original = c.name
    c.name = `physics:${original}`
    if (names.has(c.name)) throw new Error('物理约束名称重复')
    names.add(c.name); mapping.set(original, c.name)
  }
  for (const animation of arm.animation ?? []) {
    for (const timeline of animation.physics ?? []) {
      if (!mapping.has(timeline.name)) throw new Error('物理动画引用不存在')
      timeline.name = mapping.get(timeline.name)
    }
  }
  arm.defaultActions = []
  return data
}
