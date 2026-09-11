import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {createConversationHost} from '../src/conversation-host.mjs'
import {conversationDefaults,conversationStore} from '../src/conversation-store.mjs'
import {recentTurns,matchAction,dialoguePrompt,normalizeEmotionOutput,legacyEmotionPrompt,emotionPrompt,emotionRequestPrompt} from '../src/satellites.mjs'
import {validateConversation} from '../src/conversation-store.mjs'
import {fixtureEmotion} from './fixtures/emotion.mjs'
import {createSpeechTextFilter} from '../src/speech-text.mjs'
import {conversationActions} from '../src/conversation-actions.mjs'
import {recentEmotionMessages, emotionHistoryText, expandEmotionPrompt} from '../src/satellites.mjs'
const waitFor = async fn => { for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw Error('Timed out') }

test('emotion output keeps five ordered first-person fields and only repairs field whitespace',()=>{
 const valid=fixtureEmotion('有点哭笑不得')
 assert.equal(normalizeEmotionOutput(valid),valid)
 assert.equal(normalizeEmotionOutput(valid.replaceAll('\n','\n\n').replace('语气色彩：','语气色彩:').replace('\n\n情绪基调',' 情绪基调')),valid)
 for(const bad of ['平静',valid.replace('态度方向：','当前心情：'),valid.replace('当前心情：我','当前心情：她'),'说明：\n'+valid,valid+'\n以上仅作参考',valid.replace(/\n情绪基调.*/,'' )])assert.throws(()=>normalizeEmotionOutput(bad))
 assert.equal(validateConversation({emotionPrompt:legacyEmotionPrompt}).emotionPrompt,emotionPrompt)
 assert.equal(validateConversation({emotionPrompt:'我自定义的人设情绪规则'}).emotionPrompt,'我自定义的人设情绪规则')
 assert.match(emotionRequestPrompt('我自定义的人设情绪规则'),/五行纯文本/)
})

test('emotion jobs use completed turns, inject only a completed snapshot and reject late obsolete results',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pet-satellites-')),calls=[],pending=[]
 const host=createConversationHost(dir,{}, {async converse(c,k,m,delta,signal){
   calls.push(m)
   if(m[0].content.includes('五行纯文本')){
     if(pending.length===0 && calls.length===1){delta(fixtureEmotion('初见好奇'));return}
     await new Promise(resolve=>pending.push({resolve:text=>{delta(fixtureEmotion(text));resolve()},signal}));return
   }
   delta('（开心）收到。')
 }})
 host.store.save({config:{...conversationDefaults,model:'test',prompt:'角色。{{情绪模拟}}'},keys:{llm:'fixture'}})
 const server=createServer((req,res)=>host.handle(req,res,new URL(req.url,'http://localhost')));server.listen(0,'127.0.0.1');await once(server,'listening')
 const post=async(path,body={})=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/desktop-pet/api/conversation${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json()}
 try{
   await post('/send',{text:'你好'});await waitFor(()=>pending.length===1)
   assert.match(calls[0][0].content,/用户：你好/)
   assert.equal(calls[0][1].content,'请根据以上聊天记录生成当前情绪。')
   assert.equal(calls[1][0].content,'角色。'+fixtureEmotion('初见好奇'))
   assert.equal(host.store.session.messages.length,2)
   assert.equal(host.store.session.intimacy.score,1)
   assert.match(calls[0][0].content,/当前亲密度：0/)
   assert.match(calls[2][0].content,/当前亲密度：1/)
   assert.match(calls[2][0].content,/用户：你好\n糖糖：（开心）收到。/)
   await post('/send',{text:'第二轮'});await waitFor(()=>pending.length===2)
   assert.equal(calls[3][0].content,'角色。'+fixtureEmotion('初见好奇'),'Pending emotion cannot delay the next reply')
   assert.equal(pending[0].signal.aborted,true)
   pending[1].resolve('新的快乐');await waitFor(()=>host.store.session.emotion.text===fixtureEmotion('新的快乐'))
   pending[0].resolve('迟到的旧情绪');await new Promise(r=>setTimeout(r,20))
   assert.equal(host.store.session.emotion.text,fixtureEmotion('新的快乐'))
   assert.equal(host.store.session.messages.length,4)
   assert.equal(host.store.session.intimacy.score,2)
   assert.equal(conversationStore(dir).session.emotion.text,fixtureEmotion('新的快乐'),'Emotion persists independently of chat')
   await post('/new');assert.equal(host.store.session.emotion,undefined)
   assert.equal(host.store.session.intimacy.score,0)
 }finally{for(const item of pending)item.resolve('cleanup');await host.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true})}
})

test('eight completed pairs exclude interrupted turns and never split a turn',()=>{
 const messages=[];for(let i=0;i<10;i++)messages.push({role:'user',content:''+i,status:'complete'},{role:'assistant',content:'reply'+i,status:'complete'})
 messages.push({role:'user',content:'unfinished',status:'complete'},{role:'assistant',content:'partial',status:'interrupted'})
 const context=recentTurns(messages,8);assert.equal(context.length,16);assert.equal(context[0].content,'2');assert.equal(context.at(-1).content,'reply9')
 assert.equal(dialoguePrompt('A{{情绪模拟}}B{{情绪模拟}}','happy'),'AhappyBhappy')
 assert.equal(dialoguePrompt('old custom prompt','happy'),'old custom prompt')
})

