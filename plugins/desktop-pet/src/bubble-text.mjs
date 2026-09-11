/** Preserve literal reply text while giving nested or unfinished parenthetical asides a quieter color. */
export function bubbleParts(text) {
  const parts = []; let depth = 0
  for (const ch of text) {
    const open = ch === '（' || ch === '(', close = ch === '）' || ch === ')'
    const aside = depth > 0 || open
    if (parts.at(-1)?.aside === aside) parts.at(-1).text += ch
    else parts.push({ text: ch, aside })
    if (open) depth++
    else if (close && depth) depth--
  }
  return parts
}
export function renderBubbleText(element, text) {
  element.replaceChildren(...bubbleParts(text).map(part => {
    const span = element.ownerDocument.createElement('span'); span.textContent = part.text
    if (part.aside) span.className = 'bubble-aside'
    return span
  }))
}
