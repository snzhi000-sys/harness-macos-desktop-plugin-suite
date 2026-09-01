import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ExplorerVisibilityStore,
  sanitizeExplorerUncommonPaths,
} from '../src/explorer-visibility-store.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(): { directory: string; root: string; state: string } {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-explorer-visibility-'))
  temporaryDirectories.push(directory)
  const root = join(directory, 'workspace')
  mkdirSync(join(root, 'archive'), { recursive: true })
  writeFileSync(join(root, 'notes.md'), '# notes\n')
  return { directory, root, state: join(directory, 'state', 'explorer-visibility.json') }
}

describe('ExplorerVisibilityStore', () => {
  it('persists marked paths and the hide toggle across fresh Host instances', async () => {
    const { root, state } = fixture()
    const first = new ExplorerVisibilityStore(state)
    await first.set(root, {
      paths: [
        { path: join(root, 'archive'), isDir: true },
        { path: join(root, 'notes.md'), isDir: false },
      ],
      hideUncommon: true,
    })

    expect(await new ExplorerVisibilityStore(state).get(root)).toEqual({
      paths: [
        { path: join(root, 'archive'), isDir: true },
        { path: join(root, 'notes.md'), isDir: false },
      ],
      hideUncommon: true,
    })
  })

  it('applies a pre-hydration hidden-state change without replacing persisted paths', async () => {
    const { root, state } = fixture()
    const first = new ExplorerVisibilityStore(state)
    await first.set(root, {
      paths: [{ path: join(root, 'archive'), isDir: true }],
      hideUncommon: true,
    })

    // This models a freshly mounted Client whose local React state is still
    // the empty default: it sends only the click intent, never that snapshot.
    expect(await new ExplorerVisibilityStore(state).update(root, { kind: 'set-hidden', hidden: false })).toEqual({
      paths: [{ path: join(root, 'archive'), isDir: true }],
      hideUncommon: false,
    })
    expect(await new ExplorerVisibilityStore(state).get(root)).toEqual({
      paths: [{ path: join(root, 'archive'), isDir: true }],
      hideUncommon: false,
    })
  })

  it('serializes simultaneous Explorer mutations against the authoritative record', async () => {
    const { root, state } = fixture()
    mkdirSync(join(root, 'second'), { recursive: true })
    const store = new ExplorerVisibilityStore(state)
    await Promise.all([
      store.update(root, { kind: 'toggle-path', path: join(root, 'archive'), isDir: true }),
      store.update(root, { kind: 'toggle-path', path: join(root, 'second'), isDir: true }),
      store.update(root, { kind: 'set-hidden', hidden: true }),
    ])
    expect(await new ExplorerVisibilityStore(state).get(root)).toEqual({
      paths: [
        { path: join(root, 'archive'), isDir: true },
        { path: join(root, 'second'), isDir: true },
      ],
      hideUncommon: true,
    })
  })

  it('keeps an explicitly saved hidden state stable when the request is replayed and the Host restarts', async () => {
    const { root, state } = fixture()
    const store = new ExplorerVisibilityStore(state)
    await store.update(root, { kind: 'toggle-path', path: join(root, 'archive'), isDir: true })
    await Promise.all([
      store.update(root, { kind: 'set-hidden', hidden: true }),
      store.update(root, { kind: 'set-hidden', hidden: true }),
    ])

    expect(await new ExplorerVisibilityStore(state).get(root)).toEqual({
      paths: [{ path: join(root, 'archive'), isDir: true }],
      hideUncommon: true,
    })
  })

  it('prunes missing paths without resetting the saved visibility toggle', async () => {
    const { root, state } = fixture()
    const store = new ExplorerVisibilityStore(state)
    await store.set(root, {
      paths: [{ path: join(root, 'notes.md'), isDir: false }],
      hideUncommon: true,
    })
    rmSync(join(root, 'notes.md'))
    expect(await new ExplorerVisibilityStore(state).get(root)).toEqual({ paths: [], hideUncommon: true })
  })

  it('returns persisted visibility before deferred filesystem reconciliation', async () => {
    const { root, state } = fixture()
    const missing = join(root, 'later-removed.md')
    const store = new ExplorerVisibilityStore(state)
    await store.set(root, { paths: [{ path: missing, isDir: false }], hideUncommon: true })

    expect(await new ExplorerVisibilityStore(state).snapshot(root)).toEqual({
      paths: [{ path: missing, isDir: false }],
      hideUncommon: true,
    })
    expect(await new ExplorerVisibilityStore(state).get(root)).toEqual({ paths: [], hideUncommon: true })
  })

  it('rejects the workspace root, outside paths, and duplicates', () => {
    const { root } = fixture()
    expect(sanitizeExplorerUncommonPaths(root, [
      { path: root, isDir: true },
      { path: '/tmp/outside', isDir: false },
      { path: join(root, 'archive'), isDir: true },
      { path: join(root, 'archive'), isDir: false },
    ])).toEqual([{ path: join(root, 'archive'), isDir: true }])
  })
})
