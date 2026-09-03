import { IconRefreshOutline16, IconWarningOutline16 } from './icons/index.tsx'
import css from './ConnectionIndicator.module.css'

/** Visible connection-recovery phase. */
export type ConnectionIndicatorState = 'connecting' | 'stalled' | 'reconnecting'

/**
 * Render a compact connection status and an immediate reconnect action.
 * @param props - visible phase, localized labels, and reconnect callback.
 * @returns the status control.
 */
export function ConnectionIndicator({
  state,
  labels,
  onReconnect,
}: {
  state: ConnectionIndicatorState
  labels: Record<ConnectionIndicatorState | 'action', string>
  onReconnect: () => void
}) {
  const retryable = state !== 'connecting'
  const content = (
    <>
      <span className={css.icon} aria-hidden="true">
        {retryable ? <IconWarningOutline16 size={14} /> : <IconRefreshOutline16 size={14} />}
      </span>
      <span className={css.label}>{labels[state]}</span>
    </>
  )
  if (!retryable) return <div className={css.indicator} role="status">{content}</div>
  return (
    <button type="button" className={css.indicator} aria-label={labels.action} onClick={onReconnect}>
      {content}
    </button>
  )
}
