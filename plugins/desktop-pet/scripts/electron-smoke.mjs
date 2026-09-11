/** Verify native windows and persistence without reading any daily Harness profile. */
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { writeSettings } from '../src/settings.mjs'
const temp = await mkdtemp(join(tmpdir(), 'pet-electron-'))
const artifacts = resolve('../../desktop/.artifacts/desktop-pet-verification')
await mkdir(artifacts, { recursive: true })
if (process.env.DSH_PET_TEST_MODEL) writeSettings(join(temp, 'harness/state/dsh-desktop-pet/settings.json'), { modelId: process.env.DSH_PET_TEST_MODEL })
const launch = () => electron.launch({ executablePath: process.env.DSH_PET_TEST_ELECTRON ?? resolve('../../desktop/.artifacts/electron-pet-smoke/Electron.app/Contents/MacOS/Electron'), args: [resolve('tests/electron-fixture.mjs'), `--user-data-dir=${temp}`], env: { ...process.env, DSH_HOME: join(temp, 'harness') } })
let app
try {
  app = await launch()
  app.context().setDefaultTimeout(15000)
  console.log('Electron fixture launched')
  const main = await app.firstWindow()
  await main.getByRole('button', { name: '🐾 桌宠', exact: true }).click()
  const petPromise = app.waitForEvent('window')
  await main.getByRole('button', { name: '显示', exact: true }).click()
  const pet = await petPromise
  console.log('Pet window created')
  await pet.waitForFunction(() => document.querySelector('canvas')?.width > 0)
  assert.equal(await pet.locator('#message').textContent(), '')
  let native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ id: w.id, title: w.getTitle(), bounds: w.getBounds(), visible: w.isVisible(), top: w.isAlwaysOnTop() })))
  const initial = native.find(w => w.title === 'Harness 桌宠')
  assert.ok(initial.visible)
  assert.ok(initial.top)
  if (process.env.DSH_PET_TEST_MODEL === 'mengmei') {
    await main.bringToFront()
    await main.getByText('动作调试 · 按住预览，松开恢复',{exact:true}).click()
    const motion = main.getByRole('button',{name:'wuxiong',exact:true})
    await motion.scrollIntoViewIfNeeded()
    const box = await motion.boundingBox(); await main.mouse.move(box.x+box.width/2,box.y+box.height/2); await main.mouse.down()
    assert.equal(await motion.getAttribute('aria-pressed'),'true','Native settings receives the held action')
    await pet.locator('#stage[data-state="debug"]').waitFor(); await pet.waitForTimeout(600)
    await pet.screenshot({path:join(artifacts,'electron-debug-held.png'),omitBackground:true})
    await main.mouse.up(); await pet.locator('#stage[data-state="idle"]').waitFor()
    await motion.focus(); await main.keyboard.down('Space'); await pet.locator('#stage[data-state="debug"]').waitFor()
    await main.getByRole('button',{name:'关闭',exact:true}).evaluate(button=>button.click())
    await pet.locator('#stage[data-state="idle"]').waitFor(); await main.keyboard.up('Space')
    await main.getByRole('button',{name:'🐾 桌宠',exact:true}).click()
    await pet.evaluate(()=>window.harnessPet.onPointer(point=>window.lastPetPointer=point))
    for(const [name,x] of [['left',-1200],['right',1600]]) {
      await app.evaluate((_electron,point)=>{globalThis.petFixturePointer=point},{x:initial.bounds.x+x,y:initial.bounds.y+120})
      await pet.waitForFunction(x=>window.lastPetPointer?.x===x,x)
      await pet.waitForTimeout(1000)
      await pet.screenshot({path:join(artifacts,`electron-gaze-${name}.png`),omitBackground:true})
    }
  }
  await pet.evaluate(() => { window.testReactions = []; window.harnessPet.onReaction(value => window.testReactions.push(value)) })
  await main.evaluate(() => window.dispatchEvent(new CustomEvent('dsh-desktop-pet:react', { detail: { action: 'click' } })))
  await pet.waitForFunction(() => window.testReactions.includes('click'))
  await pet.waitForTimeout(1200)
  await pet.waitForTimeout(100)
  assert.equal(await app.evaluate((_electron, id) => globalThis.petFixtureMouseIgnore[id], initial.id), true, 'Transparent/outside pointer activates native click-through')
  const canvasPoint = await pet.locator('canvas').evaluate(canvas => {
    const context = (canvas.getContext('webgl2') || canvas.getContext('webgl')); const pixels = new Uint8Array(canvas.width * canvas.height * 4); context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels)
    let best=null, distance=Infinity
    for (let y = 20; y < canvas.height - 20; y++) for (let x = 20; x < canvas.width - 20; x++) {
      const d=(x-canvas.width*.55)**2+(y-canvas.height*.45)**2
      if(d<distance && [-18,0,18].every(dy=>[-18,0,18].every(dx=>pixels[((y+dy)*canvas.width+x+dx)*4+3]>240))) {
        best={x:x/devicePixelRatio,y:(canvas.height-1-y)/devicePixelRatio};distance=d
      }
    }
    if(best)return best
    throw new Error('No opaque character pixels')
  })
  await app.evaluate((_electron, point) => { globalThis.petFixturePointer = point }, { x: initial.bounds.x + canvasPoint.x, y: initial.bounds.y + canvasPoint.y })
  await pet.waitForTimeout(100)
  assert.equal(await app.evaluate((_electron, id) => globalThis.petFixtureMouseIgnore[id], initial.id), false, 'Opaque character pixel restores native interaction')
  await pet.mouse.move(canvasPoint.x, canvasPoint.y)
  await pet.mouse.down()
  await app.evaluate((_electron, point) => { globalThis.petFixturePointer = point }, { x: initial.bounds.x + canvasPoint.x - 20, y: initial.bounds.y + canvasPoint.y - 20 })
  await pet.waitForFunction(()=>document.getElementById('stage').dataset.action==='drag')
  await pet.waitForTimeout(100)
  await app.evaluate((_electron, point) => { globalThis.petFixturePointer = point }, { x: initial.bounds.x + canvasPoint.x - 100, y: initial.bounds.y + canvasPoint.y - 100 })
  await pet.waitForTimeout(200)
  await pet.mouse.up()
  const moved = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).getBounds(), initial.id)
  console.log('Drag evidence',JSON.stringify({initial:initial.bounds,moved,point:canvasPoint,action:await pet.locator('#stage').getAttribute('data-action')}))
  assert.ok(moved.x < initial.bounds.x - 30, 'Native window moves during drag')
  console.log('Native drag verified')
  await pet.screenshot({ path: join(artifacts, `electron-${process.env.DSH_PET_TEST_MODEL ?? 'live2d'}.png`), omitBackground: true })
  await app.close(); app = undefined
  const stored = JSON.parse(await readFile(join(temp, 'desktop-pet-window.json'), 'utf8'))
  assert.equal(stored.visible, true)
  assert.equal(stored.x, moved.x)
  app = await launch()
  app.context().setDefaultTimeout(15000)
  const restoredMain = await app.firstWindow()
  await restoredMain.getByRole('button', { name: '🐾 桌宠', exact: true }).waitFor()
  await restoredMain.waitForTimeout(1000)
  native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ id: w.id, title: w.getTitle(), bounds: w.getBounds() })))
  assert.equal(native.filter(w => w.title === 'Harness 桌宠').length, 1)
  assert.equal(native.find(w => w.title === 'Harness 桌宠').bounds.x, moved.x)
  await restoredMain.getByRole('button', { name: '🐾 桌宠', exact: true }).click()
  await restoredMain.locator('#character-name').filter({ hasText: process.env.DSH_PET_TEST_MODEL === 'mengmei' ? '萌妹' : '加藤惠' }).waitFor()
  await restoredMain.frameLocator('#model-preview').locator('canvas').waitFor()
  await restoredMain.locator('#height').fill('520')
  await restoredMain.locator('#animated').uncheck()
  await restoredMain.locator('#alwaysOnTop').uncheck()
  const resizedPromise = app.waitForEvent('window')
  await restoredMain.getByRole('button', { name: '保存', exact: true }).click()
  const resized = await resizedPromise
  await resized.waitForFunction(() => document.querySelector('canvas')?.width > 0)
  const resizedNative = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Harness 桌宠')
    return { bounds: window.getBounds(), top: window.isAlwaysOnTop() }
  })
  assert.equal(resizedNative.bounds.height, 520)
  assert.equal(resizedNative.top, false)
  await resized.waitForTimeout(1200)
  assert.ok(await resized.locator('canvas').evaluate(canvas => {
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')), pixels = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    return pixels.some((value, index) => index % 4 === 3 && value > 24)
  }), 'A paused character must remain visible')
  const stillFrame = await resized.locator('canvas').evaluate(canvas => canvas.toDataURL())
  await resized.waitForTimeout(350)
  assert.equal(await resized.locator('canvas').evaluate(canvas => canvas.toDataURL()), stillFrame, 'Disabling animation produces a stable frame')
  await restoredMain.getByRole('button', { name: '隐藏', exact: true }).click()
  await restoredMain.waitForTimeout(150)
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  await restoredMain.getByRole('button', { name: '显示', exact: true }).click()
  await restoredMain.waitForTimeout(300)
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2)
  await restoredMain.evaluate(() => window.disposePlugin())
  await restoredMain.waitForTimeout(150)
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  console.log('Electron smoke passed: native transparent window, drag, restart restoration, hide/show, and plugin disposal')
} finally { await app?.close(); await rm(temp, { recursive: true, force: true }) }
