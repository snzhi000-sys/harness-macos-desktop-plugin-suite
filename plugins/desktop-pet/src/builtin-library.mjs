/** Developer-maintained catalogue served directly from the plugin, independent of user assets. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { containedAsset, inspectModel } from './model-library.mjs'
import { validateProfile } from './character-profile.mjs'
import { describeDragonBones } from './dragonbones-library.mjs'
import { describeSpine } from './spine-library.mjs'
import { wardrobeIdentity } from './character-wardrobe.mjs'
import { describeActionModules } from './action-modules.mjs'
export const assetRoot = fileURLToPath(new URL('../assets/', import.meta.url))
export function builtinLibrary() {
  const manifest = JSON.parse(readFileSync(join(assetRoot, 'catalog.json'), 'utf8'))
  if (manifest.version !== 1 || !Array.isArray(manifest.models) || !manifest.models.length) throw new Error('内置角色资源不完整')
  const models = manifest.models.map(model => ({ ...model, entry: join(assetRoot, model.entry) }))
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error('内置角色标识重复')
  const get = id => { const model = models.find(model => model.id === id); if (!model) throw new Error('角色不存在，请重新选择'); return model }
  const descriptions = new Map()
  return {
    list: () => models.map(({ id, name, subtitle }) => ({ id, name, subtitle, ...wardrobeIdentity({id,name}), thumbnail: `/desktop-pet/models/${id}/preview.png` })),
    get, defaultId: models[0].id,
    async describe(id) {
      if (!descriptions.has(id)) {
        const model = get(id)
        if (model.kind === 'spine' || model.kind === 'dragonbones') {
          const info = await (model.kind === 'spine' ? describeSpine(model) : describeDragonBones(model))
          descriptions.set(id, {...info, actionModules:describeActionModules(info)}); return descriptions.get(id)
        }
        const info = await inspectModel(model.entry)
        const { data, dependencies, ...publicInfo } = info
        const described = { ...publicInfo, id, name: model.name, profile: validateProfile(model.profile, info) }
        descriptions.set(id, {...described,actionModules:describeActionModules(described)})
      }
      return descriptions.get(id)
    },
    asset: async (id, child) => containedAsset(dirname(get(id).entry), child),
    resolveSaved(id, stateRoot) {
      if (models.some(model => model.id === id)) return id
      if (!id) return models[0].id
      try {
        const old = JSON.parse(readFileSync(join(stateRoot, 'models.json'), 'utf8')).models.find(model => model.id === id)
        return (old?.name ? models.find(model => model.legacyName === old.name)?.id : null) ?? models[0].id
      } catch (error) { if (error.code === 'ENOENT') return models[0].id; throw error }
    },
  }
}
