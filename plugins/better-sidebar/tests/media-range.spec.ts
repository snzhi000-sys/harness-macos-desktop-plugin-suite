import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import { apply, mediaTypeForPath, parseMediaRange, streamFileToResponse } from '../src/index.ts'
import type { SidebarConfig } from '../src/config.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('single HTTP byte ranges', () => {
  it('parses closed, open-ended, and suffix ranges', () => {
    expect(parseMediaRange(undefined, 4096)).toEqual({ kind: 'full' })
    expect(parseMediaRange('bytes=0-0', 4096)).toEqual({ kind: 'partial', start: 0, end: 0 })
    expect(parseMediaRange('bytes=0-1023', 4096)).toEqual({ kind: 'partial', start: 0, end: 1023 })
    expect(parseMediaRange('bytes=1024-', 4096)).toEqual({ kind: 'partial', start: 1024, end: 4095 })
    expect(parseMediaRange('bytes=-1024', 4096)).toEqual({ kind: 'partial', start: 3072, end: 4095 })
    expect(parseMediaRange('bytes=-8192', 4096)).toEqual({ kind: 'partial', start: 0, end: 4095 })
    expect(parseMediaRange('bytes=4000-9000', 4096)).toEqual({ kind: 'partial', start: 4000, end: 4095 })
  })

  it('rejects malformed, empty, reversed, out-of-bounds, zero suffix, multi, and empty-file ranges', () => {
    for (const value of [
      'bytes=',
      'bytes=-',
      'bytes=10-9',
      'bytes=4096-',
      'bytes=-0',
      'bytes=0-1,4-5',
      'items=0-1',
      'bytes=9007199254740992-',
    ]) {
      expect(parseMediaRange(value, 4096), value).toEqual({ kind: 'invalid' })
    }
    expect(parseMediaRange('bytes=0-0', 0)).toEqual({ kind: 'invalid' })
    expect(parseMediaRange(undefined, 0)).toEqual({ kind: 'full' })
  })

  it('keeps offsets exact around 2GB and the 4GB default video ceiling', () => {
    const fourGiB = 4 * 1024 * 1024 * 1024
    expect(parseMediaRange('bytes=2147483648-2147484671', fourGiB)).toEqual({
      kind: 'partial', start: 2147483648, end: 2147484671,
    })
    expect(parseMediaRange('bytes=4294966272-', fourGiB)).toEqual({
      kind: 'partial', start: 4294966272, end: 4294967295,
    })
  })
})

interface HttpResult {
  status: number
  headers: IncomingMessage['headers']
  body: Buffer
}

function mountMediaRoute(root: string, config?: SidebarConfig): SidebarWebRoute {
  const routes: SidebarWebRoute[] = []
  const ctx = {
    loader: { entries: () => [] },
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (_route: SidebarWebUpgradeRoute) => () => {},
    },
    sessions: { get: () => ({ header: { cwd: root } }) },
    tools: { register: () => () => {} },
    effect: (fn: () => void | (() => void)) => { fn() },
    inject: () => () => {},
    get: () => undefined,
  }
  apply(ctx as never, config)
  return routes.find(route => route.path === '/sidebar/file')!
}