test('emotion history is eight individual messages from both speakers and variables expand once in place',()=>{
 const lines=['你好','你好呀','有什么事嘛','你好呀','你只会这一句嘛','你好呀','气死了','嘻嘻，开玩笑的']
 const recent=lines.map((content,i)=>({role:i%2?'user':'assistant',content,status:'complete'}))
 const messages=[{role:'user',content:'旧消息',status:'complete'},...recent,{role:'assistant',content:'半句话',status:'interrupted'}]
 const selected=recentEmotionMessages(messages,8)
 assert.equal(selected.length,8)
 const text=emotionHistoryText(selected,'糖糖')
 assert.equal(text,lines.map((content,i)=>(i%2?'用户':'糖糖')+'：'+content).join('\n'))
 assert.equal(recentEmotionMessages(messages,3).length,3,'Odd limits count messages, not pairs')
 assert.match(expandEmotionPrompt('前\n{{聊天记录}}\n后\n{{亲密情况}}',text,'熟悉'),/前\n糖糖：你好/)
 assert.equal(expandEmotionPrompt('{{聊天记录}}','用户：{{亲密情况}} $&','不能替换').startsWith('用户：{{亲密情况}} $&'),true)
 assert.equal(expandEmotionPrompt('没有变量',text,'熟悉').includes('糖糖：你好'),false)
 const migrated=validateConversation({emotionHistoryTurns:8})
 assert.equal(migrated.emotionHistoryMessages,8);assert.equal(Object.hasOwn(migrated,'emotionHistoryTurns'),false)
})

test('emotion failures preserve old context; cancelling initial emotion prevents dialogue and resets auxiliary state',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pet-satellite-failure-'));let mode='fail',entered=false,dialogues=0
 const host=createConversationHost(dir,{}, {async converse(c,k,m,delta,signal){
   if(!m[0].content.includes('五行纯文本')){dialogues++;delta('正常回答');return}
   entered=true
   if(mode==='fail')throw Error('provider unavailable')
   if(mode==='malformed'){delta('开心，我建议换个话题');return}
   await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('stopped','AbortError')),{once:true}))
 }})
 host.store.save({config:{...conversationDefaults,model:'test'},keys:{llm:'fixture'}})
 const server=createServer((req,res)=>host.handle(req,res,new URL(req.url,'http://localhost')));server.listen(0,'127.0.0.1');await once(server,'listening')
 const base=`http://127.0.0.1:${server.address().port}/desktop-pet/api/conversation`
 const post=async(path,body={})=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json()}
 try{
   await post('/send',{text:'首次'});await waitFor(()=>host.store.session.messages.at(-1).status==='complete')
   assert.equal(dialogues,1,'Initial emotion failure still allows a reply');assert.equal(host.store.session.emotion,undefined)
   host.store.session.emotion={text:'先前的平静',updatedAt:new Date().toISOString()};host.store.persist()
   mode='malformed'
   await post('/send',{text:'第二次'});await waitFor(()=>host.store.session.messages.length===4&&host.store.session.messages.at(-1).status==='complete')
   assert.equal(host.store.session.emotion.text,'先前的平静');assert.match((await(await fetch(base)).json()).emotion.error,/沿用/)
   await post('/new');mode='wait';entered=false;await post('/send',{text:'取消首轮'});await waitFor(()=>entered)
   await post('/new');assert.equal(dialogues,2);assert.deepEqual(host.store.session.messages,[]);assert.equal(host.store.session.emotion,undefined)
 }finally{await host.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true})}
})

test('only complete parenthetical text matches the longest configured body keyword and input cancels playback',()=>{
 const asides=[],filter=createSpeechTextFilter(t=>asides.push(t));assert.equal(['开心的话。（开','心地（笑）点头）好','呀(unfinished'].map(filter).join(''),'开心的话。好呀');assert.deepEqual(asides,['开心地笑点头'])
 const modules=[{id:'a',category:'mouth',automaticEligible:true},{id:'smile',category:'body',automaticEligible:true},{id:'nod',category:'body',automaticEligible:true},{id:'idle',category:'body',automaticEligible:false}]
 const tags={a:['开心地笑点头'],smile:['开心'],nod:['笑点头'],idle:['开心地笑点头']}
 assert.equal(matchAction(asides[0],modules,tags).id,'nod');assert.equal(matchAction('无匹配',modules,tags),undefined)
 const plays=[],renderer={info:{id:'pet',actionModules:modules},state:'idle',cancelSpeaking(){},setSpeaking(){},cancelAutomatic(){this.state='idle'},playAutomatic(a){plays.push(a.id);this.state='automatic'}}
 const actions=conversationActions(renderer,()=>true,()=>{});actions.play(asides[0],{pet:tags});assert.deepEqual(plays,['nod']);actions.interrupt();assert.equal(renderer.state,'idle');actions.play(asides[0],{pet:tags});assert.equal(plays.length,1);actions.reset();actions.play('开心',{other:tags});assert.equal(plays.length,1)
})
