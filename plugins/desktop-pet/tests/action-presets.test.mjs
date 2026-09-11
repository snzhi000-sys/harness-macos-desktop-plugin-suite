import test from 'node:test'
import assert from 'node:assert/strict'
import { validateConversation } from '../src/conversation-store.mjs'
import { defaultMouthRecipes, weightedTimeline } from '../src/action-presets.mjs'
import { matchAction } from '../src/satellites.mjs'
import { speechCues } from '../src/speech-cues.mjs'
import { MouthCues } from '../src/mouth-cues.mjs'
import { conversationStore } from '../src/conversation-store.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('legacy keywords become full-weight variants and independent variants match by longest tag then order',()=>{
  const c=validateConversation({actionKeywords:{mengmei:{xi:['笑']}}})
  assert.equal(c.actionPresets.mengmei[0].weight,1)
  const mild={...c.actionPresets.mengmei[0],id:'mild',name:'浅笑',weight:.3,keywords:['微笑']}
  const modules=[{id:'xi',category:'body',automaticEligible:true}]
  assert.equal(matchAction('微笑',modules,{},[mild,...c.actionPresets.mengmei]).weight,.3)
  assert.equal(matchAction('微笑',modules,{},[{...mild,enabled:false},...c.actionPresets.mengmei]).weight,1)
  assert.throws(()=>validateConversation({...c,actionPresets:{mengmei:[mild,{...mild}]}}),/无效/)
  assert.throws(()=>validateConversation({...c,actionPresets:{mengmei:[{...mild,weight:1.1}]}}),/无效/)
})
test('pinyin e/w/y resolves configurable authored poses and weights on the audio timeline',()=>{
  const timeline=speechCues('鹅我也',3)
  for(const phoneme of ['e','w','y'])assert.ok(timeline.cues.some(c=>c.phoneme===phoneme),phoneme)
  const weighted=weightedTimeline(timeline,defaultMouthRecipes)
  for(const phoneme of ['e','w','y']){
    const cue=weighted.cues.find(c=>c.phoneme===phoneme),recipe=defaultMouthRecipes.find(r=>r.phoneme===phoneme)
    assert.equal(cue.shape,recipe.base);assert.equal(cue.weight,recipe.weight)
  }
  let time=0;const controller=new MouthCues(()=>{},['a','o','i','m'],'m')
  controller.start({duration:2,cues:[{time:0,shape:'i',weight:.3},{time:1,shape:'i',weight:.8}]},()=>time)
  assert.equal(controller.weight,.3);assert.equal(controller.remaining,1)
  time=1;controller.update();assert.equal(controller.weight,.8)
  controller.silent=true;controller.update();assert.equal(controller.current,'m')
  time=2;controller.update();assert.equal(controller.active,false)
  assert.throws(()=>controller.start({duration:2,cues:[{time:0,shape:'i',weight:-.1}]},()=>0),/无效/)
})
test('saved variants and recipes survive store reopen and new conversation; invalid edits retain the saved configuration',()=>{
  const path=mkdtempSync(join(tmpdir(),'pet-weight-config-'))
  try {
    const store=conversationStore(path),config=structuredClone(store.config)
    config.actionPresets.mengmei=[{id:'gentle',name:'轻笑',actionId:'xi',weight:.3,enabled:true,keywords:['轻笑']}]
    config.mouthRecipes.mengmei.find(r=>r.phoneme==='e').weight=.42
    store.save({config});store.reset()
    assert.deepEqual(conversationStore(path).config,config)
    const invalid=structuredClone(config);invalid.mouthRecipes.mengmei.push({...invalid.mouthRecipes.mengmei[0]})
    assert.throws(()=>store.save({config:invalid}),/唯一/)
    assert.deepEqual(conversationStore(path).config,config)
  }finally{rmSync(path,{recursive:true,force:true})}
})
