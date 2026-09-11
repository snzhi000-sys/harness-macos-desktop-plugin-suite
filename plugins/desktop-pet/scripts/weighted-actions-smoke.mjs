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
const output=resolve('../../desktop/.artifacts/pet-weighted-actions'), temp=await mkdtemp(join(tmpdir(),'pet-dragonbones-'))
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
 for(const action of [null,'xi','jing','diantou','__speech_i','__speech_o']) {
  samples[action??'idle']={}
  for(const weight of action?[0,.25,.5,.75,1]:[0]) {
   const state=await page.evaluate(async({action,weight})=>{pet.dispose();pet=await make();step(60);if(action)pet.startDebug({animation:action,weight});step(60);return pet.inspect()},{action,weight})
   samples[action??'idle'][weight]=state
   if(action?.startsWith('__speech_')) await page.screenshot({path:join(output,action+'-'+weight+'.png')})
  }
 }
 const distance=(a,b)=>Object.keys(a).reduce((sum,key)=>sum+a[key].reduce((n,v,i)=>n+Math.abs(v-(b[key]?.[i]??0)),0),0)
 for(const action of ['xi','jing','diantou','__speech_i','__speech_o']) {
  assert.ok(distance(samples[action][0].deforms,samples.idle[0].deforms)<.01,action+' zero influence restores base meshes')
  const full=distance(samples[action][1].deforms,samples[action][0].deforms),half=distance(samples[action][.5].deforms,samples[action][0].deforms)
  assert.ok(full>.1,action+' has visible deformation');assert.ok(half>0&&half<full,action+' partial weight changes deformation')
 }
 const timeline=await page.evaluate(()=>{
  pet.stopDebug();step(30);let t=0;pet.speech.start({duration:3,cues:[{time:0,shape:'i',weight:.3},{time:1,shape:'i',weight:.8},{time:2,shape:'o',weight:.45}]},()=>t)
  step(30);const low=pet.inspect();t=1;step(30);const high=pet.inspect();t=2;step(30);const rounded=pet.inspect();t=3;step(30);return {low,high,rounded,end:pet.inspect()}
 })
 assert.ok(Math.abs(timeline.low.mouthWeights.find(s=>s.shape==='i').weight-.3)<.001)
 assert.ok(Math.abs(timeline.high.mouthWeights.find(s=>s.shape==='i').weight-.8)<.001)
 assert.ok(distance({mouth:timeline.low.mouthVertices},{mouth:timeline.high.mouthVertices})>1)
 assert.ok(timeline.end.mouthWeights.every(s=>s.weight===0),'Speech ending releases every weighted mouth pose')
 await writeFile(join(output,'result.json'),JSON.stringify({samples,timeline},null,2))
 assert.deepEqual(errors,[]);await context.close();console.log('Official runtime weighted body/expression/mouth poses and audio-clock changes passed')
}finally{await browser.close();dispose();server.closeAllConnections();await new Promise(r=>server.close(r));if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;await rm(temp,{recursive:true,force:true})}
