/**
 * Projection-cache compatibility through the real JSON storage stack.
 * Synthetic fixtures reproduce the shipped v3 single-unit and v4/v5
 * per-record media without containing user Session data.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '../src/index.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'compat/title': string | null
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'compat/title': { title: string }
  }

  interface OutOfBandSessionEventMap {
    'compat/title': true
  }
}

const titleUnit = {
  key: 'compat/title',
  schema: z.string(),
  init: () => null,
  apply: (state, event) => event.type === 'compat/title' ? event.data.title : state,
  view: state => state,
  stateVersion: 1,
} satisfies ProjectionDefinition<'compat/title', string | null>

interface Fixture {
  readonly id: string
  readonly version: 3 | 4 | 5
  readonly legacy: boolean
  readonly title: string
}

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function record(title: string) {
  return {
    identity: { createdAt: 7 },
    rows: { 'compat/title': { ver: 1, seq: 0, val: title } },
  }
}

async function seed(root: string, fixture: Fixture): Promise<void> {
  if (fixture.legacy) {
    await writeFile(join(root, 'session_projcache.json'), JSON.stringify({
      unit: { name: 'session_projcache', version: fixture.version },
      global: null,
      tables: { sessions: { [fixture.id]: record(fixture.title) } },
    }))
    return
  }
  const path = join(root, 'session_projcache', 'sessions', `${fixture.id}.json`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ version: fixture.version, record: record(fixture.title) }))
}

async function harness(root: string, fixture: Fixture) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('json', new JsonStorageBackend(root))
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(titleUnit)
  const event: SessionEvent = {
    type: 'compat/title',
    seq: 0,
    time: 0,
    data: { title: fixture.title },
  }
  ctx.provide('sessionPersistence', {
    readFrom: vi.fn(async (id: SessionId, fromSeq: number) => ({
      meta: header(id),
      events: fromSeq <= 0 ? [event] : [],
    })),
  } as never)
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
  return ctx.sessionProjectionCache
}

function header(id: SessionId): SessionHeader {
  return { version: 0, id, createdAt: 7 }
}

describe('projection-cache version compatibility', () => {
  const fixtures: Fixture[] = [
    { id: 'fixture-v3', version: 3, legacy: true, title: 'v3 title' },
    { id: 'fixture-v4', version: 4, legacy: false, title: 'v4 title' },
    { id: 'fixture-v5', version: 5, legacy: false, title: 'v5 title' },
  ]

  for (const fixture of fixtures) {
    it(`reads and rewrites the v${fixture.version} fixture`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-compat-'))
      roots.push(root)
      await seed(root, fixture)
      const cache = await harness(root, fixture)
      const id = SessionId(fixture.id)
      expect(cache.cachedSnapshot(header(id))?.values['compat/title']).toBe(fixture.title)
      await cache.coldSnapshot(id)
      const path = join(root, 'session_projcache', 'sessions', `${fixture.id}.json`)
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 5 })
    })
  }

  it('ignores an unknown future version while preserving its document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-compat-'))
    roots.push(root)
    const fixture = { id: 'future', version: 5, legacy: false, title: 'future' } satisfies Fixture
    const path = join(root, 'session_projcache', 'sessions', 'future.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 99, record: record('future') }))
    const cache = await harness(root, fixture)
    expect(cache.cachedSnapshot(header(SessionId('future')))).toBeUndefined()
    expect(await readFile(path, 'utf8')).toContain('"version":99')
  })

  it('backs up a schema-invalid record and starts with that cache absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-compat-'))
    roots.push(root)
    const fixture = { id: 'invalid', version: 5, legacy: false, title: 'invalid' } satisfies Fixture
    const path = join(root, 'session_projcache', 'sessions', 'invalid.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({
      version: 5,
      record: { identity: { createdAt: 7 }, rows: { 'compat/title': { ver: 1, seq: 'bad', val: 'x' } } },
    }))
    const cache = await harness(root, fixture)
    expect(cache.cachedSnapshot(header(SessionId('invalid')))).toBeUndefined()
    const names = await readdir(dirname(path))
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^invalid\.json\.bak\.\d{17}-[0-9a-f-]{36}$/)
  })

  it.runIf(process.platform !== 'win32')('fails safely when an invalid record cannot be backed up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-compat-'))
    roots.push(root)
    const fixture = { id: 'readonly', version: 5, legacy: false, title: 'invalid' } satisfies Fixture
    const path = join(root, 'session_projcache', 'sessions', 'readonly.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({
      version: 5,
      record: { identity: { createdAt: 7 }, rows: { 'compat/title': { ver: 1, seq: 'bad', val: 'x' } } },
    }))
    await chmod(dirname(path), 0o500)
    try {
      await expect(harness(root, fixture)).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toContain('"seq":"bad"')
    } finally {
      await chmod(dirname(path), 0o700)
    }
  })

  it('never lets a lineage-less cache seed a forked Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-compat-'))
    roots.push(root)
    const fixture = { id: 'forked', version: 4, legacy: false, title: 'parent title' } satisfies Fixture
    await seed(root, fixture)
    const cache = await harness(root, fixture)
    expect(cache.cachedSnapshot({
      ...header(SessionId('forked')),
      parentSession: SessionId('parent'),
      seedLength: 3,
    })).toBeUndefined()
  })
})
