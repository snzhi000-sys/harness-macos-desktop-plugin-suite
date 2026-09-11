import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MouthCues } from '../src/mouth-cues.mjs'
import { prepareDragonBones } from '../src/dragonbones-assets.mjs'
import { builtinLibrary } from '../src/builtin-library.mjs'
test('audio clock pauses, seeks, ends and cancels without leaving an open mouth', () => {
  const calls = []; let time = 0
  const mouth = new MouthCues(shape => calls.push(shape), ['a','o','i','m'], 'm')
  const input = { duration: 2, cues: [{time: .1, shape:'a'}, {time: .5, shape:'o'}, {time: 1, shape:'i'}] }
  mouth.start(input, () => time);time=.2;mouth.update();mouth.update()
  assert.deepEqual(calls,['m','a'])
  time=1.2;mouth.update();assert.equal(mouth.current,'i')
  time=.6;mouth.update();assert.equal(mouth.current,'o')
  time=2;mouth.update();assert.equal(mouth.current,'m');assert.equal(mouth.active,false)
  time=.2;mouth.start(input,()=>time);mouth.cancel();assert.equal(mouth.current,'m')
  assert.throws(()=>mouth.start({duration:2,cues:[{time:1,shape:'a'},{time:.2,shape:'o'}]},()=>0))
  assert.throws(()=>mouth.start({duration:2,cues:[{time:1,shape:'x'}]},()=>0))
  mouth.dispose();mouth.update();assert.equal(mouth.active,false)
})
test('constraint preparation preserves cross-type names and rewrites only physics timelines', () => {
  const raw={version:'6.0',armature:[{ik:[{name:'hand',bone:'hand'}],transform:[],physics:[{name:'hand',bone:'hand'}],defaultActions:[{gotoAndPlay:'a'}],animation:[{ik:[{name:'hand'}],physics:[{name:'hand'}]}]}]}
  const arm=prepareDragonBones(raw).armature[0]
  assert.equal(arm.physics[0].name,'physics:hand');assert.equal(arm.physics[0].bone,'hand')
  assert.equal(arm.animation[0].ik[0].name,'hand');assert.equal(arm.animation[0].physics[0].name,'physics:hand')
  assert.equal(raw.armature[0].physics[0].name,'hand');assert.deepEqual(arm.defaultActions,[])
})
test('all 23 built-in descriptors and previews resolve, including full mengmei constraints', async () => {
  const library=builtinLibrary();assert.equal(library.list().length,23)
  for(const model of library.list()){await library.describe(model.id);await library.asset(model.id,'preview.png')}
  const info=await library.describe('mengmei')
  assert.equal(info.kind,'dragonbones');assert.equal(info.animations.length,15)
  assert.deepEqual(info.counts,{bones:101,slots:36,constraints:117})
})
