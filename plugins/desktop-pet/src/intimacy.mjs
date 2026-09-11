/** Session-local completed reply count with configurable inclusive score ranges. */
export const defaultIntimacyLevels = [
  { min: 0, name: '1级 · 初识', description: '你们当前还是比较陌生的阶段，你比较不信任对方。' },
  { min: 11, name: '2级 · 熟悉', description: '你们开始逐渐熟悉，心里多了一些好奇和放松，但仍保留一点距离。' },
  { min: 21, name: '3级 · 默契', description: '你们已经有了一些默契，你感到被理解，也开始自然地在意对方。' },
  { min: 41, name: '4级 · 亲近', description: '你们已经很亲近，你感到安心和信任，内心愿意显露更多偏心和温柔。' },
  { min: 66, name: '5级 · 亲密', description: '你们现在已经可以无话不说，再亲密的话都敢直接说。面对表白你内心欣然接受，面对对方的调戏你也有亲昵、俏皮地回应的心情。' },
].map((level, i, levels) => ({ ...level, max: levels[i+1] ? levels[i+1].min - 1 : null }))
export function normalizeIntimacyLevels(levels) {
  // The first local implementation stored starts only; preserve its exact effective ranges.
  if (Array.isArray(levels) && levels.every(level => level && !Object.hasOwn(level, 'max'))) return levels.map((level, i) => ({ ...level, max: levels[i+1] ? levels[i+1].min - 1 : null }))
  return levels
}
export function validateIntimacyLevels(levels) {
  if (!Array.isArray(levels) || !levels.length) throw new Error('至少保留一个亲密度等级')
  let previous = -1
  for (const [index, level] of levels.entries()) {
    if (!level || Object.keys(level).some(k => !['min','max','name','description'].includes(k)) || !Number.isSafeInteger(level.min) || level.min < 0) throw new Error('亲密度起始分数必须是非负整数')
    if (level.min !== previous + 1) throw new Error(`第 ${index+1} 级应从 ${previous+1} 分开始，分数区间不能重叠或遗漏`)
    if (index === levels.length - 1 ? level.max !== null : !Number.isSafeInteger(level.max) || level.max < level.min || level.max >= Number.MAX_SAFE_INTEGER) throw new Error('结束分数不能小于起始分数，只有最后一级的结束分数应留空表示无上限')
    if (typeof level.name !== 'string' || !level.name.trim() || typeof level.description !== 'string' || !level.description.trim()) throw new Error('每级都需要名称和亲密情况描述')
    previous = level.max
  }
  if (levels[0].min !== 0) throw new Error('第一个亲密度等级须从 0 开始')
  return levels
}
export function intimacyState(session, levels) {
  const score = session.intimacy.score
  const index = levels.findLastIndex(level => score >= level.min), level = levels[index]
  return { score, level: index + 1, name: level.name, min: level.min, max: level.max, description: level.description }
}
export function intimacyPrompt(template, state) {
  return template.replaceAll('{{亲密情况}}', () => `当前亲密度：${state.score}\n当前等级：${state.name}\n${state.description}`)
}
