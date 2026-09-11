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
const output=resolve('../../desktop/.artifacts/dragonbones-development'), temp=await mkdtemp(join(tmpdir(),'pet-dragonbones-'))
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
 const initial=await page.evaluate(()=>{step(60);return pet.inspect()})
 assert.equal(initial.constraints,117);assert.equal(initial.bones,101);assert.equal(initial.clockListeners,0)
 assert.equal(initial.activeTransforms,27,'Every authored transform constraint is active, including multiple constraints on one bone')
 assert.ok(Math.abs(initial.head+Math.PI/2)<.15,'Idle head preserves the authored upright orientation')
 const regions=await page.evaluate(()=>{const found=new Set();for(let y=0;y<700;y+=10)for(let x=0;x<600;x+=10){const region=pet.region(x,y);if(region)found.add(region)}return {found:[...found],transparent:pet.hit(0,0)}})
 assert.ok(regions.found.includes('head'));assert.ok(regions.found.includes('body'));assert.equal(regions.transparent,false)
 await page.locator('canvas').screenshot({path:resolve('assets/models/mengmei/preview.png'),omitBackground:true})
 const gazeSamples={}
 for(const [name,point] of Object.entries({left:{x:-1500,y:200},right:{x:2000,y:200},up:{x:300,y:-2000},down:{x:300,y:2500},corner:{x:2000,y:-2000}})) {
  gazeSamples[name]=await page.evaluate(async point=>{pet.dispose();pet=await make();for(let i=0;i<120;i++){clock+=1000/60;pet.update(clock,point)}return pet.inspect()},point)
  assert.ok(Math.hypot(gazeSamples[name].gaze.x / 300,gazeSamples[name].gaze.y / 350)<=1.0001)
  await page.screenshot({path:join(output,`gaze-${name}.png`)})
 }
 await writeFile(join(output,'gaze-result.json'),JSON.stringify(gazeSamples,null,2))
 assert.ok(gazeSamples.right.gaze.face.x>gazeSamples.left.gaze.face.x+20,'Authored face follows horizontal pointer')
 assert.ok(gazeSamples.right.gaze.eye.x>gazeSamples.left.gaze.eye.x+2,'Authored pupils follow horizontal pointer')
 assert.ok(gazeSamples.down.gaze.face.y>gazeSamples.up.gaze.face.y+20,'Authored face follows vertical pointer')
 assert.ok(gazeSamples.down.gaze.eye.y>gazeSamples.up.gaze.eye.y+2,'Authored pupils follow vertical pointer')
 assert.ok(gazeSamples.right.gaze.body.x>gazeSamples.left.gaze.body.x+200,'Authored zhuanshen constraint turns the torso with the pointer')
 const mouthBlend=await page.evaluate(async()=>{
  pet.dispose();pet=await make();step(30);const samples=[pet.inspect()]
  pet.speech.start({duration:2,cues:[{time:0,shape:'a'}]},()=>.3)
  for(let i=0;i<12;i++){step(1);samples.push(pet.inspect())}
  return samples
 })
 assert.equal(mouthBlend[0].mouthWeights.reduce((n,s)=>n+s.weight,0),0,'Idle starts with zero speech influence')
 for(const sample of mouthBlend) assert.ok(sample.mouthWeights.reduce((n,s)=>n+s.weight,0)<=1.000001,'Speech influence never exceeds full weight')
 const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]))
 const total=distance(mouthBlend[0].mouthVertices,mouthBlend.at(-1).mouthVertices)
 await writeFile(join(output,'mouth-blend-result.json'),JSON.stringify(mouthBlend.map(s=>({weights:s.mouthWeights,vertices:s.mouthVertices})),null,2))
 assert.ok(total>1,'Authored mouth deforms actually change')
 assert.ok(distance(mouthBlend[0].mouthVertices,mouthBlend[1].mouthVertices)<total*.2,'First frame does not snap to the target mouth')
 assert.ok(new Set(mouthBlend.map(s=>JSON.stringify(s.mouthVertices))).size>6,'Transition renders intermediate mesh deformation frames')
 await writeFile(join(output,'mouth-blend-result.json'),JSON.stringify(mouthBlend.map(s=>({weights:s.mouthWeights,vertices:s.mouthVertices})),null,2))
 const viaM = await page.evaluate(()=>{pet.speech.start({duration:2,cues:[{time:0,shape:'o'}]},()=>.3);const samples=[];for(let i=0;i<13;i++){step(1);samples.push(pet.inspect().mouthWeights)}return samples})
 assert.ok(viaM[5].find(s=>s.shape==='m').weight>.99,'Vowel transition passes through authored m after 100 ms')
 assert.ok(viaM[12].find(s=>s.shape==='o').weight>.99,'Whole vowel transition reaches its target within 200 ms')
 const releasedMouth = await page.evaluate(()=>{pet.speech.cancel();step(14);return pet.inspect()})
 assert.ok(releasedMouth.mouthWeights.every(s=>s.weight===0),'Cancelling clears every speech pose weight')
 assert.deepEqual(releasedMouth.mouthVertices,mouthBlend[0].mouthVertices,'The actual lip mesh returns to the authored idle, not the m pose')
 const shortTiming = JSON.parse(await readFile(new URL('../tests/fixtures/interjection-timing.json', import.meta.url)))
 const shortCues = speechCues('啊？这样吗？', shortTiming.duration, shortTiming.subtitles)
 const shortSamples = await page.evaluate(async timeline => {
  pet.dispose();pet=await make();step(30);let audioTime=0;pet.speech.start(timeline,()=>audioTime);const samples=[]
  for(let i=0;i<135;i++){audioTime=i/60;step(1);samples.push({time:audioTime,weights:pet.inspect().mouthWeights})}return samples
 },shortCues)
 assert.ok(shortSamples.some(s=>s.time>.455&&s.time<.665&&s.weights.find(w=>w.shape==='a').weight>.9),'Short interjection visibly opens before its real word timestamp ends')
 assert.ok(shortSamples.at(-1).weights.every(w=>w.weight===0),'Short phrase ends with no speech influence')
 await writeFile(join(output,'short-interjection-result.json'),JSON.stringify({timeline:shortCues,samples:shortSamples},null,2))
 await page.evaluate(async()=>{pet.dispose();pet=await make();for(let i=0;i<120;i++){clock+=1000/60;pet.update(clock,{x:2000,y:-2000})}})
 const gazeBehavior=await page.evaluate(()=>{
  const before=pet.inspect().gaze;clock+=1000/60;pet.update(clock,{x:-2000,y:2500});const first=pet.inspect().gaze
  pet.react('drag');for(let i=0;i<120;i++){clock+=1000/60;pet.update(clock,{x:2000,y:0})}const drag=pet.inspect().gaze
  pet.react('release');pet.speech.start({duration:2,cues:[{time:0,shape:'a'}]},()=>.5)
  for(let i=0;i<60;i++){clock+=1000/60;pet.update(clock,{x:2000,y:0})}const speaking=pet.inspect()
  settings.animated=false;clock+=1000/60;pet.update(clock,{x:-2000,y:0});const off=pet.inspect().gaze
  settings.animated=true;pet.speech.cancel();step(120)
  return {before,first,drag,speaking,off}
 })
 assert.ok(Math.hypot(gazeBehavior.first.x-gazeBehavior.before.x,gazeBehavior.first.y-gazeBehavior.before.y)<70,'Gaze reversal moves less than one tenth of the configured horizontal full span in its first frame')
 assert.ok(Math.hypot(gazeBehavior.drag.x,gazeBehavior.drag.y)<.1,'Dragging recenters gaze')
 assert.equal(gazeBehavior.speaking.mouth,'a');assert.ok(gazeBehavior.speaking.gaze.y>100,'Gaze continues during gesture and speech')
 assert.equal(gazeBehavior.off.x,0);assert.equal(gazeBehavior.off.y,0)
 await writeFile(join(output,'gaze-result.json'),JSON.stringify({directions:gazeSamples,behavior:gazeBehavior},null,2))
 const actions=[]
 for(const action of ['touch','click','annoyed','drag','release']) {
  const state=await page.evaluate(a=>{pet.react(a);step(30);return pet.inspect()},action)
  assert.equal(state.state,action);actions.push({action,state});await page.screenshot({path:join(output,action+'.png')})
  assert.ok(Math.abs(state.head+Math.PI/2)<.15, `${action} must not introduce a full-turn constraint interpolation`)
  await page.waitForTimeout(150)
 }
 const poses=[]
 for(const name of ['bei','jing','xi','nu','biyan']){
  await page.evaluate(name=>{pet.preview(null,name);step(30)},name);await page.screenshot({path:join(output,`expression-${name}.png`)})
 }
 await page.evaluate(()=>{pet.preview(null,'xi');window.audioTime=0;pet.speech.start({duration:2,cues:[{time:0,shape:'m'},{time:.5,shape:'a'},{time:1,shape:'o'},{time:1.5,shape:'i'}]},()=>audioTime)})
 for(const [index,shape] of ['m','a','o','i'].entries()) {
  const state=await page.evaluate(t=>{audioTime=t;step(15);return pet.inspect()},index*.5)
  assert.equal(state.mouth,shape);poses.push(state);await page.screenshot({path:join(output,'mouth-'+shape+'.png')})
 }
 assert.ok(poses.at(-1).bodyTime!==poses[0].bodyTime,'Body continues while mouth changes')
 const paused=await page.evaluate(()=>{step(30);return pet.inspect()});assert.equal(paused.mouth,'i','Unchanged audio clock holds mouth')
 const ended=await page.evaluate(()=>{audioTime=2;step(14);return pet.inspect()});assert.equal(ended.mouth,'m');assert.equal(ended.speaking,false);assert.ok(ended.mouthWeights.every(s=>s.weight===0),'Completed speech releases all mouth weights to the authored idle')
 const audio=await page.evaluate(async()=>{
  const audio=new Audio('/timing.wav');audio.muted=true
  const timeline={duration:2,cues:[{time:0,shape:'m'},{time:.3,shape:'a'},{time:.8,shape:'o'},{time:1.3,shape:'i'}]}
  pet.speech.start(timeline,()=>audio.currentTime);let frame;const tick=now=>{pet.update(now);frame=requestAnimationFrame(tick)};frame=requestAnimationFrame(tick)
  await audio.play();await new Promise(r=>setTimeout(r,500));audio.pause()
  const first={time:audio.currentTime,...pet.inspect()};await new Promise(r=>setTimeout(r,200));const held={time:audio.currentTime,...pet.inspect()}
  await audio.play();await new Promise(r=>audio.addEventListener('ended',r,{once:true}));await new Promise(r=>setTimeout(r,100));const ended=pet.inspect()
  cancelAnimationFrame(frame);audio.removeAttribute('src');audio.load();return {first,held,ended}
 })
 assert.equal(audio.first.mouth,'a');assert.equal(audio.held.time,audio.first.time);assert.equal(audio.held.mouth,'a');assert.equal(audio.ended.mouth,'m');assert.equal(audio.ended.speaking,false)
 await page.evaluate(()=>{settings.animated=false;step(1)})
 const still=await page.locator('canvas').evaluate(c=>c.toDataURL());await page.evaluate(()=>{for(let i=0;i<30;i++){clock+=1000/60;pet.update(clock,{x:i%2?2000:-2000,y:0})}})
 assert.equal(await page.locator('canvas').evaluate(c=>c.toDataURL()),still)
 const visible=await page.locator('canvas').evaluate(c=>{const gl=c.getContext('webgl2')||c.getContext('webgl'),p=new Uint8Array(c.width*c.height*4);gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,p);let n=0;for(let i=3;i<p.length;i+=4)if(p[i]>24)n++;return n})
 assert.ok(visible>1000)
 const lifetimes=[],session=await context.newCDPSession(page);await session.send('Performance.enable')
 for(let i=0;i<8;i++){
  const state=await page.evaluate(async()=>{pet.dispose();const canvases=document.querySelectorAll('canvas').length;pet=await make();step(1);return {canvases,...pet.inspect()}})
  await session.send('HeapProfiler.collectGarbage');const metrics=await session.send('Performance.getMetrics');state.heapBytes=metrics.metrics.find(m=>m.name==='JSHeapUsedSize').value
  assert.equal(state.canvases,0);assert.equal(state.clockListeners,0);lifetimes.push(state)
 }
 assert.ok(lifetimes.at(-1).heapBytes-lifetimes[2].heapBytes<3*1024*1024,'Heap remains bounded after warmup')
 await session.detach()
 await page.evaluate(()=>pet.dispose());assert.equal(await page.locator('canvas').count(),0)
 const authored=[]
 for(const name of ['idle','diantou','yaotou','wuxiong','xi','nu','bei','jing','biyan','a','o','i','m']) {
  const frames=await page.evaluate(async name=>{
    settings.animated=true;pet=await make();pet.preview(name);const samples=[]
    for(let i=0;i<180;i++){step(1);const state=pet.inspect();samples.push({head:state.head,activeTransforms:state.activeTransforms})}
    return samples
  },name)
  assert.ok(frames.every(frame=>Math.abs(frame.head+Math.PI/2)<.15),`${name}: no broken-neck full-turn blend throughout playback`)
  assert.ok(frames.every(frame=>frame.activeTransforms===27))
  await page.screenshot({path:join(output,`verified-${name}.png`)});authored.push({name,frames:frames.length,minHead:Math.min(...frames.map(f=>f.head)),maxHead:Math.max(...frames.map(f=>f.head))})
  await page.evaluate(()=>pet.dispose())
 }
 await page.route('**/mengmei_tex.png',route=>route.abort())
 const failed=await page.evaluate(async()=>{try{pet=await make();return false}catch{return document.querySelectorAll('canvas').length===0}})
 assert.equal(failed,true,'Failed loading leaves no canvas')
 await page.unroute('**/mengmei_tex.png')
 await page.evaluate(async()=>{pet=await make();step(1);pet.dispose()})
 assert.deepEqual(errors,[])
 await context.close()
 await writeFile(join(output,'renderer-result.json'),JSON.stringify({initial,regions,actions,poses,paused,ended,audio,visible,lifetimes,authored,failedLoadRecovered:failed,errors},null,2))
 console.log('DragonBones passed: 117 constraints, gestures, expressions, layered mouth cues, paused frame, 8 renderer lifetimes.')
}finally{await browser.close();dispose();server.closeAllConnections();await new Promise(r=>server.close(r));if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;await rm(temp,{recursive:true,force:true})}
