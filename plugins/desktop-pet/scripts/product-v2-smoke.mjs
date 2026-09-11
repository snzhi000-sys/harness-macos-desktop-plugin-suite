/** Exercise the packaged Loader and real native Live2D windows using isolated data. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { chromium } from 'playwright'
import { wardrobeIdentity } from '../src/character-wardrobe.mjs'
const app = resolve(process.env.DSH_PET_TEST_APP ?? '../../desktop/dist/dev/mac-arm64/DeepSeek Harness Dev.app')
const productName = app.endsWith('/DeepSeek Harness Dev.app') ? 'DeepSeek Harness Dev' : app.endsWith('/DeepSeek Harness.app') ? 'DeepSeek Harness' : undefined
if (!productName) throw new Error('A Harness product App is required; tests always use temporary data')
const output = resolve('../../desktop/.artifacts/desktop-pet-picker')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const asar = createRequire(new URL('../../../desktop/package.json', import.meta.url))('@electron/asar')
for (const file of ['src/main.mjs', 'src/preload.cjs', 'src/pet-window.mjs', 'src/pet-preload.cjs']) assert.equal(hash(asar.extractFile(join(app, 'Contents/Resources/app.asar'), file)), hash(await readFile(resolve('../../desktop', file))), file)
const checked = []
const packed = await mkdtemp(join(tmpdir(), 'pet-packed-check-'))
try {
execFileSync('/usr/bin/tar', ['-xzf', join(app, 'Contents/Resources/profile-bootstrap/profile.tar.gz'), '-C', packed, './node_modules/dsh-desktop-pet'])
for (const dir of ['src', 'dist']) for (const entry of await readdir(dir, { withFileTypes: true })) {
  if (!entry.isFile()) continue
  const file = `${dir}/${entry.name}`
  const bytes = await readFile(join(packed, 'node_modules/dsh-desktop-pet', file))
  assert.equal(hash(bytes), hash(await readFile(file)), file); checked.push(file)
}
for (const file of ['assets/catalog.json', 'assets/cores/live2d.min.js', 'assets/cores/live2dcubismcore.min.js', 'assets/cores/dragonbones.js', 'assets/cores/pixi8.js', 'assets/models/mengmei/mengmei_ske.json', 'assets/models/mengmei/mengmei_tex.json', 'assets/models/mengmei/mengmei_tex.png']) {
  const bytes = await readFile(join(packed, 'node_modules/dsh-desktop-pet', file))
  assert.equal(hash(bytes), hash(await readFile(file)), file); checked.push(file)
}
} finally { await rm(packed, { recursive: true, force: true }) }
console.log(`Verified ${checked.length} packaged source, bundle and resource hashes`)
const temp = await mkdtemp(join(tmpdir(), 'pet-product-v2-'))
if (process.env.DSH_PET_UPGRADE_FROM) {
  const oldApp = resolve(process.env.DSH_PET_UPGRADE_FROM)
  const profile = join(temp, 'harness/profiles/web')
  await mkdir(profile, { recursive: true })
  execFileSync('/usr/bin/tar', ['-xzf', join(oldApp, 'Contents/Resources/profile-bootstrap/profile.tar.gz'), '-C', profile])
  const previous = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.ok(!previous.dsh.profile.bundles.includes('dsh-desktop-pet'), 'Upgrade fixture must predate Stable pets')
  await writeFile(join(temp, 'harness/profiles/.web-bundled-profile-id'), await readFile(join(oldApp, 'Contents/Resources/profile-bootstrap/profile-id')))
}
const settingsPath = join(temp, 'harness/state/dsh-desktop-pet/settings.json')
const models = JSON.parse(await readFile('assets/catalog.json', 'utf8')).models
const characterCount = new Set(models.map(m => wardrobeIdentity(m).characterId)).size
const addedModels = models.slice(3)
await mkdir(output, { recursive: true })
const child = spawn(join(app, 'Contents/MacOS', productName), [`--user-data-dir=${temp}`, '--remote-debugging-port=0'], { stdio: 'ignore' })
const exit = once(child, 'exit')
let browser, stopRecording
const delay = ms => new Promise(done => setTimeout(done, ms))
const errors = [], videos = []
let frameSample
let dragonbonesFrameSample
async function record(page, name) {
  const session = await page.context().newCDPSession(page)
  const frames = join(output, `product-${name}-frames`)
  await mkdir(frames, { recursive: true })
  let index = 0
  const pending = []
  session.on('Page.screencastFrame', event => {
    pending.push(writeFile(join(frames, `${String(index++).padStart(6, '0')}.jpg`), Buffer.from(event.data, 'base64')))
    void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
  })
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 748, maxHeight: 1040, everyNthFrame: 2 })
  return async () => {
    await session.send('Page.stopScreencast'); await Promise.all(pending); await session.detach()
    assert.ok(index > 20, 'Actual packaged window produced animation frames')
    const video = join(output, `product-${name}.mp4`)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', join(frames, '%06d.jpg'), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video])
    videos.push({ name, frames: index, video, timing: '30 fps presentation of CDP frames; not a performance measurement' })
    await rm(frames, { recursive: true })
  }
}
try {
  let port
  for (let n = 0; n < 300; n++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Dev exited before ready')
    try { port = (await readFile(join(temp, 'DevToolsActivePort'), 'utf8')).split('\n')[0] } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (port) break
    await delay(1000)
  }
  assert.ok(port)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const context = browser.contexts()[0]; context.setDefaultTimeout(30000)
  const main = context.pages()[0]
  await main.waitForURL(/http:\/\/127\.0\.0\.1:/, { timeout: 300000 })
  await main.waitForTimeout(5000)
  await main.evaluate(() => { document.title = '桌宠自动验证 · 临时数据' })
  for (const pattern of [/^(Continue|继续)$/, /^(稍后配置|Configure later)$/]) {
    const button = main.getByRole('button', { name: pattern })
    if (await button.isVisible()) { await button.click(); await main.waitForTimeout(500) }
  }
  await main.getByRole('button', { name: '🐾 桌宠', exact: true }).click({ timeout: 60000 })
  await main.locator('.character-row').nth(characterCount - 1).waitFor()
  assert.equal(await main.locator('.character-row').count(), characterCount)
  if (addedModels.length) {
    await main.locator('#model-search').fill(addedModels[0].name)
    assert.equal(await main.locator('.character-row').count(), 1)
    await main.locator('#model-search').fill('')
    assert.equal(await main.locator('.character-row img').count(), characterCount)
  }
  const nextPet = async action => {
    const promise = context.waitForEvent('page')
    await action(); const page = await promise
    page.on('pageerror', error => errors.push(error.message))
    await page.waitForURL(/\/desktop-pet\/view$/)
    await page.locator('canvas').waitFor(); await page.waitForTimeout(1600)
    assert.equal(await page.locator('#message').textContent(), '')
    return page
  }
  let pet = await nextPet(() => main.getByRole('button', { name: '显示', exact: true }).click())
  await main.screenshot({ path: join(output, 'product-library.png') })
  // The separate browser/native fixtures exercise physical input. Keep this temporary packaged run isolated from concurrent desktop clicks.
  await main.evaluate(() => {
    const cover = document.createElement('div'); cover.id = 'pet-test-cover'
    cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#ffffffcc;display:grid;place-items:center;font:20px system-ui;color:#334155'
    cover.textContent = '正在自动验收桌宠，完成后将打开萌妹体验窗口。'
    document.body.append(cover)
  })
  stopRecording = await record(pet, 'Katou')
  await pet.evaluate(() => {
    window.petFrameSample = new Promise(resolveSample => {
      const started = performance.now(); let count = 0, previous = started, maximumGap = 0
      const tick = now => { count++; maximumGap = Math.max(maximumGap, now - previous); previous = now
        if (now - started < 60000) requestAnimationFrame(tick)
        else resolveSample({ elapsedMs: now - started, frames: count, fps: count * 1000 / (now - started), maximumGapMs: maximumGap })
      }; requestAnimationFrame(tick)
    })
  })
  await pet.waitForTimeout(1800)
  await pet.screenshot({ path: join(output, 'product-Katou-idle.png'), omitBackground: true })
  // The same character regions are exercised in native pointer tests; menu actions make recorded expressions repeatable.
  for (const state of ['touch', 'click', 'annoyed']) {
    await pet.mouse.click(180, 250, { button: 'right' })
    await pet.locator(`#menu [data-action="${state}"]`).click()
    assert.equal(await pet.locator('#stage').getAttribute('data-action'), state)
    await pet.waitForTimeout(1200)
    await pet.screenshot({ path: join(output, `product-Katou-${state}.png`), omitBackground: true })
    await pet.waitForTimeout(1200)
  }
  await stopRecording(); stopRecording = null
  console.log('Packaged reactions recorded; sampling 60 seconds of idle and interaction frame timing')
  frameSample = await pet.evaluate(() => window.petFrameSample)
  await writeFile(join(output, 'product-frame-sample.json'), JSON.stringify(frameSample, null, 2))
  for (const name of [...[addedModels[0], addedModels.at(-1)].filter(Boolean).map(model => model.name), '萌妹', '蕾姆', 'Senko', '加藤惠']) {
    const card = main.locator('.character-row').filter({ has: main.getByText(name, { exact: true }) })
    pet = await nextPet(() => card.evaluate(element => element.click()))
    assert.equal(context.pages().filter(p => p.url().endsWith('/desktop-pet/view')).length, 1)
    await pet.screenshot({ path: join(output, `product-${name.replaceAll('/', '_')}.png`), omitBackground: true })
    if (name === '萌妹') {
      await pet.evaluate(() => {
        window.dragonbonesFrameSample = new Promise(done => {
          const start = performance.now(); let frames = 0, last = start, maxGap = 0
          const tick = now => { frames++; maxGap = Math.max(maxGap, now - last); last = now; if (now - start < 10000) requestAnimationFrame(tick); else done({ frames, elapsedMs: now - start, fps: frames * 1000 / (now - start), maxGapMs: maxGap }) }
          requestAnimationFrame(tick)
        })
      })
      stopRecording = await record(pet, 'mengmei')
      for (const state of ['touch', 'click', 'annoyed']) {
        await pet.mouse.click(180, 250, { button: 'right' })
        await pet.locator(`#menu [data-action="${state}"]`).click()
        assert.equal(await pet.locator('#stage').getAttribute('data-action'), state)
        await pet.waitForTimeout(2400)
      }
      await stopRecording(); stopRecording = null
      dragonbonesFrameSample = await pet.evaluate(() => window.dragonbonesFrameSample)
      assert.ok(dragonbonesFrameSample.fps > 24, 'DragonBones native animation remains interactive')
      await writeFile(join(output, 'dragonbones-frame-sample.json'), JSON.stringify(dragonbonesFrameSample, null, 2))
    }
    if (name === 'Senko') { stopRecording = await record(pet, 'Senko'); await pet.waitForTimeout(6000); await stopRecording(); stopRecording = null }
  }
  await main.getByRole('button', { name: '关闭', exact: true }).evaluate(element => element.click())
  await main.waitForFunction(() => document.querySelector('[data-plugin="desktop-pet"]').shadowRoot.querySelector('#model-preview').getAttribute('src') === 'about:blank')
  const preview = main.locator('iframe#model-preview')
  assert.equal(await preview.getAttribute('src'), 'about:blank')
  await main.getByRole('button', { name: '🐾 桌宠', exact: true }).evaluate(element => element.click())
  await main.getByRole('button', { name: '隐藏', exact: true }).evaluate(element => element.click())
  if (!pet.isClosed()) await pet.waitForEvent('close')
  assert.equal(context.pages().filter(p => p.url().endsWith('/desktop-pet/view')).length, 0)
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).modelId, models.find(model => model.name === '加藤惠').id)
  assert.equal(JSON.parse(await readFile(join(temp, 'desktop-pet-window.json'), 'utf8')).visible, false)
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'product-result.json'), JSON.stringify({ app, verifiedAt: new Date().toISOString(), checked, realLoader: true, builtinModels: models.length, cleanData: true, authoredReactions: ['touch', 'click', 'annoyed'], switches: addedModels.length ? 5 : 3, previewReleased: true, hiddenDestroyed: true, modelPersisted: true, frameSample, videos, errors }, null, 2))
  console.log('Packaged product passed: exact source/bundles, real Loader, 23 built-in models, Live2D and DragonBones reactions, preview and window cleanup')
} catch (error) {
  if (browser) for (const [index, page] of browser.contexts()[0].pages().entries()) await page.screenshot({ path: join(output, `product-failure-${index}.png`) }).catch(() => {})
  throw error
} finally {
  if (stopRecording) await stopRecording().catch(() => {})
  await browser?.close()
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
    await exit; clearTimeout(timer)
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
