/** Inspect Spine 4.2 exports without treating named, empty animations as usable poses. */
import { readFile } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import { containedAsset } from './model-library.mjs'

export function inspectSpine(data, atlasText) {
  if (!/^4\.2\./.test(data.skeleton?.spine ?? '')) throw new Error('需要 Spine 4.2 资源')
  const pages = [], regions = new Set()
  for (const block of atlasText.trim().split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (!lines.length) continue
    pages.push(lines[0])
    for (const line of lines.slice(1)) if (!line.includes(':')) regions.add(line)
  }
  if (!pages.length || !regions.size) throw new Error('Spine 图集为空')
  for (const skin of data.skins ?? []) for (const attachments of Object.values(skin.attachments ?? {})) {
    for (const [name, attachment] of Object.entries(attachments)) {
      if (['region', 'mesh', 'linkedmesh'].includes(attachment.type ?? 'region') && !regions.has(attachment.path ?? attachment.name ?? name)) throw new Error(`Spine 贴图引用缺失：${name}`)
    }
  }
  const timelines = value => {
    if (Array.isArray(value)) return value.length && value.every(frame => frame && typeof frame === 'object' && !Array.isArray(frame)) ? [value] : []
    return value && typeof value === 'object' ? Object.values(value).flatMap(timelines) : []
  }
  const animations = Object.entries(data.animations ?? {}).map(([name, value]) => {
    const frames = timelines(value)
    return { name, durationMs: Math.max(0, ...frames.flat().map(frame => frame.time ?? 0)) * 1000, timelines: frames.length }
  })
  const orders = new Map()
  for (const constraint of [...data.ik ?? [], ...data.transform ?? [], ...data.path ?? [], ...data.physics ?? []]) {
    const order = constraint.order ?? 0
    if (!orders.has(order)) orders.set(order, [])
    orders.get(order).push(constraint.name)
  }
  const constraintOrderConflicts = [...orders].filter(([, names]) => names.length > 1).map(([order, names]) => ({ order, names }))
  return { pages, animations, constraintOrderConflicts, counts: { bones: data.bones?.length ?? 0, slots: data.slots?.length ?? 0, physics: data.physics?.length ?? 0, transforms: data.transform?.length ?? 0, ik: data.ik?.length ?? 0 }, emptyAnimations: animations.filter(a => !a.timelines).map(a => a.name) }
}

/** Resolve only package-contained textures and require effective configured animation tracks. */
export async function describeSpine(model) {
  const root = dirname(model.entry), data = JSON.parse(await readFile(model.entry, 'utf8'))
  const atlas = await readFile(await containedAsset(root, model.atlas), 'utf8'), info = inspectSpine(data, atlas)
  if (info.constraintOrderConflicts.length) throw new Error('Spine 约束执行顺序重复，会丢失约束')
  for (const page of info.pages) await containedAsset(root, page)
  const names = new Set(info.animations.filter(a => a.timelines).map(a => a.name)), profile = model.profile
  for (const name of [profile.idle, profile.neutralMouth, ...profile.mouths ?? [], ...profile.expressions ?? [], ...Object.values(profile.actions).flatMap(a => [a.motion, a.expression])].filter(Boolean)) {
    if (!names.has(name)) throw new Error(`Spine 动作缺少有效关键帧：${name}`)
  }
  return { kind: 'spine', id: model.id, name: model.name, skeleton: basename(model.entry), atlas: model.atlas, profile, ...info, motions: info.animations.filter(a => a.timelines).map(a => ({ name: a.name })), expressions: (profile.expressions ?? []).map(name => ({ name })), physics: info.counts.physics > 0 }
}
