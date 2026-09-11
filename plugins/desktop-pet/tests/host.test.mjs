import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { apply, Config, containedAsset } from '../src/host.mjs'
import { readSettings, writeSettings } from '../src/settings.mjs'
import { builtinLibrary } from '../src/builtin-library.mjs'

test('legacy selected character maps to its built-in version without copying private assets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-migrate-'))
  try {
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ version: 1, models: [{ id: 'old-private-id', name: 'galgame live2d · mori_miko', entry: '/old/private/path' }] }))
    const library = builtinLibrary()
    assert.equal(library.resolveSaved('old-private-id', dir), 'companion-20')
    assert.equal(library.resolveSaved('companion-24', dir), 'companion-24')
    assert.equal(library.resolveSaved('removed-character', dir), library.defaultId)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('private settings persist, reject invalid updates, and do not reset corrupt files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-settings-'))
  const file = join(dir, 'settings.json')
  try {
    assert.equal(readSettings(file).height, 420)
    assert.equal(readSettings(file, { height: 550 }).height, 550)
    assert.throws(() => Config({ defaults: { height: 10 } }))
    writeSettings(file, { height: 600 })
    assert.equal(readSettings(file).height, 600)
    assert.equal(readSettings(file, { height: 550 }).height, 600)
    assert.throws(() => writeSettings(file, { height: -1 }))
    assert.equal(readSettings(file).height, 600)
    writeFileSync(file, JSON.stringify({ version: 1, height: 350, animated: false, alwaysOnTop: false, renderer: 'png', imagePath: '/obsolete.png' }))
    assert.deepEqual(readSettings(file), { version: 2, modelId: '', height: 350, animated: false, alwaysOnTop: false })
    writeFileSync(file, '{oops')
    assert.throws(() => readSettings(file))
    writeFileSync(file, 'null')
    assert.throws(() => readSettings(file))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('model resource resolution rejects traversal and symlink escapes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-assets-'))
  try {
    const root = join(dir, 'model'); mkdirSync(root)
    writeFileSync(join(root, 'texture.png'), 'inside')
    writeFileSync(join(dir, 'outside.png'), 'outside')
    symlinkSync(join(dir, 'outside.png'), join(root, 'link.png'))
    assert.equal(await containedAsset(root, 'texture.png'), realpathSync(join(root, 'texture.png')))
    await assert.rejects(containedAsset(root, '../outside.png'))
    await assert.rejects(containedAsset(root, 'link.png'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('real HTTP routes save settings, serve only selected assets, and unload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-host-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  let route
  let dispose
  const server = createServer((req, res) => route ? void route.handler(req, res) : res.writeHead(404).end())
  try {
    apply({ webServer: { register(value) { route = value; return () => { route = undefined } } }, effect(factory) { dispose = factory() } })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const base = `http://127.0.0.1:${server.address().port}/desktop-pet`
    const models = await (await fetch(`${base}/api/models`)).json()
    assert.equal(models.length, 23)
    const update = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: models.at(-1).id }) })
    assert.equal(update.status, 200)
    assert.equal((await fetch(`${base}/image`)).status, 404)
    assert.equal((await fetch(`${base}/models/${models[0].id}/preview.png`)).status, 200)
    assert.equal((await fetch(`${base}/core.js`)).status, 200)
    for (const key of ['renderer', 'imagePath', 'modelPath', 'corePath', 'core2Path', 'parameters', 'motions', 'expressions', 'sessionId']) {
      assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: '' }) })).status, 400)
    }
    for (const action of ['import', 'discover', 'check', 'profile', 'preview']) assert.equal((await fetch(`${base}/api/${action}`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://other.example' }, body: '{}' })).status, 403)
    assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415)
    assert.equal((await fetch(`${base}/arbitrary-file`)).status, 404)
    dispose()
    assert.equal((await fetch(`${base}/api/settings`)).status, 404)
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
