/** Session-addressed activation state for conversation views. */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

const DEFAULT_VIEW_ID = 'chat'

interface ViewBinding {
  readonly setView: (viewId: string) => void
}

/** Coordinates external view requests with the session store that owns the tab selection. */
export class ConversationViewActivation {
  private readonly stores = new Map<SessionId, SnapshotStore<string>>()
  private readonly bindings = new Map<SessionId, ViewBinding>()
  private readonly pending = new Set<SessionId>()

  /** Request a view even when its Session UI has not mounted yet. */
  activate(sessionId: SessionId, viewId: string): void {
    this.storeFor(sessionId).set(viewId)
    const binding = this.bindings.get(sessionId)
    if (binding === undefined) {
      this.pending.add(sessionId)
      return
    }
    this.pending.delete(sessionId)
    binding.setView(viewId)
  }

  /** Observable active view used by the resident conversation shell. */
  storeFor(sessionId: SessionId): SnapshotStore<string> {
    const existing = this.stores.get(sessionId)
    if (existing !== undefined) return existing
    const created = createSnapshotStore(DEFAULT_VIEW_ID)
    this.stores.set(sessionId, created)
    return created
  }

  /** Bind the real store action and reconcile a queued request or persisted selection. */
  bind(sessionId: SessionId, selectedView: string | null, setView: (viewId: string) => void): () => void {
    const binding: ViewBinding = { setView }
    this.bindings.set(sessionId, binding)
    if (this.pending.delete(sessionId)) {
      setView(this.storeFor(sessionId).getSnapshot())
    } else {
      this.sync(sessionId, selectedView)
    }
    return () => {
      if (this.bindings.get(sessionId) === binding) this.bindings.delete(sessionId)
    }
  }

  /** Mirror a user-selected or persisted tab into the resident shell. */
  sync(sessionId: SessionId, selectedView: string | null): void {
    if (this.pending.has(sessionId)) return
    const next = selectedView ?? DEFAULT_VIEW_ID
    const store = this.storeFor(sessionId)
    if (store.getSnapshot() !== next) store.set(next)
  }

  /** Release browser-lifetime coordination state. */
  dispose(): void {
    this.bindings.clear()
    this.pending.clear()
    this.stores.clear()
  }
}
