import { describe, expect, it } from 'vitest'
import { StartupTaskScheduler, type StartupTaskClock } from '../src/client/startup-tasks.ts'

function controlledClock(): StartupTaskClock & {
  frames: FrameRequestCallback[]
  timers: Array<() => void>
} {
  const frames: FrameRequestCallback[] = []
  const timers: Array<() => void> = []
  return {
    frames,
    timers,
    requestFrame: (callback) => { frames.push(callback); return frames.length },
    cancelFrame: () => undefined,
    setTimer: (callback) => {
      timers.push(callback)
      return timers.length as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => undefined,
  }
}

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

describe('StartupTaskScheduler', () => {
  it('waits for two frames and serializes deferred operations', async () => {
    const clock = controlledClock()
    const scheduler = new StartupTaskScheduler(clock)
    const order: string[] = []
    let release: (() => void) | undefined
    const first = scheduler.schedule(async () => {
      order.push('first:start')
      await new Promise<void>((resolve) => { release = resolve })
      order.push('first:end')
    })
    const second = scheduler.schedule(() => { order.push('second') })

    expect(order).toEqual([])
    clock.frames.shift()?.(0)
    expect(order).toEqual([])
    clock.frames.shift()?.(16)
    await flush()
    expect(order).toEqual(['first:start'])
    release?.()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('skips aborted work and continues after a rejected task', async () => {
    const clock = controlledClock()
    const scheduler = new StartupTaskScheduler(clock)
    const aborted = new AbortController()
    const order: string[] = []
    const skipped = scheduler.schedule(() => { order.push('skipped') }, aborted.signal)
    const failed = scheduler.schedule(() => { throw new Error('failed') })
    const trailing = scheduler.schedule(() => { order.push('trailing') })
    aborted.abort()
    clock.timers.shift()?.()
    await expect(failed).rejects.toThrow('failed')
    await Promise.all([skipped, trailing])
    expect(order).toEqual(['trailing'])
  })

  it('resolves queued work without running it when disposed', async () => {
    const clock = controlledClock()
    const scheduler = new StartupTaskScheduler(clock)
    let ran = false
    const completion = scheduler.schedule(() => { ran = true })
    scheduler.dispose()
    await completion
    clock.timers.shift()?.()
    await flush()
    expect(ran).toBe(false)
  })
})
