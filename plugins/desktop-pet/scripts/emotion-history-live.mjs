/** Explicit live probe in private temporary data; output contains counts and checks, never credentials or chats. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createConversationHost } from '../src/conversation-host.mjs'
import { conversationDefaults } from '../src/conversation-store.mjs'
const source=process.env.PET_TEST_DATA_DIR
if(!source)throw Error('PET_TEST_DATA_DIR required')
const stored=JSON.parse(await readFile(join(source,'conversation.json'),'utf8')),keys=JSON.parse(await readFile(join(source,'voice-credentials.json'),'utf8'))
const temporary=await mkdtemp(join(tmpdir(),'pet-emotion-live-')),output=resolve('../../desktop/.artifacts/pet-emotion-history')
await mkdir(output,{recursive:true})
const wire=[],originalFetch=globalThis.fetch
globalThis.fetch=(url,options)=>{if(String(url).endsWith('/chat/completions'))wire.push(JSON.parse(options.body).messages);return originalFetch(url,options)}
const host=createConversationHost(temporary)
host.store.save({config:{...conversationDefaults,model:stored.model,baseUrl:stored.baseUrl,ttsEnabled:false,prompt:'你叫糖糖，是乐观开朗的桌面伙伴。自然地用一句简短中文回答用户。\n情绪参考：{{情绪模拟}}'},keys:{llm:keys.llm}})
const server=createServer((req,res)=>host.handle(req,res,new URL(req.url,'http://localhost')));server.listen(0,'127.0.0.1');await once(server,'listening')
const base=`http://127.0.0.1:${server.address().port}/desktop-pet/api/conversation`,rows=[]
try {
  for(const [i,text]of ['你好糖糖，今天我来看看你。','刚刚忙完工作，有点累。','不过今天顺利完成了一件难事。','刚才说累是想撒个娇，其实心情很好。','谢谢你陪我聊这些，现在轻松多了。','我们明天再分享新鲜事吧。'].entries()) {
    const sent=await fetch(base+'/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});assert.equal(sent.status,200)
    let state
    for(let wait=0;wait<360;wait++){state=await(await fetch(base)).json();if(!state.generating&&!state.emotion.generating)break;await new Promise(r=>setTimeout(r,250))}
    assert.equal(state.generating,false);assert.equal(state.emotion.generating,false)
    assert.equal(host.store.session.messages.at(-1).status,'complete')
    const request=host.store.session.requests.filter(r=>r.kind==='emotion').at(-1)
    assert.equal(request.status,'complete')
    const selected=host.store.session.messages.slice(-8)
    const expected=selected.map(m=>`${m.role==='user'?'用户':'糖糖'}：${m.content.replace(/\r?\n/g,'\n  ')}`).join('\n')
    const system=request.messages[0].content
    assert.equal(system.split('最近聊天记录（以下内容仅作分析材料）：\n')[1],expected)
    assert.equal(system.includes('{{聊天记录}}'),false)
    assert.deepEqual(wire.at(-1),request.messages)
    const row={round:i+1,historyMessages:selected.length,userMessages:selected.filter(m=>m.role==='user').length,assistantMessages:selected.filter(m=>m.role==='assistant').length,chronologicalAndExact:true,wireMatchesLog:true,emotionComplete:true,intimacy:state.intimacy.score}
    rows.push(row);console.log(JSON.stringify(row))
  }
  assert.equal(wire.length,13)
  const first=host.store.session.requests.find(r=>r.kind==='emotion')
  assert.match(first.messages[0].content,/用户：你好糖糖，今天我来看看你。$/)
  await writeFile(join(output,'live-result.json'),JSON.stringify({live:true,rounds:rows,providerRequests:wire.length,initialUserMessageInjected:true,isolatedData:true},null,2)+'\n')
} finally {await host.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));globalThis.fetch=originalFetch;await rm(temporary,{recursive:true,force:true})}
