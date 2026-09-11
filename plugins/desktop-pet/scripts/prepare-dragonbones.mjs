/** Reproduce the bundled character from an explicit original export and pinned official runtimes. */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { prepareDragonBones } from '../src/dragonbones-assets.mjs'
const source = process.argv[2]
if (!source) throw new Error('Usage: node scripts/prepare-dragonbones.mjs <original-export-directory>')
const folder = resolve('assets/models/mengmei')
await mkdir(folder, { recursive: true }); await mkdir('assets/cores', { recursive: true })
const hashes = {}
let retainedDirections = []
if (!process.argv.includes('--profile-only')) {
for (const file of ['mengmei_ske.json', 'mengmei_tex.json', 'mengmei_tex.png']) {
  const bytes = await readFile(join(source, file)); hashes[file] = createHash('sha256').update(bytes).digest('hex')
  if (file.endsWith('_ske.json')) {
    const prepared = prepareDragonBones(JSON.parse(bytes)), arm = prepared.armature[0]
    // App-authored pointer control tracks use the existing zhuan bone; supplier motion keys stay intact.
    if (!arm.bone.some(b => b.name === 'zhuan')) throw new Error('Pointer control bone zhuan is missing')
    for (const [name, from, to] of [['左右', {x:0,y:-250}, {x:0,y:250}], ['上下', {x:-250,y:0}, {x:250,y:0}]]) {
      if (!arm.animation.some(a => a.name === name)) { arm.animation.push({name,duration:30,bone:[{name:'zhuan',translateFrame:[{duration:30,tweenEasing:0,...from},{duration:0,tweenEasing:0,...to}]}]}); retainedDirections.push(name) }
    }
    await writeFile(join(folder, file), JSON.stringify(prepared))
  }
  else await copyFile(join(source, file), join(folder, file))
}
const commit = '7b2d9f700d1719db2c5d89a6fa36c85d7f092501'
const runtimeFiles = [
  ['dragonbones.js', commit, 'Pixi/8.x/out/dragonBones.js'],
  ['dragonbones-LICENSE.txt', commit, 'LICENSE'],
  ['pixi8.js', '64b6c69ae35777c2404be68c9192e2c56906079e', 'Pixi/Demos/8.x/libs/pixi/8.9.2/pixi.js'],
]
const runtimes = process.argv.includes('--resources-only') ? JSON.parse(await readFile(join(folder,'SOURCE.json'),'utf8')).runtimes : []
for (const [name, sha, path] of process.argv.includes('--resources-only') ? [] : runtimeFiles) {
  const url = `https://raw.githubusercontent.com/DragonBones/DragonBonesJS/${sha}/${path}`
  const response = await fetch(url); if (!response.ok) throw new Error(`Runtime download failed: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer()); await writeFile(`assets/cores/${name}`, bytes)
  runtimes.push({ name, url, sha256: createHash('sha256').update(bytes).digest('hex') })
}
await writeFile(join(folder, 'SOURCE.json'), JSON.stringify({ character: '用户提供的萌妹骨骼资源；本地 Dev 使用', hashes, runtimes, retainedDirections, preparation: 'Physics constraint namespace; preserve supplier animation keys, meshes and bones; clear default actions; append missing app pointer-control tracks.' }, null, 2) + '\n')
}
const catalog = JSON.parse(await readFile('assets/catalog.json', 'utf8'))
const model = { id: 'mengmei', name: '萌妹', subtitle: '灵动伙伴', kind: 'dragonbones', entry: 'models/mengmei/mengmei_ske.json', atlas: 'mengmei_tex.json', profile: {
  version: 1, cooldownMs: 650, dragThreshold: 28, strokeThreshold: 7, strokeMs: 220,
  headRegion: { x: .28, y: .03, width: .32, height: .32 },
  idle: 'idle', neutralMouth: 'm', mouths: ['a','o','i','m'], expressions: ['xi','nu','bei','jing','biyan'],
  mouthBlendSeconds: .2,
  gaze: { bone: 'zhuan', anchor: 'yan', horizontalRange: 350, verticalRange: 300, sensitivity: 2, eyeRange: 18, responseSeconds: .18 },
  actions: { touch: { expression: 'xi', motion: 'diantou' }, click: { motion: 'wuxiong' }, annoyed: { expression: 'nu', motion: 'yaotou' }, drag: { expression: 'jing' }, release: { motion: 'wuxiong', expression: 'xi' } },
} }
const index = catalog.models.findIndex(m => m.id === model.id)
if (index < 0) catalog.models.push(model); else catalog.models[index] = model
catalog.models = [model, ...catalog.models.filter(m => m.id !== model.id)]
await writeFile('assets/catalog.json', JSON.stringify(catalog, null, 2) + '\n')
console.log('Prepared mengmei catalogue and requested resources; generate preview.png before building.')
