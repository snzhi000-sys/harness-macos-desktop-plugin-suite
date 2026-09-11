import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { conversationStore, conversationDefaults, validateConversation } from '../src/conversation-store.mjs'
import { createConversationHost } from '../src/conversation-host.mjs'
import { asrPacket, decodeVoicePacket } from '../src/voice-protocol.mjs'
import { speechCues } from '../src/speech-cues.mjs'
import { createSpeechTextFilter, speechSegmentLength } from '../src/speech-text.mjs'
import { fixtureEmotion } from './fixtures/emotion.mjs'

test('speech excludes streamed nested asides and preserves short interjections', () => {
  const filter = createSpeechTextFilter()
  assert.equal(['啊？（惊','讶！（轻声））这','样吗？(smiles)当然。'].map(filter).join(''),'啊？这样吗？当然。')
  assert.equal(speechSegmentLength('啊？',80),0)
  assert.equal(speechSegmentLength('啊？这样吗？',80),6)
  assert.equal(filter('（尚未闭合'), ''); assert.equal(filter('不朗读'), '')
  const short = speechCues('啊？',.24,[{word:'啊？',startTime:0,endTime:.24}])
  assert.equal(short.cues.at(-1).shape,'a','Question punctuation cannot close the mouth halfway through the vowel')
  assert.equal(speechCues('啊？',.24).cues.at(-1).shape,'a')
  const partial = speechCues('啊？这样吗',1,[{word:'这样吗',startTime:.3,endTime:.9}])
  assert.equal(partial.alignment,'partial-word-pinyin'); assert.ok(partial.cues.some(c=>c.shape==='a'&&c.time<.3))
})

test('ellipsis and repeated asides preserve every spoken suffix regardless of streaming cuts',()=>{
 const original='（红着耳朵抬起头，睫毛忽闪）我、我还好！就是有点突然……（抿嘴笑）你不生气啦？'
 const expected=['我、我还好！','就是有点突然……','你不生气啦？']
 for(let cut=0;cut<=original.length;cut++){
   const filter=createSpeechTextFilter(),parts=[];let pending=''
   for(const delta of [original.slice(0,cut),original.slice(cut)])for(const ch of delta){pending+=filter(ch);for(;;){const n=speechSegmentLength(pending,100);if(!n)break;parts.push(pending.slice(0,n));pending=pending.slice(n)}}
   if(pending)parts.push(pending)
   assert.deepEqual(parts,expected,`cut ${cut}`)
 }
 assert.equal(speechSegmentLength('就是有点突然...',100),0)
 assert.equal(speechSegmentLength('就是有点突然...你',100),9)
 assert.equal(speechSegmentLength('价格是3.14元。',100),9)
})

