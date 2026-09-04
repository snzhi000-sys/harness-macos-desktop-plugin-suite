import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileStore } from '../src/file-store.ts'

const image = {
  ref: {
    attachmentId: AttachmentId(`sha256:${'e'.repeat(64)}`),
    mediaType: 'image/png' as const,
    bytes: 3,
    width: 1,
    height: 1,
  },
  data: Uint8Array.from([1, 2, 3]),
}

describe('DeepSeekFileStore', () => {
  it('shares one upload while cancellation remains local to each waiter', async () => {
    const response = Promise.withResolvers<Response>()
    let transportSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      transportSignal = init?.signal as AbortSignal | undefined
      return response.promise
    })
    const index = {
      get: vi.fn(async () => undefined),
      commit: vi.fn(async (record: object) => record),
      remove: vi.fn(async () => {}),
    }
    const store = new DeepSeekFileStore(index as never, fetchImpl as typeof fetch, () => 1_000)
    const first = new AbortController()
    const second = new AbortController()
    const a = store.ensureUploaded(image, { baseURL: 'https://api.example', apiKey: 'key' }, {
      expiresAfterSeconds: 60,
      refreshMarginSeconds: 5,
    }, first.signal)
    const b = store.ensureUploaded(image, { baseURL: 'https://api.example', apiKey: 'key' }, {
      expiresAfterSeconds: 60,
      refreshMarginSeconds: 5,
    }, second.signal)
    first.abort(new Error('first stopped'))
    await expect(a).rejects.toThrow('first stopped')
    expect(transportSignal?.aborted).toBe(false)
    response.resolve(new Response(JSON.stringify({
      id: 'file-shared', bytes: 3, created_at: 1, expires_at: 61,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(b).resolves.toBe('file-shared')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})
