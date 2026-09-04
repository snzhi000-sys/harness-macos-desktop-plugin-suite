import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFilesClient, DeepSeekFilesError } from '../src/files-api.ts'

const image = {
  ref: {
    attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
    mediaType: 'image/png' as const,
    bytes: 3,
    width: 1,
    height: 1,
  },
  data: Uint8Array.from([1, 2, 3]),
}

describe('DeepSeekFilesClient', () => {
  it('uploads an owner-named user_data file with explicit expiry', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret')
      const form = init?.body as FormData
      expect(form.get('purpose')).toBe('user_data')
      expect(form.get('expires_after[seconds]')).toBe('604800')
      return new Response(JSON.stringify({
        id: 'file-1', object: 'file', bytes: 3, created_at: 100, expires_at: 604900,
        filename: 'dsh-image.png', purpose: 'user_data',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await expect(new DeepSeekFilesClient('https://api.example', 'secret', fetchImpl as typeof fetch)
      .upload(image, 604800)).resolves.toEqual({ id: 'file-1', bytes: 3, createdAt: 100_000, expiresAt: 604_900_000 })
  })

  it('retains provider status and detail for controlled fallback', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'files disabled' } }), {
      status: 404, headers: { 'content-type': 'application/json' },
    }))
    await expect(new DeepSeekFilesClient('https://api.example', 'secret', fetchImpl as typeof fetch)
      .upload(image, 604800)).rejects.toBeInstanceOf(DeepSeekFilesError)
  })
})
