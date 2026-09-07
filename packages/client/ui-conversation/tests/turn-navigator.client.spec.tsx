// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatViewSlotProps } from '../src/client/contract/slots.ts'
import { TurnNavigator } from '../src/client/chat/TurnNavigator.tsx'
import type { TurnRailItem } from '../src/client/chat/turn-rail-items.ts'

afterEach(cleanup)

const items: readonly TurnRailItem[] = [
  {
    turn: 1,
    prompt: 'old question',
    response: 'old answer',
    status: 'closed',
    anchor: { kind: 'unloaded', seq: 0 },
  },
  {
    turn: 2,
    prompt: 'new question',
    response: '',
    status: 'open',
    anchor: { kind: 'loaded', key: 'turn-2' },
  },
]

const t = ((key: string, params?: Record<string, unknown>) => {
  const turn = typeof params?.turn === 'number' ? String(params.turn) : ''
  return `${key}:${turn}`
}) as ChatViewSlotProps['t']

describe('TurnNavigator', () => {
  it('labels unloaded marks as load-and-jump and dispatches their bounded item', () => {
    const onNavigate = vi.fn()
    const view = render(
      <TurnNavigator items={items} activeTurn={2} busyTurn={1} onNavigate={onNavigate} t={t} />,
    )
    const old = view.getByRole('button', { name: 'chat.turnNavigation.jumpLoad:1' })
    expect(old.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(old)
    expect(onNavigate).toHaveBeenCalledWith(items[0])
    expect(view.getByRole('button', { name: 'chat.turnNavigation.jump:2' }).getAttribute('aria-current')).toBe('true')
  })

  it('shows only bounded text supplied by the projection in its preview', () => {
    const view = render(
      <TurnNavigator items={items} activeTurn={null} busyTurn={null} onNavigate={() => {}} t={t} />,
    )
    fireEvent.pointerEnter(view.getByRole('button', { name: 'chat.turnNavigation.jumpLoad:1' }))
    expect(view.getByRole('tooltip').textContent).toBe('old questionold answer')
  })
})
