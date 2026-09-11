/** Streaming speech projection omits parenthetical asides while leaving the stored reply untouched. */
export function createSpeechTextFilter(onAside = () => {}) {
  let depth = 0, aside = ''
  return delta => {
    let result = ''
    for (const ch of delta) {
      if (ch === '（' || ch === '(') { if (!depth) aside = ''; depth++; continue }
      if (ch === '）' || ch === ')') { if (depth && --depth === 0) { onAside(aside); aside = '' } continue }
      if (!depth) result += ch; else aside += ch
    }
    return result
  }
}

/** Keep short interjections with the next sentence where possible, avoiding isolated tiny audio clips. */
export function speechSegmentLength(text, limit) {
  for (const match of text.matchAll(/[。！？!?\n]|…+|\.{3,}/g)) {
    const end = match.index + match[0].length
    // A trailing ellipsis can grow across deltas; keep its whole run on the preceding segment.
    if (/^[….]/.test(match[0]) && end === text.length) continue
    if ((text.slice(0, end).match(/[\p{L}\p{N}]/gu) ?? []).length >= 4) return end
  }
  return text.length >= limit ? limit : 0
}
