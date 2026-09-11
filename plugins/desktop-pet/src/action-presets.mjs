/** Saved variants reference authored actions; phoneme recipes reference authored mouth meshes. */
export const defaultMouthRecipes = Object.freeze([
  { phoneme: 'a', base: 'a', weight: 1 }, { phoneme: 'o', base: 'o', weight: 1 },
  { phoneme: 'i', base: 'i', weight: 1 }, { phoneme: 'm', base: 'm', weight: 1 },
  { phoneme: 'e', base: 'i', weight: .55 }, { phoneme: 'w', base: 'o', weight: .45 },
  { phoneme: 'y', base: 'i', weight: .7 },
])
const record = value => value && typeof value === 'object' && !Array.isArray(value)
export const validWeight = value => Number.isFinite(value) && value >= 0 && value <= 1
export const mouthPhonemes = ['a','o','i','m','e','w','y','u','ü','v']
export function migrateActionPresets(keywords) {
  return Object.fromEntries(Object.entries(keywords).map(([model, actions]) => [model, Object.entries(actions).map(([actionId, tags]) => ({ id: 'legacy:' + actionId, name: actionId, actionId, weight: 1, enabled: true, keywords: [...tags] }))]))
}
export function validateActionPresets(value) {
  if (!record(value)) throw Error('动作预设格式无效')
  for (const [model, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) throw Error('动作预设须为列表')
    const ids = new Set()
    for (const p of entries) {
      if (!record(p) || typeof p.id !== 'string' || !p.id || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || typeof p.actionId !== 'string' || !p.actionId || !validWeight(p.weight) || typeof p.enabled !== 'boolean' || !Array.isArray(p.keywords) || p.keywords.some(k => typeof k !== 'string' || !k.trim())) throw Error('动作预设名称、权重或关键词无效')
      ids.add(p.id)
      if (model !== 'mengmei' && p.weight !== 1) throw Error('此角色暂不支持可调动作权重，请使用100%')
    }
  }
  return value
}
export function validateMouthRecipes(value) {
  if (!record(value)) throw Error('嘴型配方格式无效')
  for (const [model, recipes] of Object.entries(value)) {
    if (model !== 'mengmei' || !Array.isArray(recipes)) throw Error('当前仅萌妹支持自定义嘴型')
    const phonemes = new Set()
    for (const recipe of recipes) {
      if (!record(recipe) || !mouthPhonemes.includes(recipe.phoneme) || phonemes.has(recipe.phoneme) || !['a','o','i','m'].includes(recipe.base) || !validWeight(recipe.weight)) throw Error('嘴型匹配符号须为 a/o/i/m/e/w/y/u/ü/v 且唯一，基础嘴型及权重须有效')
      phonemes.add(recipe.phoneme)
    }
    if (!['a','o','i','m'].every(p => phonemes.has(p))) throw Error('须保留 a/o/i/m 基础匹配项')
  }
  return value
}
export function weightedTimeline(timeline, recipes) {
  if (!recipes) return timeline
  const byPhoneme = new Map(recipes.map(r => [r.phoneme, r]))
  return { ...timeline, cues: timeline.cues.map(cue => {
    const recipe = byPhoneme.get(cue.phoneme ?? cue.shape) ?? byPhoneme.get(cue.shape)
    return recipe ? { ...cue, shape: recipe.base, weight: recipe.weight } : cue
  }) }
}
