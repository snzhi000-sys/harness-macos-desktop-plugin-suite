/** DeepSeek Files API upload reuse and exact stale-id invalidation. */

import type { StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFilesClient } from './files-api.ts'
import { deepSeekFileScope, DeepSeekUploadIndex } from './upload-index.ts'

export interface DeepSeekFilePolicy {
  expiresAfterSeconds: number
  refreshMarginSeconds: number
}

export interface DeepSeekFileConnection { baseURL: string; apiKey: string }

interface SharedUpload {
  controller: AbortController
  promise: Promise<string>
  settled: boolean
  waiters: number
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error
    ? reason
    : new Error('DeepSeek file upload cancelled with a non-Error reason.', { cause: reason })
}

function waitForUpload(operation: SharedUpload, signal: AbortSignal | undefined): Promise<string> {
  signal?.throwIfAborted()
  operation.waiters += 1
  let released = false
  const release = (cancelled: boolean): void => {
    if (released) return
    released = true
    operation.waiters -= 1
    if (cancelled && operation.waiters === 0 && !operation.settled) {
      operation.controller.abort(signal === undefined ? undefined : abortReason(signal))
    }
  }
  if (signal === undefined) return operation.promise.finally(() => { release(false) })
  return new Promise<string>((resolve, reject) => {
    const abort = (): void => {
      release(true)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
    void operation.promise.then((value) => {
      signal.removeEventListener('abort', abort)
      release(false)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort)
      release(false)
      reject(error instanceof Error
        ? error
        : new Error('DeepSeek shared file upload failed with a non-Error reason.', { cause: error }))
    })
  })
}

export class DeepSeekFileStore {
  private readonly inflight = new Map<string, SharedUpload>()

  constructor(
    private readonly index = new DeepSeekUploadIndex(),
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  ensureUploaded(
    image: StoredImageAttachment,
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted()
    const scope = deepSeekFileScope(connection.baseURL, connection.apiKey)
    const key = `${scope}\0${image.ref.attachmentId}`
    let existing = this.inflight.get(key)
    if (existing?.controller.signal.aborted) {
      this.inflight.delete(key)
      existing = undefined
    }
    if (existing !== undefined) return waitForUpload(existing, signal)
    const controller = new AbortController()
    const operation: SharedUpload = {
      controller,
      settled: false,
      waiters: 0,
      promise: undefined as never,
    }
    operation.promise = this.ensureUploadedOnce(image, connection, policy, controller.signal).then((value) => {
      operation.settled = true
      return value
    }, (error: unknown) => {
      operation.settled = true
      throw error
    })
    this.inflight.set(key, operation)
    void operation.promise.finally(() => {
      if (this.inflight.get(key) === operation) this.inflight.delete(key)
    }).catch(() => {})
    return waitForUpload(operation, signal)
  }

  private async ensureUploadedOnce(
    image: StoredImageAttachment,
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    signal?: AbortSignal,
  ): Promise<string> {
    const scope = deepSeekFileScope(connection.baseURL, connection.apiKey)
    const attachmentId = String(image.ref.attachmentId)
    const cached = await this.index.get(scope, attachmentId, this.now(), policy.refreshMarginSeconds * 1_000)
    if (cached !== undefined) return cached.fileId
    const remote = await new DeepSeekFilesClient(connection.baseURL, connection.apiKey, this.fetchImpl)
      .upload(image, policy.expiresAfterSeconds, signal)
    return (await this.index.commit({
      scope,
      attachmentId,
      fileId: remote.id,
      bytes: remote.bytes,
      createdAt: remote.createdAt,
      expiresAt: remote.expiresAt,
    }, this.now(), policy.refreshMarginSeconds * 1_000)).fileId
  }

  async invalidate(image: StoredImageAttachment, fileId: string, connection: DeepSeekFileConnection): Promise<void> {
    await this.index.remove(deepSeekFileScope(connection.baseURL, connection.apiKey), String(image.ref.attachmentId), fileId)
  }
}
