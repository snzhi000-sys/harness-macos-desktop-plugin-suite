/** Real Cubism interruption, neutral parameter restoration, and automatic-action playback. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {chromium} from 'playwright'
import {apply} from '../src/host.mjs'
const output=resolve('../../desktop/.artifacts/pet-action-recovery'),temp=await mkdtemp(join(tmpdir(),'pet-actions-'))
await mkdir(output,{recursive:true});const previous=process.env.DSH_HOME;process.env.DSH_HOME=temp
let route,dispose;apply({webServer:{register(r){route=r;return()=>{}}},effect(fn){dispose=fn()}})
const server=createServer(async(req,res)=>{
 if(req.url==='/fixture'){res.setHeader('content-type','text/html');res.end('<body style="margin:0;background:#eee"><div id="stage" style="width:420px;height:600px"></div></body>');return}
 if(req.url==='/old.js'){res.setHeader('content-type','text/javascript');res.end(await readFile(join(output,'old-live2d.js')));return}
 await route.handler(req,res)
});server.listen(0,'127.0.0.1');await once(server,'listening')
const browser=await chromium.launch({headless:true}),results=[]
try {
 for(const id of process.env.PET_PLAYBACK_ONLY ? ['azur-atago'] : ['azur-atago','azur-belfast','gfl-kalina','companion-01']) {
  const page=await browser.newPage({viewport:{width:420,height:600}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`)
  await page.evaluate(async({id,old})=>{
   const info=await(await fetch('/desktop-pet/api/model?id='+id)).json();window.info=info
   await new Promise((yes,no)=>{const s=document.createElement('script');s.src=info.kind==='cubism2'?'/desktop-pet/core2.js':'/desktop-pet/core.js';s.onload=yes;s.onerror=no;document.head.append(s)})
   const module=await import(old&&info.kind!=='cubism2'?'/old.js':info.kind==='cubism2'?'/desktop-pet/live2d2.js':'/desktop-pet/live2d.js')
   window.clock=performance.now();performance.now=()=>clock
   window.pet=await module.createLive2DRenderer(document.querySelector('#stage'),{animated:true},e=>{throw e},info)
   window.step=n=>{for(let i=0;i<n;i++){clock+=1000/60;pet.update(clock,{x:-1,y:-1})}}
   await new Promise(r=>setTimeout(r,100));step(30)
  },{id,old:process.env.PET_OLD_RENDERER==='1'})
  const initial=await page.evaluate(()=>pet.inspect())
  if (process.env.PET_PLAYBACK_ONLY) {
   const evidence=[]
   for (const [name,pairs] of [['main_2',[['Part28','Part27'],['Part24','Part20']]],['touch_body',[['Part32','Part31'],['Part38','Part17']]]]) {
    for (const mode of ['debug','automatic','preview']) {
     const samples=await page.evaluate(async({name,mode})=>{
      pet.stopDebug();pet.cancelAutomatic()
      const action=info.actionModules.find(a=>a.motion&&info.motions.find(m=>m.group===a.motion.group&&m.index===a.motion.index)?.file.endsWith('/'+name+'.motion3.json'))
      if(mode==='debug')await pet.startDebug(action)
      else if(mode==='automatic')await pet.playAutomatic(action)
      else await pet.preview(action.motion)
      const samples=[];for(let i=0;i<240;i++){step(1);samples.push(pet.inspectParts())}return samples
     },{name,mode})
     for(const [alternate,normal]of pairs) {
      assert.ok(samples.some(s=>s[alternate]>.99&&s[normal]<.01),`${name}/${mode} actually hides default ${normal}`)
      assert.ok(samples.every(s=>s[alternate]+s[normal]<=1.001),`${name}/${mode} mutually exclusive arm opacity`)
     }
     await page.screenshot({path:join(output,`playing-${name}-${mode}.png`)})
     evidence.push({name,mode,samples})
    }
   }
   await writeFile(join(output,'playing-opacity-result.json'),JSON.stringify(evidence,null,2))
   await page.evaluate(()=>pet.dispose());await page.close();continue
  }
  await page.screenshot({path:join(output,`${process.env.PET_OLD_RENDERER?'old':'fixed'}-${id}-initial.png`)})
  const motions=await page.evaluate(()=>info.motions)
  for(const motion of motions) {
   await page.evaluate(async m=>{await pet.startDebug({motion:{group:m.group,index:m.index}});step(info.id==='azur-atago'?Math.max(20,Math.ceil((m.durationMs??1800)*.6/1000*60)):20);pet.stopDebug();await new Promise(r=>setTimeout(r,0));step(1)},motion)
   if(id==='azur-atago') await page.screenshot({path:join(output,`${process.env.PET_OLD_RENDERER?'old':'fixed'}-release-${motion.index}.png`)})
   if(id==='azur-atago'&&!process.env.PET_OLD_RENDERER) {
    const reset=await page.evaluate(()=>pet.inspect().poseParameters)
    assert.deepEqual(reset,initial.poseParameters,`Interrupted ${motion.file} restores every persisted motion parameter`)
    assert.deepEqual(await page.evaluate(()=>pet.inspect().partOpacities),initial.partOpacities,`Interrupted ${motion.file} restores every part visibility`)
   }
  }
  await page.screenshot({path:join(output,`${process.env.PET_OLD_RENDERER?'old':'fixed'}-${id}-released.png`)})
  if(!process.env.PET_OLD_RENDERER) {
   const action=await page.evaluate(()=>info.actionModules.find(a=>a.automaticEligible))
   if(action) {
    await page.evaluate(async a=>{await pet.playAutomatic(a);step(20)},action)
    assert.equal(await page.evaluate(()=>pet.state),'automatic')
    await page.evaluate(()=>pet.cancelAutomatic());await page.waitForTimeout(20)
    assert.equal(await page.evaluate(()=>pet.state),'idle')
    await page.evaluate(async a=>{await pet.playAutomatic(a);step(20);await pet.react('click');step(1)},action)
    assert.equal(await page.evaluate(()=>pet.state),'click')
    await page.evaluate(async a=>{await pet.playAutomatic(a);step(Math.ceil(((a.durationMs??1800)+200)/1000*60));await new Promise(r=>setTimeout(r,0));step(1)},action)
    assert.equal(await page.evaluate(()=>pet.state),'idle')
   }
  }
  assert.deepEqual(errors,[]);await page.evaluate(()=>pet.dispose());await page.close();results.push({id,motions:motions.length,interrupted:true})
 }
 if (!process.env.PET_OLD_RENDERER && !process.env.PET_PLAYBACK_ONLY) {
  const page=await browser.newPage();await page.clock.install()
  await page.goto(`http://127.0.0.1:${server.address().port}/desktop-pet/view?model=mengmei`);await page.locator('canvas').waitFor()
  await page.clock.fastForward(59000);assert.equal(await page.locator('#stage').getAttribute('data-state'),'idle')
  await page.clock.fastForward(1100);await page.locator('#stage[data-state="automatic"]').waitFor()
  await page.locator('#stage').dispatchEvent('contextmenu',{clientX:100,clientY:100});await page.clock.fastForward(32)
  assert.equal(await page.locator('#stage').getAttribute('data-state'),'idle')
  await page.clock.fastForward(120000);assert.equal(await page.locator('#stage').getAttribute('data-state'),'idle')
  await page.screenshot({path:join(output,'automatic-interrupted.png')});await page.close()
 }
 await writeFile(join(output,process.env.PET_OLD_RENDERER?'old-result.json':'result.json'),JSON.stringify(results,null,2));console.log('Action recovery passed',results)
} finally {await browser.close();await dispose();server.closeAllConnections();await new Promise(r=>server.close(r));if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;await rm(temp,{recursive:true,force:true})}
