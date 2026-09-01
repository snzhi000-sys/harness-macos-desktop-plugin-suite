const CHIP_FONT_SIZE_PX = 12
const CHIP_ICON_WIDTH_PX = 14
const CHIP_GAP_PX = 5
const CHIP_HORIZONTAL_PADDING_PX = 16
const MIN_CHIP_WIDTH_EM = 3
const MAX_CHIP_WIDTH_EM = 23

/**
 * Calculate the inline cell width without touching editor state. The caller
 * supplies the browser's text measurer so tests can exercise the geometry
 * without constructing a second editing surface.
 */
export function referenceChipWidthEm({ name, line = '', measureText, composerFontSizePx = 16 }) {
  const safeMeasure = (text) => {
    const measured = Number(measureText(String(text || '')))
    return Number.isFinite(measured) && measured >= 0 ? measured : 0
  }
  const cjkWidth = Math.max(1, safeMeasure('汉'))
  const nameWidth = Math.max(cjkWidth, Math.min(cjkWidth * 20, safeMeasure(name)))
  const leadWidth = line ? safeMeasure(line) : CHIP_ICON_WIDTH_PX
  const totalPx = CHIP_HORIZONTAL_PADDING_PX + leadWidth + CHIP_GAP_PX + nameWidth
  const fontSize = Number.isFinite(composerFontSizePx) && composerFontSizePx > 0 ? composerFontSizePx : 16
  return Math.max(MIN_CHIP_WIDTH_EM, Math.min(MAX_CHIP_WIDTH_EM, totalPx / fontSize))
}
/** Create a measurer matching the visible inline label's 12px font. */
export function browserReferenceTextMeasurer(textarea) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  const family = textarea ? getComputedStyle(textarea).fontFamily : 'system-ui, sans-serif'
  if (context) context.font = `${CHIP_FONT_SIZE_PX}px ${family}`
  return (text) => context ? context.measureText(String(text || '')).width : Array.from(String(text || '')).length * CHIP_FONT_SIZE_PX
}
