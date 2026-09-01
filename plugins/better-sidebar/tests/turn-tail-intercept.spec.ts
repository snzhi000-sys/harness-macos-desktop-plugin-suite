/**
 * Turn-tail interception registration spec (issue #15): `registerTurnTailInterception`
 * must go through `ctx.slots.inject` — the slot is a CHILD slot the host's
 * ui-conversation declares in its `conversation.chat.node` children table, so a
 * direct `slots.register` races the declaration and the ui-slots core throws
 * "not declared (a parent entry's children table must declare it)".
 *
 * The fake `slots` mirrors SlotRegistry.inject's semantics: run the callback
 * synchronously when the slot is already declared; otherwise wait and run it
 * when the declaration commits; the returned disposer cancels a pending wait
 * and disposes any active registration; the register disposer is idempotent.
 */
import { describe, expect, it, vi } from 'vitest'
import './browser-globals.ts'
import { allLeaves, createSidebarStore } from '../src/client/state.ts'
import { registerTurnTailInterception, synchronizeDeletedPath } from '../src/client/intercept.tsx'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import type { Context } from '../src/context-types.ts'

interface RegisteredSlot {
  options: Record<string, unknown>
  component: unknown
}

/**
 * A structural fake of the client slots service. `declared` selects the
 * timing: already-on-ledger (callback runs synchronously) vs. pending
 * (callback runs on `declare()`, unless the controller was disposed first).
 */
const fakeSlots = (declared: boolean) => {
  const registered: RegisteredSlot[] = []
  const disposals: number[] = []
  const pendings: Array<() => void> = []
  return {
    registered,
    disposals,
    pendings,
    slots: {
      register: (options: Record<string, unknown>, component: unknown) => {
        registered.push({ options, component })
        return () => { disposals.push(1) }
      },
      inject: (key: string, callback: () => () => void) => {
        if (key !== 'conversation.chat.turnTail') {
          throw new Error(`unexpected injected key "${key}"`)
        }
        let active: (() => void) | undefined
        let stopped = false
        const run = (): void => {
          if (stopped || active !== undefined) return
          active = callback()
        }
        if (declared) run()
        else pendings.push(run)
        return () => {
          stopped = true
          active?.()
          active = undefined
        }
      },
    },
  }
}

/** A produced-files owner currency: one closing assistant seq + its nodes. */
const producedOwner = (paths: string[]): unknown => ({
  nodes: [
    { kind: 'assistant', seq: 1, turn: 1 },
    ...paths.map(path => ({
      kind: 'tool-result', isError: false, callView: { card: 'diff', locations: [{ path }] },
    })),
    { kind: 'assistant', seq: 2, turn: 1 },
  ],
  seq: 2,
})

/** Current Harness owner shape: produced paths live on immutable Turn.data. */
const currentProducedOwner = (paths: string[]): unknown => ({
  turn: { data: new Map([['deliverables', { produced: paths.map((path, seq) => ({ path, seq: seq + 1 })) }]]) },
  seq: paths.length + 1,
  openFile: () => {},
})

const emptyOwner = (): unknown => ({ nodes: [{ kind: 'assistant', seq: 1, turn: 1 }], seq: 1 })

/** The minimal client-context fake the registration (and its seats) touch. */
const clientCtx = (slots: unknown, betterSidebar: BetterSidebarService | { openTab: ReturnType<typeof vi.fn> } = { openTab: vi.fn() }): Context => ({
  slots,
  sessions: {
    list: { getSnapshot: () => ({ current: 's1', byId: { s1: { id: 's1', cwd: '/w', displayTitle: 's1' } } }) },
  },
  betterSidebar,
} as unknown as Context)

