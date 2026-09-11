/** Clean-data built-in library smoke through real Host and compiled Client, without remote assets. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { chromium } from 'playwright'
import { apply } from '../src/host.mjs'
const root = await mkdtemp(join(tmpdir(), 'pet-picker-')), output = resolve('../../desktop/.artifacts/desktop-pet-picker')
await mkdir(output, { recursive: true })
const previous = process.env.DSH_HOME; process.env.DSH_HOME = root
let route, dispose, browser
apply({ webServer: { register(value) { route = value; return () => {} } }, effect(fn) { dispose = fn() } })
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<title>Companion picker</title><body style="background:#e9edf3"><script>window.__ModuleLoader__={load({factory}){factory(()=>{}).apply({effect(fn){window.disposePlugin=fn()}})}};</script><script src="/client.js"></script>') }
  else if (req.url === '/client.js') { res.setHeader('content-type', 'text/javascript'); res.end(await readFile('dist/client.js')) }
  else await route.handler(req, res)
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`
try {
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  await context.addInitScript(() => { window.petCommands = []; window.harnessDesktop = { petCommand: async value => { window.petCommands.push(value) } } })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base); await page.getByRole('button', { name: '🐾 桌宠', exact: true }).click()
  await page.locator('.character-row').nth(10).waitFor()
  assert.equal(await page.locator('.character-row').count(), 19)
  assert.equal(await page.locator('.character-row').first().getAttribute('data-model-id'), 'mengmei')
  assert.equal(await page.locator('.character-row').filter({hasText:'天命之子'}).count(), 0)
  const preview = page.frameLocator('#model-preview')
  await preview.locator('canvas').waitFor()
  await page.waitForTimeout(1800)
  assert.equal(await preview.locator('#message').textContent(), '')
  const transcript = await page.getByRole('dialog').innerText()
  const snapshot = 'tests/snapshots/settings.expected.txt'
  if (process.env.UPDATE_SNAPSHOT === '1') await writeFile(snapshot, transcript.trim() + '\n')
  else assert.equal(transcript.trim(), (await readFile(snapshot, 'utf8')).trim())
  await page.screenshot({ path: join(output, 'picker-desktop.png') })
  const desktopPet = await context.newPage(); await desktopPet.goto(base + '/desktop-pet/view?model=mengmei'); await desktopPet.locator('canvas').waitFor(); await page.bringToFront()
  await page.getByText('动作调试 · 按住预览，松开恢复', {exact:true}).click()
  const modulesSnapshot='tests/snapshots/action-modules.expected.txt',modulesText=(await page.locator('details').innerText()).trim()+'\n'
  if(process.env.UPDATE_SNAPSHOT==='1')await writeFile(modulesSnapshot,modulesText)
  else assert.equal(modulesText,await readFile(modulesSnapshot,'utf8'))
  const debug = page.getByRole('button', {name:'biyan', exact:true})
  const debugBox = await debug.boundingBox(); await page.mouse.move(debugBox.x+debugBox.width/2,debugBox.y+debugBox.height/2); await page.mouse.down()
  await preview.locator('#stage[data-state="debug"]').waitFor(); await desktopPet.locator('#stage[data-state="debug"]').waitFor()
  await page.screenshot({path:join(output,'debug-held.png')})
  await page.mouse.move(10,10); await page.mouse.up()
  await preview.locator('#stage[data-state="idle"]').waitFor(); await desktopPet.locator('#stage[data-state="idle"]').waitFor()
  await debug.focus(); await page.keyboard.down('Space'); await desktopPet.locator('#stage[data-state="debug"]').waitFor(); await page.keyboard.up('Space'); await desktopPet.locator('#stage[data-state="idle"]').waitFor()
  await page.evaluate(()=>{const c=new BroadcastChannel('dsh-pet-action-debug');c.postMessage({kind:'hold',modelId:'mengmei',token:'expiry-test',selection:{animation:'biyan'}});c.close()})
  await desktopPet.locator('#stage[data-state="debug"]').waitFor(); await desktopPet.locator('#stage[data-state="idle"]').waitFor()
  await desktopPet.close(); await page.getByText('动作调试 · 按住预览，松开恢复', {exact:true}).click()
  const listBox = await page.locator('#models').boundingBox(), footerBox = await page.locator('footer').boundingBox()
  assert.ok(listBox.y + listBox.height <= footerBox.y + 1, 'Character list has independent scroll space')
  await page.locator('.character-row').last().click()
  await page.locator('#character-name').filter({ hasText: '天狼星' }).waitFor()
  await preview.locator('canvas').waitFor()
  assert.equal(await preview.locator('#message').textContent(), '')
  await page.locator('.character-row[data-model-id="companion-24"]').click()
  await page.locator('#character-name').filter({ hasText: 'Ruri' }).waitFor()
  await preview.locator('canvas').waitFor(); await page.waitForTimeout(1400)
  assert.equal(await preview.locator('#message').textContent(), '')
  await page.screenshot({ path: join(output, 'picker-last-character.png') })
  await page.getByText('动作调试 · 按住预览，松开恢复', {exact:true}).click()
  const live2dAction=page.locator('details button').first(); await live2dAction.focus(); await page.keyboard.down('Space')
  await preview.locator('#stage[data-state="debug"]').waitFor(); await page.keyboard.up('Space'); await preview.locator('#stage[data-state="idle"]').waitFor()
  await page.locator('.character-row[data-model-id="mengmei"]').click()
  await page.locator('#character-name').filter({ hasText: '萌妹' }).waitFor()
  await preview.locator('canvas').waitFor(); await page.waitForTimeout(800)
  assert.equal(await preview.locator('#message').textContent(), '')
  await page.screenshot({ path: join(output, 'picker-mengmei.png') })
  await page.locator('.character-row').filter({ hasText: 'Ruri' }).click()
  await page.locator('#character-name').filter({ hasText: 'Ruri' }).waitFor()
  await page.locator('#model-search').fill('Mori')
  assert.equal(await page.locator('.character-row').count(), 1)
  await page.locator('.character-row').click()
  await page.locator('#pet-outfit').waitFor()
  assert.equal(await page.locator('#pet-outfit option').count(), 4)
  await page.locator('#pet-outfit').selectOption('companion-23')
  await page.locator('#character-name').filter({hasText:'Mori · 制服'}).waitFor()
  await preview.locator('canvas').waitFor()
  assert.equal(await preview.locator('#message').textContent(), '')
  assert.equal((await (await fetch(`${base}/desktop-pet/api/settings`)).json()).modelId, 'companion-23')
  await page.screenshot({path:join(output,'wardrobe.png')})
  await page.getByRole('button', {name:'关闭',exact:true}).click()
  await page.getByRole('button', {name:'🐾 桌宠',exact:true}).click()
  await page.locator('#character-name').filter({hasText:'Mori · 制服'}).waitFor()
  assert.equal(await page.locator('#pet-outfit').inputValue(), 'companion-23')
  await page.locator('.character-row').filter({hasText:'Ruri'}).click()
  await page.locator('#model-search').fill('没有这个角色')
  assert.equal(await page.locator('.character-row').count(), 0)
  await page.getByText('没有找到这个角色，试试其他名字。', { exact: true }).waitFor()
  await page.locator('#model-search').fill('')
  await page.locator('#height').fill('550'); await page.locator('#animated').uncheck(); await page.locator('#alwaysOnTop').uncheck()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('设置已保存。', { exact: true }).waitFor()
  const settings = await (await fetch(`${base}/desktop-pet/api/settings`)).json()
  assert.deepEqual(settings, { version: 2, modelId: 'companion-24', height: 550, animated: false, alwaysOnTop: false })
  await page.getByRole('button', { name: '隐藏', exact: true }).click()
  await page.getByRole('button', { name: '显示', exact: true }).click()
  await page.locator('#model-search').fill('Mori')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  assert.equal(await page.locator('#model-preview').getAttribute('src'), 'about:blank')
  await page.getByRole('button', { name: '🐾 桌宠', exact: true }).click()
  await page.locator('#character-name').filter({ hasText: 'Ruri' }).waitFor()
  await page.locator('.character-row').nth(10).waitFor()
  assert.equal(await page.locator('.character-row').count(), 19, 'Reopening resets the previous search')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('#model-preview').getAttribute('src'), 'about:blank')
  await page.setViewportSize({ width: 580, height: 700 })
  await page.getByRole('button', { name: '🐾 桌宠', exact: true }).click()
  await page.locator('#character-name').filter({ hasText: 'Ruri' }).waitFor()
  await preview.locator('canvas').waitFor(); await page.waitForTimeout(1000)
  await page.screenshot({ path: join(output, 'picker-compact.png') })
  assert.ok((await page.getByRole('button', { name: '保存', exact: true }).boundingBox()).y < 700)
  // Close during a switch: the completed save must not restart the iframe.
  await page.route('**/desktop-pet/api/settings', async route => { if (route.request().method() === 'POST') await new Promise(done => setTimeout(done, 400)); await route.continue() })
  await page.locator('.character-row').first().click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.waitForTimeout(800)
  assert.equal(await page.locator('#model-preview').getAttribute('src'), 'about:blank')
  assert.deepEqual(errors, [])
  const mixed = await context.newPage()
  for (const id of ['mengmei', 'companion-01', 'companion-02', 'mengmei', 'companion-03', 'mengmei']) {
    await mixed.goto(`${base}/desktop-pet/view?preview=1&model=${id}`)
    await mixed.locator('canvas').waitFor(); await mixed.waitForTimeout(450)
    assert.equal(await mixed.locator('#message').textContent(), '')
    if (id === 'mengmei') assert.equal(await mixed.evaluate(() => Boolean(window.Live2D || window.Live2DCubismCore)), false)
    else assert.equal(await mixed.evaluate(() => Boolean(window.dragonBones)), false)
  }
  await mixed.close()
  if (process.env.UPDATE_THUMBNAILS === '1') {
    const pet = await context.newPage(); await pet.setViewportSize({ width: 240, height: 320 })
    for (const model of await (await fetch(`${base}/desktop-pet/api/models`)).json()) {
      await pet.goto(`${base}/desktop-pet/view?preview=1&model=${model.id}`)
      await pet.locator('canvas').waitFor(); await pet.waitForTimeout(1100)
      assert.equal(await pet.locator('#message').textContent(), '')
      const opaque = await pet.locator('canvas').evaluate(canvas => {
        const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')), pixels = new Uint8Array(canvas.width * canvas.height * 4)
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        let visible = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 24) visible++
        return visible
      })
      assert.ok(opaque > 500, model.id + ' renders visible artwork with animation disabled')
      await pet.locator('canvas').screenshot({ path: resolve('assets/models', model.id, 'preview.png'), omitBackground: true })
    }
    await pet.close()
  }
  await page.evaluate(() => window.disposePlugin())
  assert.equal(await page.locator('[data-plugin="desktop-pet"]').count(), 0)
  await writeFile(join(output, 'browser-result.json'), JSON.stringify({ models: 23, characters: 19, wardrobe: true, cleanData: true, lastCharacterSelectable: true, search: true, save: true, closeAndEscapeReleasePreview: true, lateSwitchClosed: true, errors }, null, 2))
  console.log('Built-in picker passed: clean 23 models, real preview, last-row switching, search, save, close, compact layout, teardown.')
} finally {
  await browser?.close(); dispose(); server.closeAllConnections(); await new Promise(done => server.close(done))
  if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
  await rm(root, { recursive: true, force: true })
}
