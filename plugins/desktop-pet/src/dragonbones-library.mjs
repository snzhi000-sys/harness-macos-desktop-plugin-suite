/** Inspect built-in DragonBones assets before exposing their descriptor to a renderer. */
import { readFile } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import { containedAsset } from './model-library.mjs'
export async function describeDragonBones(model) {
  const root = dirname(model.entry), data = JSON.parse(await readFile(model.entry, 'utf8'))
  if (data.version !== '6.0' || data.armature?.length !== 1) throw new Error('不支持的龙骨资源版本')
  const arm = data.armature[0], profile = model.profile
  const atlas = JSON.parse(await readFile(await containedAsset(root, model.atlas), 'utf8'))
  await containedAsset(root, atlas.imagePath)
  const textures = new Set(atlas.SubTexture.map(t => t.name))
  for (const skin of arm.skin) for (const slot of skin.slot) for (const display of slot.display) {
    if (['image', 'mesh'].includes(display.type) && !textures.has(display.path ?? display.name)) throw new Error('龙骨贴图引用缺失')
  }
  const constraints = [...arm.ik ?? [], ...arm.transform ?? [], ...arm.physics ?? []]
  if (new Set(constraints.map(c => c.name)).size !== constraints.length) throw new Error('龙骨约束名称重复')
  const animations = arm.animation.map(a => ({ name: a.name, durationMs: a.duration / (arm.frameRate ?? data.frameRate) * 1000 }))
  const names = new Set(animations.map(a => a.name))
  if (!Number.isFinite(profile.mouthBlendSeconds) || profile.mouthBlendSeconds < .05 || profile.mouthBlendSeconds > .4) throw new Error('龙骨嘴型融合时间无效')
  if (profile.gaze) {
    const g = profile.gaze
    if (!Number.isFinite(g.sensitivity) || g.sensitivity < 1 || g.sensitivity > 3) throw new Error('龙骨身体跟随灵敏度无效')
    if (!Number.isFinite(g.eyeRange) || g.eyeRange < 0 || g.eyeRange > 25) throw new Error('龙骨眼球范围无效')
    if (![g.bone, g.anchor].every(name => arm.bone.some(b => b.name === name)) || ![g.horizontalRange, g.verticalRange].every(range => Number.isFinite(range) && range > 0 && range <= 600) || !Number.isFinite(g.responseSeconds) || g.responseSeconds <= 0) throw new Error('龙骨视线配置无效')
    if (!['左右', '上下'].every(name => names.has(name))) throw new Error('龙骨方向动作缺失')
  }
  for (const name of [profile.idle, profile.neutralMouth, ...profile.mouths, ...profile.expressions, ...Object.values(profile.actions).flatMap(a => [a.motion, a.expression]).filter(Boolean)]) if (!names.has(name)) throw new Error(`龙骨动作缺失：${name}`)
  return { kind: 'dragonbones', id: model.id, name: model.name, skeleton: basename(model.entry), atlas: model.atlas, texture: atlas.imagePath, armature: arm.name, profile, animations, motions: [], expressions: profile.expressions.map(name => ({ name })), counts: { bones: arm.bone.length, slots: arm.slot.length, constraints: constraints.length }, physics: Boolean(arm.physics?.length) }
}