describe('turn-tail interception registration (issue #15)', () => {
  it('keeps top file tabs as deleted while removing sidebar previews', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'preview', title: 'Preview', hidden: true, dedupeKey: tab => tab.path, component: () => null })
    service.openTab({ type: 'preview', path: '/w/deleted/file.md', title: 'file.md' })
    const markDeleted = vi.fn()
    const remove = vi.fn()
    ;(window as typeof window & { __dshFileEdit?: unknown }).__dshFileEdit = { markDeleted, remove }

    synchronizeDeletedPath(store, '/w', '/w/deleted')

    expect(allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)).toHaveLength(0)
    expect(markDeleted).toHaveBeenCalledWith('deleted')
    expect(remove).not.toHaveBeenCalled()
    delete (window as typeof window & { __dshFileEdit?: unknown }).__dshFileEdit
  })

  it('registers through slots.inject and lands once the slot is already declared', () => {
    const fake = fakeSlots(true)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(clientCtx(fake.slots), store)

    // Exactly one registration, with the takeover descriptor.
    expect(fake.registered).toHaveLength(1)
    const { options, component } = fake.registered[0]!
    expect(options.name).toBe('conversation.chat.turnTail')
    expect(options.priority).toBe(-1)
    expect(options.registrant).toBe('dsh-better-sidebar')
    expect(options.select).toBeTypeOf('function')
    expect(options.inject).toBeTypeOf('function')
    expect(component).toBeTypeOf('function')

    // Disposal removes the registration; the disposer is idempotent.
    restore()
    expect(fake.disposals).toHaveLength(1)
    restore()
    expect(fake.disposals).toHaveLength(1)
  })

  it('waits for the host declaration instead of throwing (the pre-fix race)', () => {
    const fake = fakeSlots(false)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(clientCtx(fake.slots), store)

    // The slot is undeclared: nothing registered yet, no error.
    expect(fake.registered).toHaveLength(0)

    // The host's ui-conversation commits the declaration → the entry lands.
    expect(fake.pendings).toHaveLength(1)
    fake.pendings[0]!()
    expect(fake.registered).toHaveLength(1)

    // A later re-declaration does not double-register while the entry is live.
    fake.pendings[0]!()
    expect(fake.registered).toHaveLength(1)

    restore()
    expect(fake.disposals).toHaveLength(1)
  })

  it('a disposal before the declaration cancels the wait permanently', () => {
    const fake = fakeSlots(false)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(clientCtx(fake.slots), store)
    restore()

    // The declaration arrives after the controller was disposed: ignored.
    fake.pendings[0]!()
    expect(fake.registered).toHaveLength(0)
  })

  it('keeps the unified takeover active when the legacy editor tab is disabled', () => {
    const fake = fakeSlots(true)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(clientCtx(fake.slots), store)
    const select = fake.registered[0]!.options.select as (owner: unknown) => unknown

    // Enabled (default): a produced turn claims the chain; an empty one declines.
    expect(select(producedOwner(['a.ts', 'b.ts']))).toEqual(['a.ts', 'b.ts'])
    expect(select(currentProducedOwner(['/tmp/external.md']))).toEqual(['/tmp/external.md'])
    expect(select(emptyOwner())).toBeNull()

    // The legacy editor is no longer a destination. Preview, dsh-file-edit,
    // and download/system fallback remain available.
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { editor: false } })
    expect(select(producedOwner(['a.ts']))).toEqual(['a.ts'])

    restore()
  })

  it('wires the produced-file seat to the same Preview router', async () => {
    const fake = fakeSlots(true)
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileViewer({ id: 'image', exts: ['png'], fetchStrategy: 'mediaUrl', component: () => null })
    service.registerTab({ id: 'preview', title: 'Preview', hidden: true, dedupeKey: tab => tab.path, component: () => null })
    store.setSession('s1')
    const ctx = clientCtx(fake.slots, service)
    const restore = registerTurnTailInterception(ctx, store)
    const inject = fake.registered[0]!.options.inject as (sessionId: string) => {
      openInSidebar: (path: string) => void
    }

    // The seat hands the session-scoped opener to the chips row.
    const seat = inject('s1')
    expect(seat.openInSidebar).toBeTypeOf('function')
    seat.openInSidebar('/w/assets/a.png')
    await Promise.resolve()
    expect(allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)).toContainEqual(expect.objectContaining({
      type: 'preview', path: '/w/assets/a.png', viewerId: 'image',
    }))

    restore()
  })
})
