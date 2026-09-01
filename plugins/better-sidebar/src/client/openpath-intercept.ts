/**
 * Interception of the chat's file-open funnel. The client runtime's
 * `ctx.workspaces.openPath` is the SINGLE door every chat-side file open goes
 * through — ui-conversation's apply.ts resolves the path against the session
 * cwd and calls it for tool-row path links, the produced-files row, and
 * prose file mentions alike (verified against the DSH source:
 * `packages/client/ui-conversation/src/client/apply.ts` is the only
 * production caller). Wrapping that one method sends those opens through the
 * unified plugin router — no DSH modification needed.
 *
 * The wrapper is dependency-free by design (no React / ui-primitives), so
 * the takeover logic is unit-testable and the file stays importable from the
 * test runtime.
 */

/** The one service method the wrapper replaces (mirror of the runtime IWorkspaces). */
export interface OpenPathService {
  openPath(path: string): Promise<void>
}

/** Per-call decisions the wrapper needs (wired to the store + ctx in the client half). */
export interface OpenPathInterceptDeps {
  /**
   * Whether to take over this call (the `interceptOpenPath` preference).
   */
  takeoverEnabled(): boolean
  /** The current session whose cwd scopes Preview/file-edit/download. */
  currentSessionId(): string | undefined
  /** Route through the unified file opener; `fallback` invokes the untouched Host/OS method. */
  openInSidebar(path: string, sessionId: string, fallback: () => Promise<void>): void | Promise<void>
}

/**
 * Wrap `workspaces.openPath`: intercepted calls use the unified file router;
 * the untouched Host/OS method is passed in as its final fallback.
 * @param workspaces - the client workspaces service to wrap.
 * @param deps - per-call takeover decisions.
 * @returns the disposer restoring the original method (HMR-safe).
 */
export function wrapOpenPath(workspaces: OpenPathService, deps: OpenPathInterceptDeps): () => void {
  // The RAW method reference (never a bound copy): restore must put back the
  // exact original so a chain of wrappers (other plugins wrapping the same
  // method) keeps working across disposals in any order.
  const original = workspaces.openPath
  workspaces.openPath = (path: string): Promise<void> => {
    if (deps.takeoverEnabled()) {
      const sessionId = deps.currentSessionId()
      if (sessionId !== undefined) {
        return Promise.resolve(deps.openInSidebar(
          path,
          sessionId,
          () => original.call(workspaces, path),
        ))
      }
    }
    return original.call(workspaces, path)
  }
  return () => {
    workspaces.openPath = original
  }
}
