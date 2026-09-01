/** Optional Harness runtime lane for non-critical startup work. */
export interface StartupTaskLane {
  schedule(task: () => void | Promise<void>, signal?: AbortSignal): Promise<void>
}

/** Resolve the runtime scheduler without making older Harness builds a hard dependency. */
export function startupTaskLane(ctx: { get(name: string): unknown }): StartupTaskLane | undefined {
  const candidate = ctx.get('startupTasks') as Partial<StartupTaskLane> | undefined
  return typeof candidate?.schedule === 'function' ? candidate as StartupTaskLane : undefined
}

/** Use the shared serial lane when present; older runtimes retain immediate behavior. */
export function scheduleStartupTask(
  lane: StartupTaskLane | undefined,
  task: () => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve()
  return lane === undefined ? Promise.resolve().then(task) : lane.schedule(task, signal)
}