async function listen(route: SidebarWebRoute): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => { void route.handler(req, res) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing test server address')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

async function httpRequest(url: string, method = 'GET', headers: Record<string, string> = {}): Promise<HttpResult> {
  return await new Promise<HttpResult>((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.once('error', reject)
    req.end()
  })
}

function mediaUrl(origin: string, path: string): string {
  const query = new URLSearchParams({ sessionId: 'range-test', path })
  return `${origin}/sidebar/file?${query.toString()}`
}

describe('/sidebar/file video streaming integration', () => {
  it('maps the supported video extensions to browser media MIME types', () => {
    expect(mediaTypeForPath('clip.mp4')).toBe('video/mp4')
    expect(mediaTypeForPath('clip.m4v')).toBe('video/mp4')
    expect(mediaTypeForPath('clip.webm')).toBe('video/webm')
    expect(mediaTypeForPath('clip.mov')).toBe('video/quicktime')
    expect(mediaTypeForPath('clip.ogv')).toBe('video/ogg')
  })

  it('serves full GET, HEAD, and exact partial bytes with stable headers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-video-range-'))
    scratch.push(root)
    const file = join(root, 'clip.mp4')
    writeFileSync(file, '0123456789')
    const { server, origin } = await listen(mountMediaRoute(root))
    try {
      const full = await httpRequest(mediaUrl(origin, file))
      expect(full.status).toBe(200)
      expect(full.body.toString()).toBe('0123456789')
      expect(full.headers['content-type']).toBe('video/mp4')
      expect(full.headers['content-length']).toBe('10')
      expect(full.headers['accept-ranges']).toBe('bytes')
      expect(full.headers['x-content-type-options']).toBe('nosniff')
      expect(full.headers['cross-origin-resource-policy']).toBe('same-origin')
      expect(full.headers['content-encoding']).toBeUndefined()

      const head = await httpRequest(mediaUrl(origin, file), 'HEAD')
      expect(head.status).toBe(200)
      expect(head.headers['content-length']).toBe('10')
      expect(head.body).toHaveLength(0)

      const partial = await httpRequest(mediaUrl(origin, file), 'GET', { range: 'bytes=3-6' })
      expect(partial.status).toBe(206)
      expect(partial.body.toString()).toBe('3456')
      expect(partial.headers['content-length']).toBe('4')
      expect(partial.headers['content-range']).toBe('bytes 3-6/10')

      const suffixHead = await httpRequest(mediaUrl(origin, file), 'HEAD', { range: 'bytes=-4' })
      expect(suffixHead.status).toBe(206)
      expect(suffixHead.headers['content-length']).toBe('4')
      expect(suffixHead.headers['content-range']).toBe('bytes 6-9/10')
      expect(suffixHead.body).toHaveLength(0)
    } finally {
      await closeServer(server)
    }
  })

  it('returns 416 for malformed, out-of-bounds, and multipart ranges', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-video-range-invalid-'))
    scratch.push(root)
    const file = join(root, 'clip.webm')
    writeFileSync(file, '0123456789')
    const { server, origin } = await listen(mountMediaRoute(root))
    try {
      for (const range of ['bytes=20-', 'bytes=8-4', 'bytes=0-1,4-5']) {
        const result = await httpRequest(mediaUrl(origin, file), 'GET', { range })
        expect(result.status, range).toBe(416)
        expect(result.headers['content-range'], range).toBe('bytes */10')
        expect(result.headers['accept-ranges'], range).toBe('bytes')
        expect(result.headers['x-dsh-media-error'], range).toBe('range')
        expect(result.body, range).toHaveLength(0)
      }
    } finally {
      await closeServer(server)
    }
  })

  it('serves a tiny interval from a sparse file larger than 1GB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-video-range-large-'))
    scratch.push(root)
    const file = join(root, 'large.mp4')
    const size = 1024 * 1024 * 1024 + 17
    writeFileSync(file, '')
    truncateSync(file, size)
    const { server, origin } = await listen(mountMediaRoute(root))
    try {
      const head = await httpRequest(mediaUrl(origin, file), 'HEAD')
      expect(head.status).toBe(200)
      expect(head.headers['content-length']).toBe(String(size))

      const partial = await httpRequest(mediaUrl(origin, file), 'GET', { range: `bytes=${size - 17}-` })
      expect(partial.status).toBe(206)
      expect(partial.headers['content-range']).toBe(`bytes ${size - 17}-${size - 1}/${size}`)
      expect(partial.body).toEqual(Buffer.alloc(17))
    } finally {
      await closeServer(server)
    }
  })

  it('rechecks workspace and symlink boundaries and applies separate media/video limits', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-video-security-'))
    scratch.push(parent)
    const root = join(parent, 'workspace')
    mkdirSync(root)
    const outside = join(parent, 'outside.mp4')
    const video = join(root, 'inside.mp4')
    const image = join(root, 'inside.png')
    writeFileSync(outside, 'outside')
    writeFileSync(video, '0123456789')
    writeFileSync(image, '0123456789')
    symlinkSync(outside, join(root, 'escape.mp4'))
    const { server, origin } = await listen(mountMediaRoute(root, { mediaLimit: 5, videoLimit: 10 }))
    try {
      expect((await httpRequest(mediaUrl(origin, outside))).status).toBe(403)
      expect((await httpRequest(mediaUrl(origin, join(root, 'escape.mp4')))).status).toBe(403)
      // Video does not inherit the smaller image/document limit.
      expect((await httpRequest(mediaUrl(origin, video))).status).toBe(200)
      expect((await httpRequest(mediaUrl(origin, image))).status).toBe(413)
    } finally {
      await closeServer(server)
    }

    const limited = await listen(mountMediaRoute(root, { mediaLimit: 20, videoLimit: 9 }))
    try {
      const overLimit = await httpRequest(mediaUrl(limited.origin, video))
      expect(overLimit.status).toBe(413)
      expect(overLimit.headers['x-dsh-media-error']).toBe('too-large')
      const download = await httpRequest(`${mediaUrl(limited.origin, video)}&download=1`)
      expect(download.status).toBe(200)
      expect(download.body.toString()).toBe('0123456789')
      expect(download.headers['content-disposition']).toContain('attachment')

      const missing = await httpRequest(mediaUrl(limited.origin, join(root, 'missing.mp4')), 'HEAD')
      expect(missing.status).toBe(404)
      expect(missing.headers['x-dsh-media-error']).toBe('missing')
    } finally {
      await closeServer(limited.server)
    }
  })
})

describe('stream cancellation', () => {
  it('destroys the file stream when the client aborts', async () => {
    const req = new EventEmitter() as IncomingMessage
    const response = new Writable({ write: (_chunk, _encoding, callback) => callback() })
    const source = new Readable({ read: () => {} })
    const piping = streamFileToResponse(
      req,
      response as unknown as ServerResponse,
      '/unused.mp4',
      { start: 0, end: 9 },
      () => source,
    )
    req.emit('aborted')
    await piping
    expect(source.destroyed).toBe(true)
  })
})
