/**
 * Workspace lineage host half: persist user-confirmed branch display titles
 * under DSH_HOME and expose them to the browser half. Session title mutation
 * itself remains on Harness' standard session.rename RPC.
 */
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: installs the webServer Context augmentation.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { BranchTitleStore } from './branch-title-store.ts'

export const name = 'workspace-lineage'
export const inject = ['webServer']

const API_PATH = '/workspace-lineage/branch-titles'
const BODY_LIMIT = 64 * 1024

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > BODY_LIMIT) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text) as unknown
}

function stringField(value: unknown, key: 'sessionId' | 'title'): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('request body must be an object')
  }
  const field = (value as Record<string, unknown>)[key]
  if (typeof field !== 'string' || field.trim() === '') throw new TypeError(`${key} must be a non-empty string`)
  return field
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Register the branch-title persistence route. */
export function apply(ctx: Context): void {
  const store = new BranchTitleStore(join(
    process.env.DSH_HOME ?? process.cwd(),
    'state',
    'dsh-workspace-lineage',
    'branch-titles.json',
  ))
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH,
    handler: async (req, res) => {
      try {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden' })
          return
        }
        if (req.method === 'GET') {
          writeJson(res, 200, { titles: await store.get() })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        const body = await readJson(req)
        const sessionId = stringField(body, 'sessionId')
        const title = stringField(body, 'title')
        writeJson(res, 200, { titles: await store.set(sessionId, title) })
      } catch (error) {
        writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-workspace-lineage: branch title route')
}
