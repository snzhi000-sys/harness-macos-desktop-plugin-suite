import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { conversationStore } from '../src/conversation-store.mjs'
import { validateConversation } from '../src/conversation-store.mjs'
import { defaultIntimacyLevels, validateIntimacyLevels, intimacyState, intimacyPrompt } from '../src/intimacy.mjs'
import { bubbleParts } from '../src/bubble-text.mjs'
import { conversationActions } from '../src/conversation-actions.mjs'

test('inclusive level boundaries cover every score and descriptions remain literal text', () => {
  assert.deepEqual(validateConversation({intimacyLevels:defaultIntimacyLevels.map(({max,...level})=>level)}).intimacyLevels,defaultIntimacyLevels)
  for (const max of [9,11,-1]) { const levels=structuredClone(defaultIntimacyLevels);levels[0].max=max;assert.throws(()=>validateIntimacyLevels(levels)) }
  const edited=structuredClone(defaultIntimacyLevels);edited[0].max=15;edited[1].min=16;validateIntimacyLevels(edited)
  assert.equal(intimacyState({intimacy:{score:15}},edited).level,1);assert.equal(intimacyState({intimacy:{score:16}},edited).level,2)
  for (const [score, level] of [[0,1],[10,1],[11,2],[20,2],[21,3],[40,3],[41,4],[65,4],[66,5],[1000,5]]) assert.equal(intimacyState({intimacy:{score}}, defaultIntimacyLevels).level, level)
  for (const levels of [[],[{min:1,name:'a',description:'b'}],[{min:0,name:'a',description:'b'},{min:0,name:'b',description:'c'}],[{min:0,name:'',description:'b'}]]) assert.throws(() => validateIntimacyLevels(levels))
  const state = intimacyState({intimacy:{score:11}},defaultIntimacyLevels)
  state.description = '$& {{情绪模拟}}'
  assert.equal(intimacyPrompt('custom without variable',state),'custom without variable')
  assert.match(intimacyPrompt('{{亲密情况}}',state),/\$& \{\{情绪模拟\}\}/)
})

test('migration starts at zero, only complete nonempty future turns count once and reset retains level settings', () => {
  const root=mkdtempSync(join(tmpdir(),'pet-intimacy-'))
  const pair=(id,status='complete',content='回答')=>[{id:id+'u',role:'user',content:'你好',status:'complete'},{id,role:'assistant',content,status}]
  try {
    writeFileSync(join(root,'conversation-session.json'),JSON.stringify({id:'old',messages:pair('old'),requests:[]}))
    let store=conversationStore(root)
    assert.equal(store.session.intimacy.score,0)
    store.session.messages.push(...pair('new'));assert.equal(store.completeTurn('new'),true);assert.equal(store.completeTurn('new'),false);store.persist()
    store=conversationStore(root);assert.equal(store.session.intimacy.score,1)
    assert.equal(store.completeTurn('new'),false)
    for(const [status,content] of [['interrupted','半句'],['failed','错误'],['complete','']]) {store.session.messages.push(...pair(status,status,content));assert.equal(store.completeTurn(status),false)}
    store.session.messages.push(...pair('second'));store.completeTurn('second');assert.equal(store.session.intimacy.score,2);assert.equal(store.completeTurn('new'),false)
    const config=store.config;store.reset();assert.equal(store.session.intimacy.score,0);assert.deepEqual(store.config,config)
    assert.equal(conversationStore(root).session.intimacy.score,0)
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('bubble projection keeps brackets and raw markup literal during nested streaming asides', () => {
  for (const text of ['（红着耳朵）我还好！（抿嘴笑）你不生气啦？','（微笑(点头)）你好','未闭合（轻声','<img src=x onerror=alert(1)>','孤立）正文']) assert.equal(bubbleParts(text).map(p=>p.text).join(''),text)
  assert.deepEqual(bubbleParts('（微笑(点头)）你好'),[{text:'（微笑(点头)）',aside:true},{text:'你好',aside:false}])
  assert.deepEqual(bubbleParts('我（轻声'),[{text:'我',aside:false},{text:'（轻声',aside:true}])
})

test('audio owns held actions; interrupt suppresses further gestures until the next reply, ending releases gaze', () => {
  const module={id:'smile',category:'body',automaticEligible:true}, calls=[]
  const renderer={state:'idle',info:{id:'pet',actionModules:[module]},setSpeaking(v){calls.push(['gaze',v])},cancelSpeaking(){if(this.state==='speaking')this.state='idle'},cancelAutomatic(){if(this.state==='automatic')this.state='idle'},playSpeaking(a){calls.push(['held',a.id]);this.state='speaking'},playAutomatic(a){calls.push(['once',a.id]);this.state='automatic'}}
  const actions=conversationActions(renderer,()=>true,e=>{throw e}), keywords={pet:{smile:['笑']}}
  actions.beginSpeech();actions.play('笑',keywords);assert.equal(renderer.state,'speaking');assert.equal(actions.speaking,true)
  actions.interrupt();assert.equal(renderer.state,'idle');actions.play('笑',keywords);assert.equal(calls.filter(c=>c[0]==='held').length,1)
  actions.endSpeech();assert.equal(actions.speaking,false);assert.deepEqual(calls.at(-1),['gaze',false])
  actions.reset();actions.beginSpeech();actions.play('笑',keywords);actions.endSpeech();assert.equal(renderer.state,'idle');assert.equal(calls.filter(c=>c[0]==='held').length,2)
})
