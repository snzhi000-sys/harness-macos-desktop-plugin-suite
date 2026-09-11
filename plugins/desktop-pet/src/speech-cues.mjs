/** Convert returned word timing into the four authored visual mouth poses; no phoneme-precision claim. */
import { pinyin } from 'pinyin-pro'
export function speechCues(text, duration, subtitles = []) {
  const words = []
  const walk = value => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const v of value) walk(v); return }
    if (typeof value.word === 'string' && Number.isFinite(value.startTime) && Number.isFinite(value.endTime)) words.push({ text: value.word, start: value.startTime, end: value.endTime })
    else for (const v of Object.values(value)) walk(v)
  }
  walk(subtitles)
  const clean = value => value.replace(/[^\p{L}\p{N}]/gu, '')
  const spokenText = clean(text)
  const valid = words.filter(w => w.start >= 0 && w.end > w.start && w.start < duration && w.end <= duration + .25).map(w => ({...w,text:clean(w.text),end:Math.min(duration,w.end)})).filter(w=>w.text).sort((a, b) => a.start - b.start)
  let units = [], cursor = 0, previousEnd = 0, incomplete = false, usable = valid.length > 0
  for (const word of valid) {
    const index = spokenText.indexOf(word.text, cursor)
    if (index < cursor || word.start < previousEnd) { usable = false; break }
    if (index > cursor) {
      incomplete = true
      if (word.start <= previousEnd) { usable = false; break }
      units.push({text:spokenText.slice(cursor,index),start:previousEnd,end:word.start})
    }
    units.push(word); cursor = index + word.text.length; previousEnd = word.end
  }
  if (cursor < spokenText.length && usable) {
    incomplete = true
    if (previousEnd >= duration) usable = false
    else units.push({text:spokenText.slice(cursor),start:previousEnd,end:duration})
  }
  if (!usable) units = Array.from(spokenText).map((ch, i, all) => ({ text: ch, start: i / all.length * duration, end: (i + 1) / all.length * duration }))
  const cues = [{ time: 0, shape: 'm' }]
  for (const [wordIndex, word] of units.entries()) {
    const spoken = word.text.replace(/[^\p{L}\p{N}]/gu, '')
    const syllables = pinyin(spoken, { toneType: 'none', type: 'array' }).filter(Boolean)
    for (const [i, syllable] of syllables.entries()) {
      const start = word.start + (word.end - word.start) * i / syllables.length, end = word.start + (word.end - word.start) * (i + 1) / syllables.length
      const vowel = syllable.match(/[aeiouvü]+/i)?.[0]?.toLowerCase()
      if (!vowel) { cues.push({ time: start, shape: 'm' }); continue }
      const shapes = [...vowel].map(v => 'ouüv'.includes(v) ? 'o' : 'ie'.includes(v) ? 'i' : 'a')
      if (/^[bpm]/i.test(syllable)) cues.push({ time: start, shape: 'm' })
      if (/^[wy]/i.test(syllable)) cues.push({ time: start, shape: syllable[0].toLowerCase() === 'w' ? 'o' : 'i', phoneme: syllable[0].toLowerCase() })
      shapes.forEach((shape, index) => cues.push({ time: start + (end - start) * (.1 + .75 * index / shapes.length), shape, phoneme: vowel[index] }))
      // Adjacent syllables flow together; only a real gap warrants an explicit closed-mouth cue.
      const nextStart = i < syllables.length - 1 ? end : units[wordIndex + 1]?.start ?? duration
      if (end < duration && nextStart - end >= .09) cues.push({ time: end, shape: 'm' })
    }
  }
  return { duration, cues: cues.filter(c => c.time < duration).sort((a, b) => a.time - b.time), alignment: usable ? incomplete ? 'partial-word-pinyin' : 'word-pinyin' : 'estimated' }
}
