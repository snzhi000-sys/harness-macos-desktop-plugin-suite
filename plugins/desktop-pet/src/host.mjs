/** Host routes serve the pet view and configured local assets inside bounded roots. */
import { readFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defaultSettings, readSettings, writeSettings } from './settings.mjs'
import { builtinLibrary, assetRoot } from './builtin-library.mjs'
import { createConversationHost } from './conversation-host.mjs'
export { containedAsset } from './model-library.mjs'

export const name = 'desktop-pet'
export const inject = ['webServer']
/** Deployment defaults can be patched through cordis.yml; saved local preferences take precedence. */
export const Config = z.object({ automaticActionIntervalMs: z.number().min(1000).max(3600000).default(60000), defaults: z.object({
  modelId: z.string().default(''),
  height: z.number().step(1).min(180).max(1000).default(defaultSettings.height),
  animated: z.boolean().default(true), alwaysOnTop: z.boolean().default(true),
}).default({}) })
const base = '/desktop-pet'
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.moc3': 'application/octet-stream', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' }

/** Register local-only routes and release them when Cordis unloads the plugin. */
export function apply(ctx, config = {}) {
  if (!process.env.DSH_HOME) throw new Error('desktop-pet requires DSH_HOME')
  const path = join(process.env.DSH_HOME, 'state', 'dsh-desktop-pet', 'settings.json')
  let settings = readSettings(path, config.defaults)
  const library = builtinLibrary()
  settings.modelId = library.resolveSaved(settings.modelId, dirname(path))
  // Persist only the new schema; private legacy model files remain untouched.
  settings = writeSettings(path, settings)
  ctx.effect(() => {
    const conversation = createConversationHost(dirname(path))
    const unregister = ctx.webServer.register({ kind: 'prefix', path: base, handler: async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    try {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return json(403, { error: 'Local access only' })
      const origin = `http://${req.headers.host}`
      const url = new URL(req.url, origin)
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return json(403, { error: 'Loopback host required' })
      if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: 'Origin mismatch' })
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Cross-site access denied' })
      if (await conversation.handle(req, res, url)) return
      if (url.pathname === `${base}/api/models` && req.method === 'GET') return json(200, library.list())
      if (url.pathname === `${base}/api/model` && req.method === 'GET') return json(200, {...await library.describe(url.searchParams.get('id') || settings.modelId),automaticActionIntervalMs:config.automaticActionIntervalMs ?? 60000})
      if (url.pathname === `${base}/api/settings`) {
        if (req.method === 'GET') return json(200, settings)
        if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'JSON required' })
        let size = 0
        const chunks = []
        for await (const chunk of req) { size += chunk.length; if (size > 32768) return json(413, { error: 'Settings too large' }); chunks.push(chunk) }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (value?.modelId) await library.get(value.modelId)
        settings = writeSettings(path, { ...value, modelId: value.modelId || library.defaultId })
        return json(200, settings)
      }
      if (req.method !== 'GET') return json(405, { error: 'Method not allowed' })
      let file
      if (url.pathname === `${base}/core.js`) file = join(assetRoot, 'cores/live2dcubismcore.min.js')
      else if (url.pathname === `${base}/core2.js`) file = join(assetRoot, 'cores/live2d.min.js')
      else if (url.pathname === `${base}/pixi8.js`) file = join(assetRoot, 'cores/pixi8.js')
      else if (url.pathname === `${base}/dragonbones-core.js`) file = join(assetRoot, 'cores/dragonbones.js')
      else if (url.pathname === `${base}/spine-core.js`) file = join(assetRoot, 'cores/spine-webgl.js')
      else if (url.pathname.startsWith(`${base}/models/`)) {
        const [id, ...parts] = decodeURIComponent(url.pathname.slice(`${base}/models/`.length)).split('/')
        file = await library.asset(id, parts.join('/'))
      }
      else {
        const files = { [`${base}/chat`]: 'chat.html', [`${base}/chat.js`]: 'chat.js', [`${base}/recorder-worklet.js`]: 'recorder-worklet.js', [`${base}/view`]: 'view.html', [`${base}/view.js`]: 'view.js', [`${base}/live2d.js`]: 'live2d.js', [`${base}/live2d2.js`]: 'live2d2.js', [`${base}/dragonbones.js`]: 'dragonbones.js', [`${base}/spine.js`]: 'spine.js' }
        if (!files[url.pathname]) return json(404, { error: 'Not found' })
        file = join(dist, files[url.pathname])
      }
      if (!file) return json(404, { error: '请先在桌宠设置中选择素材' })
      const data = await readFile(file)
      res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'" })
      res.end(data)
    } catch (error) { json(400, { error: error.message }) }
    } })
    return () => { unregister(); return conversation.dispose() }
  }, 'desktop-pet: local routes')
}
