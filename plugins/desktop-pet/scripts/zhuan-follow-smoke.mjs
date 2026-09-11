/** Real Host and built renderer playback, authored layers, audio-clock cues and repeated teardown. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { speechCues } from '../src/speech-cues.mjs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { chromium } from 'playwright'
import { apply } from '../src/host.mjs'
const output=resolve(process.env.PET_GAZE_OUTPUT ?? '../../desktop/.artifacts/pet-zhuan-follow'), temp=await mkdtemp(join(tmpdir(),'pet-dragonbones-'))
await mkdir(output,{recursive:true});const previous=process.env.DSH_HOME;process.env.DSH_HOME=temp
// A local calibration tone tests audio transport timing; it is not phoneme recognition or generated speech.
const wav=Buffer.alloc(44+16000*2*2)
wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40)
for(let i=0;i<32000;i++)wav.writeInt16LE(Math.round(Math.sin(i/16000*2*Math.PI*220)*3000),44+i*2)
await writeFile(join(output,'timing-tone.wav'),wav)
let route,dispose;apply({webServer:{register(r){route=r;return()=>{}}},effect(fn){dispose=fn()}})
const server=createServer(async(req,res)=>{
 if(req.url==='/timing.wav'){res.setHeader('content-type','audio/wav');res.end(wav);return}
 if(req.url==='/fixture') {res.setHeader('content-type','text/html');res.end('<body style="margin:0;background:#e7edf3"><div id="stage" style="width:600px;height:700px"></div><script src="/desktop-pet/pixi8.js"></script><script src="/desktop-pet/dragonbones-core.js"></script></body>')}
 else await route.handler(req,res)
});server.listen(0,'127.0.0.1');await once(server,'listening')
const base=`http://127.0.0.1:${server.address().port}`, browser=await chromium.launch({headless:true})
try {
 const context=await browser.newContext({viewport:{width:600,height:700},recordVideo:{dir:join(output,'video'),size:{width:600,height:700}}})
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(base+'/fixture')
 await page.evaluate(async()=>{
  const module=await import('/desktop-pet/dragonbones.js'),info=await(await fetch('/desktop-pet/api/model?id=mengmei')).json()
  window.settings={animated:true};window.clock=performance.now();window.make=async()=>module.createDragonBonesRenderer(document.getElementById('stage'),settings,e=>{throw e},info)
  window.pet=await make();window.step=n=>{for(let i=0;i<n;i++){clock+=1000/60;pet.update(clock)}}
 })
 const samples={}
 for(const [name,point] of Object.entries({center:null,left:{x:-1500,y:200},right:{x:2000,y:200},up:{x:300,y:-2000},down:{x:300,y:2500},nearRight:{x:450,y:220}})) {
  samples[name]=await page.evaluate(async point=>{pet.dispose();pet=await make();for(let i=0;i<180;i++){clock+=1000/60;pet.update(clock,point)}return pet.inspect().gaze},point)
  await page.screenshot({path:join(output,`${process.env.PET_GAZE_LABEL??'current'}-${name}.png`)})
 }
 await writeFile(join(output,`${process.env.PET_GAZE_LABEL??'current'}-result.json`),JSON.stringify(samples,null,2))
 for (const sample of Object.values(samples)) {
  assert.ok(Math.hypot(sample.x / 300,sample.y / 350) <= 1.0001, 'Local X is vertical, local Y is horizontal; diagonals stay inside the ellipse')
  for (const bone of ['control','body','chest','face','eye']) assert.ok(Object.values(sample[bone]).every(Number.isFinite))
 }
 assert.ok(samples.left.y < -349 && samples.right.y > 349, 'Screen horizontal range reaches 350 in each direction')
 assert.ok(samples.up.x > 299 && samples.down.x < -299, 'Screen vertical range reaches 300 in each direction')
 await context.route('**/desktop-pet/dragonbones.js', async route => {
  const response=await route.fetch(), body=(await response.text()).replace('export {\n  createDragonBonesRenderer\n}', 'async function observedRenderer(...args) { const renderer=await createDragonBonesRenderer(...args); window.observedPet=renderer; return renderer }\nexport {\n  observedRenderer as createDragonBonesRenderer\n}')
  await route.fulfill({response,body})
 })
 const mousePage=await context.newPage();mousePage.on('pageerror',e=>errors.push(e.message))
 const mouseSamples={}
 for (const mode of ['baseline','enhanced']) {
  await mousePage.route('**/desktop-pet/api/model?*',async route=>{
   const response=await route.fetch(), data=await response.json()
   if(mode==='baseline'){data.profile.gaze.horizontalRange=250;data.profile.gaze.verticalRange=250;data.profile.gaze.sensitivity=1}
   await route.fulfill({response,json:data})
  })
  await mousePage.goto(base+'/desktop-pet/view?model=mengmei');await mousePage.waitForFunction(()=>Boolean(window.observedPet))
  mouseSamples[mode]={}
  for(const [name,point] of Object.entries({left:[40,220],right:[560,220],up:[300,90],down:[300,590],upperRight:[580,80],lowerLeft:[30,560]})) {
   await mousePage.mouse.move(...point,{steps:45});await mousePage.waitForTimeout(1600)
   mouseSamples[mode][name]=await mousePage.evaluate(()=>observedPet.inspect().gaze)
   await mousePage.screenshot({path:join(output,`mouse-${mode}-${name}.png`)})
  }
  await mousePage.unroute('**/desktop-pet/api/model?*')
 }
 assert.ok(Math.abs(mouseSamples.enhanced.right.control.x-mouseSamples.enhanced.left.control.x)>Math.abs(mouseSamples.baseline.right.control.x-mouseSamples.baseline.left.control.x)*2,'Real mouse travel produces a larger authored body turn')
 assert.ok(Math.abs(mouseSamples.enhanced.down.body.y-mouseSamples.enhanced.up.body.y)>Math.abs(mouseSamples.baseline.down.body.y-mouseSamples.baseline.up.body.y)*1.5,'Real mouse vertical travel increases authored torso inclination')
 await writeFile(join(output,'mouse-result.json'),JSON.stringify(mouseSamples,null,2))
 console.log('Real pointer travel: left/right, up/down and diagonals passed; screenshots and video saved.')
 assert.deepEqual(errors,[])
 await context.close()
} finally {await browser.close();dispose();server.closeAllConnections();await new Promise(r=>server.close(r));if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;await rm(temp,{recursive:true,force:true})}
