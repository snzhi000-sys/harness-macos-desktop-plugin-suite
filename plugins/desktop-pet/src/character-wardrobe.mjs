/** Verified identities shared by separately bundled outfit models. Unknown entries remain independent. */
const outfits = {
  'companion-04': ['kasumi', '户山香澄', '新年'],
  'companion-05': ['kasumi', '户山香澄', '联动装'],
  'companion-20': ['mori', 'Mori', '巫女装'],
  'companion-21': ['mori', 'Mori', '巫女装 II'],
  'companion-22': ['mori', 'Mori', '巫女装 III'],
  'companion-23': ['mori', 'Mori', '制服'],
}
export function wardrobeIdentity(model) {
  const entry = outfits[model.id]
  return entry ? { characterId: entry[0], characterName: entry[1], outfitName: entry[2] } : { characterId: model.id, characterName: model.name, outfitName: '当前服装' }
}