test('private keys are retained by blank edits, explicitly cleared, and never returned by read API', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-store-'))
  try {
    const store = conversationStore(dir)
    store.save({ config: { ...conversationDefaults, model: 'test' }, keys: { llm: 'private-test-value', tts: 'tts-test' } })
    assert.equal(JSON.stringify(store.publicConfig()).includes('private-test-value'), false)
    store.save({ config: store.config, keys: { llm: '', tts: null } }); assert.equal(store.keys.llm, 'private-test-value'); assert.equal(store.keys.tts, undefined)
    assert.equal(statSync(join(dir, 'voice-credentials.json')).mode & 0o777, 0o600)
    assert.equal(conversationStore(dir).keys.llm, 'private-test-value')
    assert.throws(() => validateConversation({ baseUrl: 'http://evil.test' }))
    assert.throws(() => validateConversation({ baseUrl: 'https://ark.cn-beijing.volces.com.evil.test/api/v3' }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('compressed PCM packets retain signed sequence and reject truncated data', () => {
  const source = Buffer.from([1, 0, 2, 0]), packet = asrPacket(4, source, true, true), decoded = decodeVoicePacket(packet)
  assert.equal(decoded.sequence, -4); assert.equal(decoded.last, true); assert.deepEqual(decoded.payload, source)
  assert.throws(() => decodeVoicePacket(packet.subarray(0, packet.length - 2)))
})
test('word timing leaves silence closed and produces authored a/o/i/m shapes', () => {
  const result = speechCues('阿哦衣妈', 4, [{ words: ['阿', '哦', '衣', '妈'].map((word, i) => ({ word, startTime: i + .2, endTime: i + .7 })) }])
  assert.equal(result.alignment, 'word-pinyin'); assert.deepEqual(new Set(result.cues.map(c => c.shape)), new Set(['m', 'a', 'o', 'i']))
  assert.equal(result.cues.find(c => c.time === .7).shape, 'm'); assert.equal(speechCues('hello', 1).alignment, 'estimated')
  const continuous = speechCues('阿哦衣', .6, [{ words: ['阿', '哦', '衣'].map((word, i) => ({word, startTime:i*.2,endTime:(i+1)*.2})) }])
  assert.ok(continuous.cues.filter(c => c.shape === 'm').every(c => c.time === 0), 'Contiguous vowels do not insert tiny closed-mouth interruptions')
})
test('Host cancels obsolete speech, records actual model input, and leaves text enabled when TTS is off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-conversation-')); let syntheses = 0, aborted = 0
  const services = {
    async converse(_c, _k, _m, delta, signal) { if (_m[0].content.includes('五行纯文本')) { delta(fixtureEmotion('平静')); return } delta('你好。'); await new Promise(r => setTimeout(r, 30)); if (signal.aborted) throw new DOMException('cancelled','AbortError'); delta('今天好吗？') },
    async synthesize(_c, _k, _t, signal) { syntheses++; await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 500); signal.addEventListener('abort', () => { clearTimeout(timer); aborted++; reject(new DOMException('cancelled','AbortError')) }, { once: true }) }); return { pcm: Buffer.alloc(4800), duration: .1, sampleRate: 24000, subtitles: [] } },
  }
  const host = createConversationHost(dir, {}, services)
  const server = createServer((req, res) => host.handle(req, res, new URL(req.url, 'http://localhost')))
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}/desktop-pet/api/conversation`
  const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, value: await r.json() } }
  const playerController = new AbortController()
  try {
    const playerResponse = await fetch(base + '/events?role=player', { signal: playerController.signal })
    void (async()=>{try{for await(const chunk of playerResponse.body){ /* Keep the playback connection consumed and owned through the test. */ }}catch(error){if(!playerController.signal.aborted)throw error}})()
    await post('/config', { config: { ...conversationDefaults, model: 'test', ttsEnabled: true }, keys: { llm: 'test', tts: 'test' } })
    assert.equal((await post('/send', { text: '第一句' })).status, 200)
    assert.equal((await post('/send', { text: '重复' })).status, 400)
    for (let i=0;i<200 && (!syntheses || host.store.session.messages.at(-1).status==='streaming');i++) await new Promise(r=>setTimeout(r,10))
    await post('/config', { config: { ...host.store.config, ttsEnabled: false } })
    await new Promise(r => setTimeout(r, 30)); assert.ok(aborted >= 1)
    const previous = syntheses; assert.equal((await post('/send', { text: '第二句' })).status,200); for(let i=0;i<200&&host.store.session.messages.at(-1).status==='streaming';i++)await new Promise(r=>setTimeout(r,10)); assert.equal(syntheses, previous)
    const state = await (await fetch(base)).json(); assert.equal(state.session.messages.at(-1).content, '你好。今天好吗？')
    assert.equal(host.store.session.requests.filter(r=>r.kind==='dialogue').at(-1).messages.at(-1).content, '第二句')
    assert.equal(readFileSync(join(dir, 'conversation-session.json'), 'utf8').includes('private-test-value'), false)
    await post('/new', {}); assert.equal(host.store.session.messages.length, 0)
  } finally { playerController.abort(); await host.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, { recursive: true, force: true }) }
})
