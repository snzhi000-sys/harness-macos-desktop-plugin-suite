import { memo, useId, useState, type CSSProperties } from 'react'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { TurnRailItem } from './turn-rail-items.ts'
import css from './TurnNavigator.module.css'

interface Props {
  readonly items: readonly TurnRailItem[]
  readonly activeTurn: number | null
  readonly busyTurn: number | null
  readonly onNavigate: (item: TurnRailItem) => void
  readonly t: ChatViewSlotProps['t']
}

type MarkStyle = CSSProperties & { readonly '--turn-position': string }

function markStyle(index: number, count: number): MarkStyle {
  return { '--turn-position': `${String(count <= 1 ? 0 : index / (count - 1) * 100)}%` }
}

function Rail({ items, activeTurn, busyTurn, onNavigate, t }: Props) {
  const [previewTurn, setPreviewTurn] = useState<number | null>(null)
  const previewId = useId()
  if (items.length < 2) return null
  const previewIndex = items.findIndex(item => item.turn === previewTurn)
  const preview = previewIndex < 0 ? undefined : items[previewIndex]
  return (
    <div className={css.slot}>
      <nav className={css.rail} aria-label={t('chat.turnNavigation.label')}>
        {items.map((item, index) => {
          const active = item.turn === activeTurn
          const classes = [css.mark]
          if (item.anchor.kind === 'unloaded') classes.push(css.unloaded)
          if (active) classes.push(css.active)
          if (item.turn === busyTurn) classes.push(css.busy)
          return (
            <button
              key={item.turn}
              type="button"
              className={classes.join(' ')}
              style={markStyle(index, items.length)}
              aria-label={t(item.anchor.kind === 'loaded'
                ? 'chat.turnNavigation.jump'
                : 'chat.turnNavigation.jumpLoad', { turn: item.turn })}
              aria-current={active ? 'true' : undefined}
              aria-busy={item.turn === busyTurn ? 'true' : undefined}
              aria-describedby={previewTurn === item.turn ? previewId : undefined}
              onClick={() => { onNavigate(item) }}
              onPointerEnter={() => { setPreviewTurn(item.turn) }}
              onPointerLeave={() => { setPreviewTurn(null) }}
              onFocus={() => { setPreviewTurn(item.turn) }}
              onBlur={() => { setPreviewTurn(null) }}
            />
          )
        })}
        {preview !== undefined && (
          <div id={previewId} role="tooltip" className={css.preview} style={markStyle(previewIndex, items.length)}>
            <strong>{preview.prompt || t('chat.turnNavigation.turn', { turn: preview.turn })}</strong>
            {preview.response !== '' && <span>{preview.response}</span>}
          </div>
        )}
      </nav>
    </div>
  )
}

/** Memoized whole-session turn rail; streaming chunks do not rebuild its marks. */
export const TurnNavigator = memo(Rail)
