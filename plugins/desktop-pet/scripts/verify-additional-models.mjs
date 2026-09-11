/** Admit downloaded models only after real renderer motion playback and capture. */
import assert from 'node:assert/strict'
import {createServer}from'node:http'
import {once}from'node:events'
import {readFile,writeFile,mkdir,rm,mkdtemp}from'node:fs/promises'
import {resolve,join}from'node:path'
import {tmpdir}from'node:os'
import {chromium}from'playwright'
import {apply}from'../src/host.mjs'
const output=resolve('../../desktop/.artifacts/pet-expansion-2026-09-09'),file=resolve('assets/catalog.json'),original=await readFile(file,'utf8'),catalog=JSON.parse(original)
const candidates=JSON.parse(await readFile(join(output,'download-result.json'))).filter(r=>r.status==='downloaded').map(r=>r.model),ids=new Set(candidates.map(m=>m.id)),base=catalog.models.filter(m=>!ids.has(m.id))
await writeFile(file,JSON.stringify({...catalog,models:[...base,...candidates]},null,2)+'\n')
const temp=await mkdtemp(join(tmpdir(),'pet-model-accept-')),previous=process.env.DSH_HOME;process.env.DSH_HOME=temp
let route,dispose;apply({webServer:{register(r){route=r;return()=>{}}},effect(fn){dispose=fn()}})
const server=createServer(async(req,res)=>{if(req.url==='/fixture'){res.setHeader('content-type','text/html');res.end('<body style="margin:0;background:#e9e5df"><div id="stage" style="width:420px;height:600px"></div></body>');return}await route.handler(req,res)});server.listen(0,'127.0.0.1');await once(server,'listening')
const browser=await chromium.launch({headless:true}),results=[];let committed=false
try{
 for(const model of candidates){
  const page=await browser.newPage({viewport:{width:420,height:600}})
  try{
   await page.goto(`http://127.0.0.1:${server.address().port}/fixture`)
   const result=await page.evaluate(async id=>{
    const info=await(await fetch('/desktop-pet/api/model?id='+id)).json(),legacy=info.kind==='cubism2'
    await new Promise((yes,no)=>{const s=document.createElement('script');s.src=legacy?'/desktop-pet/core2.js':'/desktop-pet/core.js';s.onload=yes;s.onerror=no;document.head.append(s)})
    const module=await import(legacy?'/desktop-pet/live2d2.js':'/desktop-pet/live2d.js'),errors=[],settings={animated:true}
    const pet=await module.createLive2DRenderer(document.querySelector('#stage'),settings,e=>errors.push(e.message),info);window.pet=pet
    let clock=performance.now();const step=n=>{for(let i=0;i<n;i++){clock+=1000/60;pet.update(clock,{x:210,y:180})}}
    step(30);await new Promise(r=>setTimeout(r,200));step(30)
    const motions=[...new Map(info.motions.map(m=>[m.file,m])).values()];if(motions.length<6)throw Error('Insufficient unique motions')
    const played=[]
    for(const motion of motions){
     await pet.startDebug({motion:{group:motion.group,index:motion.index}})
     const frames=[];for(let i=0;i<8;i++){step(8);frames.push(document.querySelector('canvas').toDataURL())}
     if(new Set(frames).size<2)throw Error('Motion remains static: '+motion.file)
     played.push(motion.file);pet.stopDebug();await new Promise(r=>setTimeout(r,50))
    }
    step(30)
    const c=document.querySelector('canvas'),g=c.getContext('webgl2')??c.getContext('webgl'),p=new Uint8Array(c.width*c.height*4);g.readPixels(0,0,c.width,c.height,g.RGBA,g.UNSIGNED_BYTE,p);let opaque=0;for(let i=3;i<p.length;i+=4)if(p[i]>24)opaque++
    if(opaque<1000)throw Error('Empty model');if(errors.length)throw Error(errors.join('; '))
    return {motions:motions.length,expressions:info.expressions.length,played,opaque,kind:info.kind}
   },model.id)
   await page.locator('canvas').screenshot({path:resolve('assets/models',model.id,'preview.png'),omitBackground:true})
   await page.screenshot({path:join(output,model.id+'.png')});await page.evaluate(()=>pet.dispose());assert.equal(await page.locator('canvas').count(),0)
   results.push({id:model.id,name:model.name,group:model.subtitle,status:'passed',...result});console.log('Passed',model.id,result.motions,'motions')
  }catch(e){results.push({id:model.id,status:'failed',error:e.message});console.log('Failed',model.id,e.message)}finally{await page.close()}
 }
 const passed=new Set(results.filter(r=>r.status==='passed').map(r=>r.id))
 await writeFile(file,JSON.stringify({...catalog,models:[...base,...candidates.filter(m=>passed.has(m.id))]},null,2)+'\n');committed=true
 for(const model of candidates)if(!passed.has(model.id))await rm(resolve('assets/models',model.id),{recursive:true,force:true})
 await writeFile(join(output,'playback-result.json'),JSON.stringify(results,null,2));console.log('Accepted',passed.size)
}finally{if(!committed)await writeFile(file,original);await browser.close();await dispose();server.closeAllConnections();await new Promise(r=>server.close(r));if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;await rm(temp,{recursive:true,force:true})}
