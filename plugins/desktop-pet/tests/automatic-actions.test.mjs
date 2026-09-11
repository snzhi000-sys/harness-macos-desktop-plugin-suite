import {test} from 'node:test'
import assert from 'node:assert/strict'
import {AutomaticActions} from '../src/automatic-actions.mjs'
import {builtinLibrary} from '../src/builtin-library.mjs'
test('only Mengmei authored a/i/o/m modules are mouths and never automatic actions',async()=>{
 const library=builtinLibrary()
 for(const model of library.list()) {
  const info=await library.describe(model.id),mouths=info.actionModules.filter(a=>a.category==='mouth')
  assert.deepEqual(mouths.map(a=>a.animation).sort(),model.id==='mengmei'?['a','i','m','o']:[])
  assert.ok(mouths.every(a=>!a.automaticEligible))
  if(model.id==='mengmei')assert.ok(info.actionModules.filter(a=>['idle','左右','上下'].includes(a.animation)).every(a=>!a.automaticEligible))
 }
})
test('one minute schedules a body action; input and hidden or paused windows cancel and restart the interval',()=>{
 const played=[],renderer={state:'idle',info:{actionModules:[{id:'a',automaticEligible:false},{id:'wave',automaticEligible:true},{id:'nod',automaticEligible:true}]},playAutomatic(a){played.push(a.id);this.state='automatic'},cancelAutomatic(){if(this.state==='automatic')this.state='idle'}}
 const scheduler=new AutomaticActions(renderer,60000,()=>0)
 scheduler.update(0,true);scheduler.update(59999,true);assert.deepEqual(played,[])
 scheduler.update(60000,true);assert.deepEqual(played,['wave'])
 scheduler.interrupt(60010);assert.equal(renderer.state,'idle')
 scheduler.update(120009,true);assert.equal(played.length,1)
 scheduler.update(120010,true);assert.deepEqual(played,['wave','nod'])
 scheduler.update(120020,false);assert.equal(renderer.state,'idle')
 scheduler.update(500000,false);scheduler.update(500001,true);assert.equal(played.length,2)
 renderer.state='debug';scheduler.update(560001,true);assert.equal(played.length,2)
 renderer.state='idle';scheduler.update(620001,true);assert.equal(played.length,3)
})
