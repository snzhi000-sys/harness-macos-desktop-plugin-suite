import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationViewActivation } from '../src/client/view-activation.ts'

const sid = (value: string): SessionId => value as SessionId

describe('ConversationViewActivation', () => {
  it('queues activation until the target Session store binds', () => {
    const views = new ConversationViewActivation()
    const setView = vi.fn()
    views.activate(sid('one'), 'files')
    views.bind(sid('one'), null, setView)
    expect(setView).toHaveBeenCalledWith('files')
    expect(views.storeFor(sid('one')).getSnapshot()).toBe('files')
  })

  it('keeps active views isolated between Sessions', () => {
    const views = new ConversationViewActivation()
    views.activate(sid('one'), 'files')
    views.sync(sid('two'), 'trajectory')
    expect(views.storeFor(sid('one')).getSnapshot()).toBe('files')
    expect(views.storeFor(sid('two')).getSnapshot()).toBe('trajectory')
  })

  it('adopts a persisted selection when no external request is pending', () => {
    const views = new ConversationViewActivation()
    const setView = vi.fn()
    views.bind(sid('one'), 'trajectory', setView)
    expect(setView).not.toHaveBeenCalled()
    expect(views.storeFor(sid('one')).getSnapshot()).toBe('trajectory')
  })
})
