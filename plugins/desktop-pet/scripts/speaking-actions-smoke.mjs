/** Real authored engines: speech ownership outlives actions and releases pose and pointer control. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { apply } from '../src/host.mjs'
const temp=await mkdtemp(join(tmpdir(),'pet-speaking-')),output=resolve('../../desktop/.artifacts/pet-intimacy')
await mkdir(output,{recursive:true});const previous=process.env.DSH_HOME;process.env.DSH_HOME=temp
let route,dispose;apply({webServer:{register(r){route=r;return()=>{}}},effect(fn){dispose=fn()}})
const server=createServer(async(req,res)=>{if(req.url==='/fixture'){res.setHeader('content-type','text/html');res.end('<body style="background:#eee;margin:0"><div id="stage" style="width:420px;height:600px"></div>');return}await route.handler(req,res)})
server.listen(0,'127.0.0.1');await once(server,'listening')
const browser=await chromium.launch({headless:true}),results=[]
try {
  for(const id of ['mengmei','azur-atago','companion-01']) {
    const page=await browser.newPage({viewport:{width:420,height:600}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`)
    await page.evaluate(async id=>{
      window.info=await(await fetch('/desktop-pet/api/model?id='+id)).json()
      const db=info.kind==='dragonbones', legacy=info.kind==='cubism2'
      for(const src of db?['pixi8.js','dragonbones-core.js']:[legacy?'core2.js':'core.js'])await new Promise((yes,no)=>{const s=document.createElement('script');s.src='/desktop-pet/'+src;s.onload=yes;s.onerror=no;document.head.append(s)})
      const module=await import('/desktop-pet/'+(db?'dragonbones':legacy?'live2d2':'live2d')+'.js')
      window.clock=performance.now();performance.now=()=>clock
      window.pet=await (db?module.createDragonBonesRenderer:module.createLive2DRenderer)(document.querySelector('#stage'),{animated:true},e=>{throw e},info)
      window.step=(seconds,point={x:410,y:100})=>{for(let i=0;i<seconds*60;i++){clock+=1000/60;pet.update(clock,point)}}
      step(3)
    },id)
    const initial=await page.evaluate(()=>pet.inspect())
    const held=await page.evaluate(async()=>{
      window.action=info.actionModules.find(a=>info.kind==='dragonbones'?a.animation==='jing':a.automaticEligible)
      pet.setSpeaking(true);await pet.playSpeaking(action);step(Math.max(10,action.durationMs/1000+3));return pet.inspect()
    })
    assert.equal(held.state,'speaking',id+' stays held past authored duration')
    if(id==='mengmei') {
      assert.ok(Math.abs(initial.gaze.x)+Math.abs(initial.gaze.y)>10)
      assert.ok(Math.abs(held.gaze.x)+Math.abs(held.gaze.y)<.01,'Speech faces forward')
      assert.ok(held.reactionStates.some(s=>s.name==='jing'&&s.weight>0))
    }
    await page.screenshot({path:join(output,id+'-held.png')})
    await page.evaluate(()=>{pet.cancelSpeaking();pet.setSpeaking(false);step(2)})
    const released=await page.evaluate(()=>pet.inspect());assert.equal(released.state,'idle')
    if(id==='mengmei')assert.ok(Math.abs(released.gaze.x)+Math.abs(released.gaze.y)>10,'Pointer tracking resumes')
    if(id==='mengmei') {
      await page.evaluate(()=>{pet.playSpeaking(action);pet.startDebug(info.actionModules.find(a=>a.animation==='diantou'));pet.cancelSpeaking();pet.stopDebug();step(1)})
      assert.equal(await page.evaluate(()=>pet.state),'idle','Ending audio during preview cannot resurrect its held action')
    }
    if(id==='azur-atago') {
      await page.evaluate(()=>step(2,{x:-1,y:-1}))
      assert.deepEqual((await page.evaluate(()=>pet.inspect())).partOpacities,initial.partOpacities,'Alternate limbs restore on release')
    }
    await page.evaluate(async()=>{await pet.playSpeaking(action);step(.5);pet.cancelSpeaking();await pet.react('click');step(.1)})
    assert.equal(await page.evaluate(()=>pet.state),'click','Input can override speaking action')
    assert.deepEqual(errors,[])
    results.push({id,held,released});await page.evaluate(()=>pet.dispose());await page.close()
  }
  await writeFile(join(output,'speaking-actions.json'),JSON.stringify(results,null,2));console.log('Real DragonBones and both Cubism engines hold speech actions, release and recover pointer tracking.')
} finally {await browser.close();await dispose();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous}
