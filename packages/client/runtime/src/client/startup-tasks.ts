/** Cooperative scheduler for non-critical startup work after the first browser paint. */

/** One deferred startup operation. */
export type StartupTask = () => void | Promise<void>

/** Browser timing surface, injectable so ordering and disposal stay deterministic in tests. */
export interface StartupTaskClock {
  requestFrame(callback: FrameRequestCallback): number
  cancelFrame(handle: number): void
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimer(handle: ReturnType<typeof setTimeout>): void
}

interface QueuedStartupTask {
  readonly task: StartupTask
  readonly signal: AbortSignal | undefined
  readonly resolve: () => void
  readonly reject: (reason: unknown) => void
}

const browserClock = (): StartupTaskClock => ({
  requestFrame: callback => window.requestAnimationFrame(callback),
  cancelFrame: (handle) => { window.cancelAnimationFrame(handle) },
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (handle) => { window.clearTimeout(handle) },
})

/**
 * Serializes non-critical startup I/O after two animation frames. A timeout
 * opens the gate when the page is backgrounded and animation frames pause.
 * Callers retain ownership of stale-result protection through AbortSignal.
 */
export class StartupTaskScheduler {
  private readonly queue: QueuedStartupTask[] = []
  private gateOpen = false
  private draining = false
  private disposed = false
  private firstFrame: number | undefined
  private secondFrame: number | undefined
  private fallbackTimer: ReturnType<typeof setTimeout> | undefined

  /** @param clock - browser timing operations; tests supply a deterministic clock. */
  constructor(private readonly clock: StartupTaskClock = browserClock()) {}

  /**
   * Enqueue one operation for the post-paint serial lane.
   * @param task - operation to run once the gate opens.
   * @param signal - caller-owned cancellation for session/workspace changes.
   * @returns settlement of this task; cancellation and scheduler disposal resolve without running it.
   */
  schedule(task: StartupTask, signal?: AbortSignal): Promise<void> {
    if (this.disposed || signal?.aborted === true) return Promise.resolve()
    const completion = new Promise<void>((resolve, reject) => {
      this.queue.push({ task, signal, resolve, reject })
    })
    if (this.firstFrame === undefined && !this.gateOpen) this.armGate()
    if (this.gateOpen) void this.drain()
    return completion
  }

  /** Cancel all not-yet-started work and prevent late queue mutations. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.firstFrame !== undefined) this.clock.cancelFrame(this.firstFrame)
    if (this.secondFrame !== undefined) this.clock.cancelFrame(this.secondFrame)
    if (this.fallbackTimer !== undefined) this.clock.clearTimer(this.fallbackTimer)
    this.firstFrame = undefined
    this.secondFrame = undefined
    this.fallbackTimer = undefined
    for (const item of this.queue.splice(0)) item.resolve()
  }

  private armGate(): void {
    this.fallbackTimer = this.clock.setTimer(() => { this.openGate() }, 200)
    this.firstFrame = this.clock.requestFrame(() => {
      this.firstFrame = undefined
      this.secondFrame = this.clock.requestFrame(() => {
        this.secondFrame = undefined
        this.openGate()
      })
    })
  }

  private openGate(): void {
    if (this.disposed || this.gateOpen) return
    this.gateOpen = true
    if (this.firstFrame !== undefined) this.clock.cancelFrame(this.firstFrame)
    if (this.secondFrame !== undefined) this.clock.cancelFrame(this.secondFrame)
    if (this.fallbackTimer !== undefined) this.clock.clearTimer(this.fallbackTimer)
    this.firstFrame = undefined
    this.secondFrame = undefined
    this.fallbackTimer = undefined
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed || !this.gateOpen) return
    this.draining = true
    try {
      while (!this.disposed) {
        const item = this.queue.shift()
        if (item === undefined) break
        if (item.signal?.aborted === true) {
          item.resolve()
          continue
        }
        try {
          await item.task()
          item.resolve()
        } catch (error) {
          item.reject(error)
        }
      }
    } finally {
      this.draining = false
      if (this.queue.length > 0) void this.drain()
    }
  }
}
