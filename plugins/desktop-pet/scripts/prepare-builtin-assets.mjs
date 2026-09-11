/** Curate the already verified local research downloads into a self-contained Dev plugin. */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { inspectModel, containedAsset } from '../src/model-library.mjs'
import { suggestedProfile, validateProfile } from '../src/character-profile.mjs'
const artifacts = resolve('../../desktop/.artifacts')
const research = join(artifacts, 'desktop-pet-research-2026-09-08')
const collection = join(artifacts, 'desktop-pet-library')
const root = resolve('assets')
const source = 'https://github.com/Eikanya/Live2d-model/tree/94ae3e5628226726af96c6b4bf0e1ce5c728e28e'
const original = JSON.parse(await readFile(join(research, 'model-audit.json'), 'utf8')).map((item, index) => ({ entry: join(research, item.entry), name: ['加藤惠', '蕾姆', 'Senko'][index] }))
const added = JSON.parse(await readFile(join(collection, 'playback-result.json'), 'utf8')).results.filter(item => item.status === 'rendered')
const models = []
for (const [index, item] of [...original, ...added].entries()) {
  // Retain stable IDs while excluding the retired Destiny Child collection.
  if (index >= 5 && index < 19) continue
  const id = `companion-${String(index + 1).padStart(2, '0')}`, directory = join(root, 'models', id)
  const info = await inspectModel(item.entry)
  await mkdir(directory, { recursive: true })
  for (const file of info.dependencies) { const target = join(directory, file); await mkdir(dirname(target), { recursive: true }); await copyFile(await containedAsset(dirname(item.entry), file), target) }
  const data = structuredClone(info.data)
  if (info.kind === 'cubism4') data.Groups = (data.Groups ?? []).filter(group => Array.isArray(group.Ids))
  const entry = `models/${id}/${info.kind === 'cubism2' ? 'entry.model.json' : 'entry.model3.json'}`
  await writeFile(join(root, entry), JSON.stringify(data, null, 2))
  if (item.preview) await copyFile(join(collection, 'previews', item.preview), join(directory, 'preview.png'))
  else {
    const image = ['product-Katou-idle.png', 'product-蕾姆.png', 'product-Senko.png'][index]
    await copyFile(join(artifacts, 'desktop-pet-v2', image), join(directory, 'preview.png'))
  }
  const names = { mori_miko: 'Mori · 巫女装', mori_mikoc: 'Mori · 巫女装 II', mori_mikocfs: 'Mori · 巫女装 III', mori_suit: 'Mori · 制服', ruri_miko: 'Ruri · 巫女装', '001_2018_dog': '户山香澄 · 新年', '001_miku_romecin': '户山香澄 · 联动装' }
  const short = item.name.split(' · ').at(-1)
  const name = index < 3 ? item.name : names[short] ?? `天命之子 · ${short}`
  const subtitle = index < 3 ? '经典伙伴' : index < 5 ? 'BanG Dream!' : index < 19 ? '天命之子 · 服装版本' : 'Fox Hime Zero'
  models.push({ id, name, subtitle, legacyName: item.name, entry, kind: info.kind, profile: validateProfile(item.profile ?? suggestedProfile(info), info), source })
}
if (models.length !== 10) throw new Error('Expected the 10 retained Live2D versions')
await mkdir(join(root, 'cores'), { recursive: true })
await copyFile(join(artifacts, 'desktop-pet-v2/cores/live2d.min.js'), join(root, 'cores/live2d.min.js'))
await copyFile(join(artifacts, 'desktop-pet-fixtures/live2dcubismcore.min.js'), join(root, 'cores/live2dcubismcore.min.js'))
let otherModels = []
try { otherModels = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8')).models.filter(model => model.kind === 'dragonbones' || model.sourcePack) }
catch (error) { if (error.code !== 'ENOENT') throw error }
await writeFile(join(root, 'catalog.json'), JSON.stringify({ version: 1, models: [...otherModels.filter(model => model.kind === 'dragonbones'), ...models, ...otherModels.filter(model => model.kind !== 'dragonbones')] }, null, 2) + '\n')
await writeFile(join(root, 'NOTICE.txt'), 'Local Dev research collection. Models: ' + source + '\nCharacters and Live2D Core retain their respective owners and licenses. This local bundle is not a public redistribution grant.\n')
console.log('Prepared 10 retained Live2D companions and both local animation runtimes.')
