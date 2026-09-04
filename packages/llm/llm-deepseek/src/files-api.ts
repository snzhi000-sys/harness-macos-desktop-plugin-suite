/** Minimal DeepSeek Files API transport used by multimodal requests. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { StoredImageAttachment } from '@deepseek-ai/dsh-attachment'

export interface DeepSeekFileObject {
  id: string
  bytes: number
  createdAt: number
  expiresAt: number
}

export class DeepSeekFilesError extends LlmError {
  readonly detail: string

  constructor(message: string, status: number, detail: string) {
    super(message, status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'FILES_API', { status })
    this.name = 'DeepSeekFilesError'
    this.detail = detail
  }
}

function extension(mediaType: StoredImageAttachment['ref']['mediaType']): string {
  return mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length)
}

export class DeepSeekFilesClient {
  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async upload(image: StoredImageAttachment, expiresAfterSeconds: number, signal?: AbortSignal): Promise<DeepSeekFileObject> {
    const form = new FormData()
    form.set('purpose', 'user_data')
    form.set('expires_after[anchor]', 'created_at')
    form.set('expires_after[seconds]', String(expiresAfterSeconds))
    const digest = String(image.ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 20)
    form.set('file', new Blob([Uint8Array.from(image.data).buffer], { type: image.ref.mediaType }), `dsh-${digest}.${extension(image.ref.mediaType)}`)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseURL.replace(/\/+$/u, '')}/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      throw new LlmError(`DeepSeek Files API request to ${this.baseURL} failed`, 'TRANSPORT', { cause: error })
    }
    let value: unknown
    try { value = await response.json() } catch { value = undefined }
    if (!response.ok) {
      const detail = value !== null && typeof value === 'object'
        ? JSON.stringify(value)
        : ''
      const message = value !== null && typeof value === 'object'
        && typeof (value as { error?: { message?: unknown } }).error?.message === 'string'
        ? (value as { error: { message: string } }).error.message
        : `DeepSeek Files API error (HTTP ${response.status})`
      throw new DeepSeekFilesError(message, response.status, detail)
    }
    if (value === null || typeof value !== 'object') throw new LlmError('DeepSeek Files API returned an invalid upload response.', 'INVALID_RESPONSE')
    const file = value as Record<string, unknown>
    if (typeof file.id !== 'string' || file.id.length === 0
      || !Number.isSafeInteger(file.bytes) || (file.bytes as number) !== image.data.byteLength
      || !Number.isSafeInteger(file.created_at) || !Number.isSafeInteger(file.expires_at)) {
      throw new LlmError('DeepSeek Files API returned an invalid upload response.', 'INVALID_RESPONSE')
    }
    return {
      id: file.id,
      bytes: file.bytes as number,
      createdAt: (file.created_at as number) * 1_000,
      expiresAt: (file.expires_at as number) * 1_000,
    }
  }
}
