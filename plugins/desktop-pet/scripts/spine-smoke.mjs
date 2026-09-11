/** Test the built Spine adapter against an explicit export without admitting it to the catalogue. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { chromium } from 'playwright'
import { apply, containedAsset } from '../src/host.mjs'
import { inspectSpine } from '../src/spine-library.mjs'
const source = process.argv[2]
if (!source) throw new Error('Usage: node scripts/spine-smoke.mjs <Spine export directory>')
const files = await readdir(source), skeleton = files.find(f => f === 'skeleton.json' || f.endsWith('_ske.json')), atlas = files.find(f => f.endsWith('.atlas'))
const inspection = inspectSpine(JSON.parse(await readFile(join(source, skeleton), 'utf8')), await readFile(join(source, atlas), 'utf8'))
const info = { ...inspection, id: 'spine-research', kind: 'spine', skeleton, atlas, profile: { idle: 'idle', mouths: [], expressions: [], headRegion: { x: .25, y: 0, width: .5, height: .4 }, actions: { touch: { motion: 'diantou' }, click: { motion: 'shou1' }, drag: { motion: 'shou2' }, release: { motion: 'shou2' } } } }
const hasMouths = ['a', 'o', 'i', 'm'].every(name => inspection.animations.some(a => a.name === name && a.timelines))
if (hasMouths) { info.profile.mouths = ['a', 'o', 'i', 'm']; info.profile.neutralMouth = 'm' }
const output = resolve('../../desktop/.artifacts/spine-development'); await mkdir(output, { recursive: true })
const temp = await mkdtemp(join(tmpdir(), 'spine-smoke-')), previous = process.env.DSH_HOME; process.env.DSH_HOME = temp
let route, cleanup; apply({ webServer: { register(value) { route = value; return () => {} } }, effect(fn) { cleanup = fn() } })
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/fixture') { res.setHeader('content-type', 'text/html'); res.end('<body style="margin:0;background:#e7edf3"><div id="stage" style="width:600px;height:750px"></div><script src="/desktop-pet/spine-core.js"></script>'); return }
    if (path.startsWith('/desktop-pet/models/spine-research/')) { const file = await containedAsset(source, decodeURIComponent(path.slice('/desktop-pet/models/spine-research/'.length))); res.end(await readFile(file)); return }
    await route.handler(req, res)
  } catch (error) { res.writeHead(400); res.end(error.message) }
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 600, height: 750 } }), errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`)
  await page.evaluate(async info => {
    const { createSpineRenderer } = await import('/desktop-pet/spine.js')
    window.settings = { animated: true }; window.clock = performance.now(); window.make = () => createSpineRenderer(document.getElementById('stage'), settings, error => { window.renderError = error.message }, info)
    window.pet = await make(); window.step = frames => { for (let i = 0; i < frames; i++) { clock += 1000 / 60; pet.update(clock) } }
  }, info)
  const initial = await page.evaluate(() => { step(60); return pet.inspect() })
  assert.equal(initial.bones, 102); assert.equal(initial.physics, 87)
  assert.equal(await page.evaluate(() => typeof window.PIXI), 'undefined', 'Spine does not load either Pixi engine')
  if (!hasMouths) assert.equal(await page.evaluate(() => pet.speech.start({ duration: 1, cues: [] }, () => 0)), false, 'Export with missing mouth data cannot claim speech')
  else {
    await page.evaluate(() => { window.audioTime = 0; pet.speech.start({ duration: 2, cues: [{ time: 0, shape: 'a' }, { time: .5, shape: 'o' }, { time: 1, shape: 'i' }, { time: 1.5, shape: 'm' }] }, () => audioTime) })
    for (const [time, shape] of [[0, 'a'], [.5, 'o'], [1, 'i'], [1.5, 'm']]) {
      assert.equal(await page.evaluate(time => { audioTime = time; step(20); return pet.inspect().mouth }, time), shape)
      await page.screenshot({ path: join(output, `recovered-mouth-${shape}.png`) })
    }
    const paused = await page.evaluate(() => { const before = pet.inspect(); step(30); return { before, after: pet.inspect() } })
    assert.equal(paused.before.mouth, paused.after.mouth); assert.ok(paused.after.bodyTime > paused.before.bodyTime)
    assert.equal(await page.evaluate(() => { audioTime = 2; step(20); return pet.inspect().speaking }), false)
    assert.equal(await page.evaluate(() => pet.inspect().mouth), 'm')
  }
  await page.screenshot({ path: join(output, 'current-export-body-failure.png') })
  const regions = await page.evaluate(() => { const found = new Set(); for (let y = 0; y < 750; y += 10) for (let x = 0; x < 600; x += 10) { const region = pet.region(x, y); if (region) found.add(region) } return { found: [...found], empty: pet.hit(0, 0) } })
  assert.equal(regions.empty, false); assert.ok(regions.found.includes('head')); assert.ok(regions.found.includes('body'))
  for (const action of ['touch', 'click', 'drag', 'release']) assert.equal(await page.evaluate(action => { const played = pet.react(action); step(30); return played && pet.state === action }, action), true)
  await page.evaluate(() => { settings.animated = false; step(1) })
  const still = await page.locator('canvas').evaluate(c => c.toDataURL()); await page.evaluate(() => step(90))
  assert.equal(await page.locator('canvas').evaluate(c => c.toDataURL()), still)
  const lifetimes = []
  for (let i = 0; i < 5; i++) {
    lifetimes.push(await page.evaluate(async () => { pet.dispose(); const count = document.querySelectorAll('canvas').length; pet = await make(); step(1); return { count, ...pet.inspect() } }))
    assert.equal(lifetimes.at(-1).count, 0)
  }
  await page.evaluate(() => pet.dispose())
  await page.route('**/*.png', route => route.abort())
  assert.equal(await page.evaluate(async () => { try { await make(); return false } catch { return document.querySelectorAll('canvas').length === 0 } }), true)
  await page.unroute('**/*.png')
  await page.evaluate(async () => { pet = await make(); settings.animated = true; step(60) })
  await page.evaluate(() => document.querySelector('canvas').getContext('webgl').getExtension('WEBGL_lose_context').loseContext())
  await page.waitForFunction(() => window.renderError?.includes('上下文'))
  assert.equal(await page.locator('canvas').count(), 0)
  assert.deepEqual(errors, [])
  await writeFile(join(output, hasMouths ? 'recovered-adapter-result.json' : 'adapter-result.json'), JSON.stringify({ inspection, initial, regions, lifetimes, hasMouths, resourceFailureRecovered: true, contextLossReleased: true, visualAcceptance: false, reason: 'Source texture regions remain invalid' }, null, 2))
  console.log('Spine adapter lifecycle passed; source artwork acceptance remains FAILED.')
} finally { await browser.close(); cleanup(); server.closeAllConnections(); await new Promise(r => server.close(r)); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(temp, { recursive: true, force: true }) }
