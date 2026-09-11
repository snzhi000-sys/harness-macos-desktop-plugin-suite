/** Assembled browser replay exercises the real UI/Host with bounded provider fixtures; optional live mode is explicit. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { apply } from '../src/host.mjs'
import { createConversationHost } from '../src/conversation-host.mjs'
import { conversationDefaults } from '../src/conversation-store.mjs'
import { fixtureEmotion } from '../tests/fixtures/emotion.mjs'
const temp = await mkdtemp(join(tmpdir(), 'pet-chat-browser-')), output = resolve('../../desktop/.artifacts/pet-conversation-development')
await mkdir(output, { recursive: true }); const previous = process.env.DSH_HOME; process.env.DSH_HOME = temp
const live = Boolean(process.env.PET_LIVE_CREDENTIAL_FILE); let syntheses = 0, asrBytes = 0
let fixtureReply = ['你好，', '我是你的桌面伙伴。', '今天想聊些什么？']; const spokenRequests = []
const fixtures = {
  async converse(_c, _k, _m, delta, signal) { if (_m[0].content.includes('五行纯文本')) { delta(fixtureEmotion('平静而亲切')); return } for (const text of fixtureReply) { signal.throwIfAborted(); delta(text); await new Promise(r => setTimeout(r, 120)) } },
  async synthesize(config,_key,text) { spokenRequests.push({text,speaker:config.speaker,voiceKind:config.voiceKind}); syntheses++; const duration=text.startsWith('啊？')?3:1, pcm = Buffer.alloc(48000*duration); for (let i = 0; i < 24000*duration; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 24000 * 440 * Math.PI * 2) * 1500), i * 2); return { pcm, sampleRate: 24000, duration, subtitles: [] } },
  async recognize(_c, _k, chunks, onText, signal) { for await (const b of chunks) { signal.throwIfAborted(); asrBytes += b.length; onText('测试录音', false) } onText('测试录音完成。', true); return '测试录音完成。' },
}
const conversation = createConversationHost(join(temp, 'conversation'), {}, live ? undefined : fixtures)
let config = { ...conversationDefaults, model: 'fixture-model' }, keys = { llm: 'fixture-private-llm', tts: 'fixture-private-tts', asr: 'fixture-private-asr' }
if (live) {
  const text = await readFile(process.env.PET_LIVE_CREDENTIAL_FILE, 'utf8')
  keys.llm = text.match(/火山方舟大模型调用key\s*[:：]\s*([^\s`]+)/i)?.[1]
  keys.tts = keys.asr = text.match(/api key\s*[:：]\s*([^\s`]+)/i)?.[1]
  config.model = text.match(/"model"\s*:\s*"([^"]+)"/)?.[1]
  if (!keys.llm || !keys.tts || !config.model) throw new Error('缺少私有测试配置')
}
conversation.store.save({ config, keys })
let route, dispose
apply({ webServer: { register(r) { route = r; return () => {} } }, effect(fn) { dispose = fn() } })
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname.startsWith('/desktop-pet/api/conversation')) { await conversation.handle(req, res, url); return }
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<body><h1>Desktop pet</h1><script>window.__ModuleLoader__={load({factory}){factory(()=>{}).apply({effect(fn){window.disposePlugin=fn()}})}};</script><script src="/client.js"></script>'); return }
  if (req.url === '/client.js') { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(resolve('dist/client.js'))); return }
  await route.handler(req, res)
})
server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 800 }, permissions: ['microphone'], recordVideo: { dir: join(output, live ? 'live-video' : 'fixture-video') } })
  await context.route('**/desktop-pet/dragonbones.js', async route => {
    const response = await route.fetch()
    const source = (await response.text()).replace('export {\n  createDragonBonesRenderer\n}', 'async function inspectableRenderer(...args) { const renderer = await createDragonBonesRenderer(...args); window.focusTestRenderer = renderer; return renderer }\nexport {\n  inspectableRenderer as createDragonBonesRenderer\n}')
    await route.fulfill({ response, body: source })
  })
  await context.addInitScript(() => { window.audioStarts = 0; window.audioContexts = []; const Original = window.AudioContext; window.AudioContext = class extends Original { constructor(...args) { super(...args); audioContexts.push(this) } }; const start = AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start = function(...args) { window.audioStarts++; return start.apply(this,args) } })
  const main = await context.newPage(), errors = []; main.on('pageerror', e => errors.push(e.message))
  await main.goto(base); await main.getByRole('button', { name: '🐾 桌宠', exact: true }).click()
  await main.locator('[data-tab="conversation"]').click(); await main.locator('[data-field="model"]').waitFor()
  await main.locator('[data-tab="prompts"]').click()
  assert.match(await main.locator('[data-field="emotionPrompt"]').inputValue(),/\{\{聊天记录\}\}/)
  assert.equal(await main.locator('[data-field="emotionHistoryMessages"]').inputValue(),'8')
  await main.locator('[data-field="emotionCharacterName"]').fill('糖糖')
  await main.locator('[data-field="prompt"]').fill('你是我的桌面伙伴。用简短中文回答。{{情绪模拟}}')
  await main.locator('[data-tab="actions"]').click()
  await main.locator('[data-action-character]').selectOption('mengmei')
  await main.locator('textarea[data-action-id="jing"]').fill('惊讶\n难以置信')
  await main.locator('textarea[data-action-id="diantou"]').fill('点头')
  assert.equal(await main.locator('textarea[data-action-id="a"]').count(),0)
  await main.locator('[data-tab="prompts"]').click()
  assert.equal(await main.locator('[data-field="prompt"]').inputValue(),'你是我的桌面伙伴。用简短中文回答。{{情绪模拟}}','Unsaved draft survives tab switches')
  await main.getByRole('button', { name: '保存', exact: true }).click(); await main.getByText('设置已保存。', { exact: true }).waitFor()
  assert.equal(await main.locator('[data-key="llm"]').inputValue(), '')
  assert.equal(conversation.store.config.prompt, '你是我的桌面伙伴。用简短中文回答。{{情绪模拟}}')
  assert.deepEqual(conversation.store.config.actionPresets.mengmei.find(p=>p.actionId==='jing').keywords,['惊讶','难以置信'])
  if (!live) {
    await main.locator('[data-tab="intimacy"]').click()
    await main.getByText('当前对话：0 分 · 1级 · 初识',{exact:true}).waitFor()
    await main.locator('[data-level-name]').first().fill('1级 · 初次相识')
    await main.locator('[data-level-description]').first().fill('你们还比较陌生，内心谨慎。')
    await main.getByRole('button',{name:'添加等级',exact:true}).click()
    await main.locator('[data-min]').last().fill('100')
    await main.locator('[data-max]').nth(4).fill('99')
    await main.locator('[data-level-description]').last().fill('你们非常信任彼此，感到安心。')
    await main.getByRole('button',{name:'保存',exact:true}).click();await main.getByText('设置已保存。',{exact:true}).waitFor()
    assert.equal(conversation.store.config.intimacyLevels.length,6)
    assert.equal(conversation.store.config.intimacyLevels[4].max,99)
    assert.equal(await main.locator('[data-max]').nth(4).inputValue(),'99')
    await main.locator('[data-tab="prompts"]').click()
    assert.match(await main.locator('[data-field="emotionPrompt"]').inputValue(),/\{\{亲密情况\}\}/)
  }
  await main.screenshot({ path: join(output, 'conversation-settings.png') })
  const chat = await context.newPage(); chat.on('pageerror', e => errors.push(e.message)); await chat.goto(base + '/desktop-pet/chat')
  await chat.locator('#input').fill('你好')
  await chat.locator('#input').evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
  assert.equal(conversation.store.session.messages.length, 0)
  await chat.locator('#input').press('Shift+Enter'); assert.ok((await chat.locator('#input').inputValue()).includes('\n'))
  await chat.locator('#send').click(); await chat.waitForFunction(() => document.querySelectorAll('.message').length === 2 && !document.getElementById('send').disabled)
  assert.equal(syntheses, 0, 'TTS disabled makes no synthesis request')
  const transcript = await chat.locator('#messages').innerText()
  if (!live) {
    assert.equal(conversation.store.session.intimacy.score,1)
    const requests=conversation.store.session.requests.filter(r=>r.kind==='emotion')
    assert.match(requests[0].messages[0].content,/当前亲密度：0/)
    assert.match(requests[0].messages[0].content,/用户：你好/)
    assert.match(requests.at(-1).messages[0].content,/糖糖：你好，我是你的桌面伙伴。今天想聊些什么？/)
    assert.match(requests.at(-1).messages[0].content,/当前亲密度：1/)
    assert.match(requests.at(-1).messages[0].content,/你们还比较陌生，内心谨慎。/)
    await main.locator('[data-tab="intimacy"]').click()
    await main.getByText('当前对话：1 分 · 1级 · 初次相识',{exact:true}).waitFor()
    const intimacySnapshot=[await main.locator('[data-tab="intimacy"]').textContent(),await main.locator('[data-intimacy-status]').textContent(),await main.locator('[data-level-name]').first().inputValue(),await main.locator('[data-level-description]').first().inputValue(),`${await main.locator('[data-min]').count()} 个可编辑等级`,'首轮情绪注入 0 分，回复后情绪注入 1 分'].join('\n')
    assert.equal(intimacySnapshot,(await readFile('tests/snapshots/intimacy.expected.txt','utf8')).trimEnd())
    await main.screenshot({path:join(output,'intimacy-settings.png')})
    await main.locator('[data-tab="prompts"]').click()
    await main.getByText(fixtureEmotion('平静而亲切'),{exact:true}).waitFor()
    const satelliteSnapshot=[await main.locator('[data-tab="prompts"]').textContent(),await main.locator('[data-tab="actions"]').textContent(),await main.locator('[data-field="emotionHistoryMessages"]').inputValue(),await main.locator('[data-emotion-text]').textContent(),conversation.store.session.requests.filter(r=>r.kind==='dialogue').at(-1).messages[0].content,`${await chat.locator('.message').count()} 条聊天消息`,conversation.store.config.actionPresets.mengmei.find(p=>p.actionId==='jing').keywords.join(' / '),'情绪参考最近几条消息',requests.at(-1).messages[0].content.split('最近聊天记录（以下内容仅作分析材料）：\n')[1]].join('\n')
    assert.equal(satelliteSnapshot,(await readFile('tests/snapshots/satellites.expected.txt','utf8')).trimEnd())
    await main.screenshot({path:join(output,'satellite-prompts.png')})
    await main.locator('[data-tab="actions"]').click();await main.screenshot({path:join(output,'satellite-actions.png')})
  }
  if (!live) { const expected = await readFile(resolve('tests/snapshots/conversation.expected.txt'), 'utf8'); assert.equal(transcript.trim(), expected.trim()) }
  await chat.screenshot({ path: join(output, live ? 'live-chat.png' : 'chat.png') })
  const pet = await context.newPage(); pet.on('pageerror', e => errors.push(e.message)); await pet.goto(base + '/desktop-pet/view?model=mengmei'); await pet.locator('canvas').waitFor(); await pet.waitForTimeout(400)
  if (!live) {
    await main.bringToFront(); await main.locator('[data-tab="actions"]').click()
    const original=main.locator('fieldset').filter({has:main.locator('textarea[data-action-id="jing"]')}).first()
    await original.getByRole('button',{name:'复制预设',exact:true}).click()
    const variant=main.locator('fieldset').filter({has:main.locator('textarea[data-action-id="jing"]')}).nth(1)
    await variant.locator('[data-preset-name]').fill('轻轻惊讶')
    await variant.locator('textarea').fill('轻轻惊讶')
    await variant.locator('[data-weight-number]').fill('35')
    await pet.waitForFunction(()=>focusTestRenderer.inspect().debug?.weight===.35)
    const actionPortrait=main.frameLocator('iframe[title="动作立绘预览"]')
    await actionPortrait.locator('canvas').waitFor()
    await actionPortrait.locator('#stage[data-state="debug"]').waitFor()
    const before=await pet.evaluate(()=>focusTestRenderer.inspect().debug.time)
    await main.waitForTimeout(300);await variant.locator('[data-weight-number]').fill('65')
    await pet.waitForFunction(()=>focusTestRenderer.inspect().debug?.weight===.65)
    assert.ok(await pet.evaluate(()=>focusTestRenderer.inspect().debug.time)>=before,'Updating preview weight does not restart the motion')
    await variant.locator('[data-preset-name]').focus();await pet.waitForFunction(()=>!focusTestRenderer.inspect().debug)
    const eRecipe=main.locator('[data-phoneme="e"]');await eRecipe.locator('[data-weight-number]').fill('42')
    await pet.waitForFunction(()=>focusTestRenderer.inspect().debug?.name==='__speech_i'&&focusTestRenderer.inspect().debug.weight===.42)
    await main.screenshot({path:join(output,'weighted-mouth-settings.png')});await pet.screenshot({path:join(output,'weighted-mouth-preview.png')})
    await main.getByRole('button',{name:'保存',exact:true}).click();await main.getByText('设置已保存。',{exact:true}).waitFor()
    assert.equal(conversation.store.config.actionPresets.mengmei.find(p=>p.name==='轻轻惊讶').weight,.65)
    assert.equal(conversation.store.config.mouthRecipes.mengmei.find(r=>r.phoneme==='e').weight,.42)
    await main.locator('[data-tab="voice"]').click();await pet.waitForFunction(()=>!focusTestRenderer.inspect().debug)
    assert.equal(await main.locator('iframe[title="动作立绘预览"]').getAttribute('src'),'about:blank','Leaving actions destroys the preview renderer')
    await main.locator('[data-tab="actions"]').click()
    assert.equal(await main.locator('[data-phoneme="e"] [data-weight-number]').inputValue(),'42')
    const savedVariant=conversation.store.config.actionPresets.mengmei.find(p=>p.name==='轻轻惊讶'),savedRecipe=conversation.store.config.mouthRecipes.mengmei.find(r=>r.phoneme==='e')
    const snapshot=[`${savedVariant.name} | ${savedVariant.actionId} | ${Math.round(savedVariant.weight*100)}% | ${savedVariant.keywords.join(' / ')}`,`${savedRecipe.phoneme} | ${savedRecipe.base} | ${Math.round(savedRecipe.weight*100)}%`, '滑块更新不重启动作；失焦恢复；保存重开保持'].join('\n')
    assert.equal(snapshot,(await readFile('tests/snapshots/action-presets.expected.txt','utf8')).trimEnd())
  }
  await main.locator('[data-tab="voice"]').click(); await main.locator('[data-field="ttsEnabled"]').check(); await main.getByRole('button', { name: '保存', exact: true }).click(); await main.getByText('设置已保存。', { exact: true }).waitFor()
  await main.screenshot({ path: join(output, 'voice-settings.png') })
  await chat.locator('#input').fill('请说一句简短的问候。'); await chat.locator('#send').click(); await chat.waitForFunction(() => document.querySelectorAll('.message').length === 4 && !document.getElementById('send').disabled)
  await pet.waitForFunction(() => window.audioStarts > 0); assert.equal(await pet.locator('#message').textContent(), '')
  await pet.screenshot({ path: join(output, live ? 'live-speaking.png' : 'speaking.png') })
  await pet.evaluate(async () => { await fetch('/desktop-pet/api/conversation/pause',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({paused:true})}) })
  await pet.waitForFunction(()=>audioContexts.some(c=>c.state==='suspended'))
  const pauseTime=await pet.evaluate(()=>audioContexts.find(c=>c.state==='suspended').currentTime)
  await pet.waitForTimeout(5200);assert.ok((await pet.locator('#bubble').textContent()).length > 0, 'Reply stays while audio is paused beyond old timeout');assert.equal(await pet.evaluate(()=>audioContexts.find(c=>c.state==='suspended').currentTime),pauseTime)
  await pet.evaluate(async () => { await fetch('/desktop-pet/api/conversation/pause',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({paused:false})}) })
  if (!live) { await pet.waitForFunction(() => document.getElementById('bubble').textContent === '', {timeout:15000}); assert.ok(conversation.store.session.messages.at(-1).content.length > 0) }
  if(live){
    await pet.waitForTimeout(4000)
    const text=await readFile(process.env.PET_LIVE_CREDENTIAL_FILE,'utf8'), speaker=text.match(/S_[A-Za-z0-9]+/)?.[0]
    conversation.store.save({config:{...conversation.store.config,voiceKind:'clone',speaker,voiceName:'克隆音色'}})
    const before=await pet.evaluate(()=>audioStarts)
    await pet.evaluate(async()=>{const r=await fetch('/desktop-pet/api/conversation/sample',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(!r.ok)throw Error('Clone synthesis failed')})
    await pet.waitForFunction(n=>audioStarts>n,before);await pet.waitForTimeout(400)
    await pet.screenshot({path:join(output,'live-clone-speaking.png')});await pet.waitForTimeout(5000)
  }
  if (!live) {
    await chat.locator('#record').click(); await chat.getByRole('button', { name: '结束录音' }).waitFor(); await chat.waitForTimeout(1000); await chat.locator('#record').click(); await chat.getByText('识别完成，可修改后发送。', { exact: true }).waitFor()
    assert.equal(await chat.locator('#input').inputValue(), '测试录音完成。'); assert.ok(asrBytes >= 16000); assert.equal(conversation.store.session.messages.length, 4)
    await chat.screenshot({ path: join(output, 'recording-draft.png') })
  }
  await main.locator('[data-field="ttsEnabled"]').uncheck(); await main.getByRole('button', { name: '保存', exact: true }).click(); await main.getByText('设置已保存。', { exact: true }).waitFor()
  if (!live) {
    await main.locator('[data-tab="history"]').click()
    const embedded = main.frameLocator('iframe[title="聊天记录与高级对话"]')
    await embedded.locator('#messages .message').nth(3).waitFor()
    const bodyPoint = await pet.evaluate(() => {
      const canvas = document.querySelector('canvas'), gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl'), pixel = new Uint8Array(4)
      for (let y = Math.floor(canvas.height * .55); y < canvas.height * .8; y += 4) {
        const x = Math.floor(canvas.width / 2)
        gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        if (pixel[3] > 24) return {x:x / canvas.width * canvas.clientWidth,y:y / canvas.height * canvas.clientHeight}
      }
      throw Error('No visible body pixel')
    })
    await pet.mouse.click(bodyPoint.x, bodyPoint.y)
    assert.equal(await pet.locator('#menu').isVisible(), false, 'Left body interaction must not open the menu')
    assert.equal(await pet.locator('#stage').getAttribute('data-action'), 'click')
    await pet.locator('#stage').dispatchEvent('contextmenu', { clientX: 200, clientY: 200 })
    await pet.locator('[data-action="chat"]').click(); await pet.locator('#pet-input').fill('记住我们刚才的对话，继续聊。')
    const gazeMagnitude = () => pet.evaluate(() => {
      const renderer = window.focusTestRenderer, now = performance.now()
      for (let i = 0; i < 150; i++) renderer.update(now + i * 16, { x: 2000, y: 200 })
      const gaze = renderer.inspect().gaze
      return Math.hypot(gaze.x, gaze.y)
    })
    assert.ok(await gazeMagnitude() < .1, 'Focused compact input recenters gaze')
    await pet.evaluate(() => window.focusTestRenderer.setSpeaking(true))
    await pet.locator('#pet-input').evaluate(input => input.blur())
    assert.ok(await gazeMagnitude() < .1, 'Input blur cannot resume gaze during speech')
    await pet.locator('#pet-input').focus()
    await pet.evaluate(() => window.focusTestRenderer.setSpeaking(false))
    assert.ok(await gazeMagnitude() < .1, 'Speech ending cannot resume gaze during typing')
    await pet.locator('#pet-input').evaluate(input => input.blur())
    assert.ok(await gazeMagnitude() > 100, 'Gaze resumes after both focus and speech end')
    await pet.locator('#pet-input').focus()
    await pet.waitForTimeout(100)
    assert.ok(await pet.locator('#pet-chat').evaluate(form => form.style.top !== '' && form.getBoundingClientRect().top < document.querySelector('#stage').clientHeight), 'Input follows artwork rather than the empty canvas bottom')
    await pet.locator('#pet-input').evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',isComposing:true,bubbles:true})))
    assert.equal(conversation.store.session.messages.length, 4)
    await pet.locator('#pet-chat button').click()
    await embedded.locator('#messages .message').nth(5).waitFor()
    await pet.waitForFunction(() => !document.querySelector('#pet-chat button').disabled)
    assert.equal(conversation.store.session.requests.filter(r=>r.kind==='dialogue').at(-1).messages.length, 6, 'Compact input retains two previous turns and Prompt')
    assert.equal(await pet.locator('#bubble').textContent(), '你好，我是你的桌面伙伴。今天想聊些什么？')
    const compactSnapshot = [await main.locator('[data-tab="history"]').textContent(), await pet.locator('[data-action="chat"]').textContent(), await pet.locator('#bubble').textContent(), `${await embedded.locator('#messages .message').count()} 条共享消息`, `${conversation.store.session.requests.filter(r=>r.kind==='dialogue').at(-1).messages.length} 条模型上下文消息`].join('\n')
    assert.equal(compactSnapshot, (await readFile('tests/snapshots/compact-chat.expected.txt', 'utf8')).trimEnd())
    await pet.screenshot({path:join(output,'compact-chat.png')})
    await main.screenshot({path:join(output,'embedded-history.png')})
    await pet.waitForTimeout(6200); assert.equal(await pet.locator('#bubble').textContent(), '')
    await pet.locator('#stage').dispatchEvent('contextmenu', {clientX:200,clientY:200}); await pet.getByRole('button',{name:'关闭聊天',exact:true}).click()
    assert.equal(await pet.locator('#pet-chat').isVisible(), false)
    assert.ok(await gazeMagnitude() > 100, 'Closing compact chat releases input gaze suppression')
    assert.equal(conversation.store.session.messages.length, 6)
    await main.locator('[data-tab="partner"]').click()
    assert.equal(await main.locator('iframe[title="聊天记录与高级对话"]').getAttribute('src'), 'about:blank')
    await main.locator('[data-tab="voice"]').click()
    await main.locator('[data-field="speaker"]').fill(' S_fixture_previous ')
    await main.getByRole('button',{name:'保存',exact:true}).click()
    await main.getByText('设置已保存。',{exact:true}).waitFor()
    assert.equal(conversation.store.config.voiceKind,'clone');assert.equal(conversation.store.config.speaker,'S_fixture_previous')
    await main.locator('[data-field="speaker"]').fill('S_fixture_changed')
    await main.locator('[data-field="ttsEnabled"]').check()
    await main.getByRole('button',{name:'保存',exact:true}).click();await main.getByText('设置已保存。',{exact:true}).waitFor()
    fixtureReply=['啊？（惊','讶！(轻声)）这样吗？'];const beforeRequests=spokenRequests.length
    await pet.evaluate(()=>{window.conversationActionSeen=false;new MutationObserver(()=>{if(['automatic','speaking'].includes(document.getElementById('stage').dataset.state))window.conversationActionSeen=true}).observe(document.getElementById('stage'),{attributes:true,attributeFilter:['data-state']})})
    await chat.locator('#input').fill('请表达惊讶。');await chat.locator('#send').click();await chat.waitForFunction(()=>document.querySelectorAll('.message').length===8&&!document.getElementById('send').disabled)
    const aside=pet.locator('#bubble .bubble-aside');await aside.waitFor()
    assert.equal(await aside.textContent(),'（惊讶！(轻声)）')
    assert.equal(await aside.evaluate(el=>getComputedStyle(el).color),'rgb(148, 139, 129)')
    assert.equal(await pet.locator('#bubble').evaluate(el=>getComputedStyle(el).color),'rgb(83, 70, 54)')
    await pet.screenshot({path:join(output,'bubble-aside-speaking.png')})
    await pet.waitForFunction(()=>document.getElementById('stage').dataset.state==='speaking')
    await pet.waitForTimeout(1600)
    assert.equal(await pet.locator('#stage').getAttribute('data-state'),'speaking','Audio holds the pose beyond the old 1.2 second expiry')
    await pet.waitForFunction(()=>document.getElementById('bubble').textContent==='')
    await pet.waitForFunction(()=>document.getElementById('stage').dataset.state==='idle')
    assert.deepEqual(spokenRequests.slice(beforeRequests),[{text:'啊？这样吗？',speaker:'S_fixture_changed',voiceKind:'clone'}])
    assert.equal(conversation.store.session.messages.at(-1).content,'啊？（惊讶！(轻声)）这样吗？')
    const voiceSnapshot=[conversation.store.session.messages.at(-1).content,...spokenRequests.slice(beforeRequests).map(r=>`${r.text} | ${r.speaker} | ${r.voiceKind}`)].join('\n')
    assert.equal(voiceSnapshot,(await readFile('tests/snapshots/speech-projection.expected.txt','utf8')).trimEnd())
    assert.equal(await pet.evaluate(()=>conversationActionSeen),true,'Matched body action plays with synthesized audio')
    fixtureReply=['（红着耳朵抬起头，睫毛忽闪）我、我还好！就是有点突然…','…（抿嘴','笑）你不生气啦？']
    const ellipsisBefore=spokenRequests.length,startsBefore=await pet.evaluate(()=>audioStarts)
    await chat.locator('#input').fill('测试省略号后的尾句');await chat.locator('#send').click()
    await chat.waitForFunction(()=>document.querySelectorAll('.message').length===10&&!document.getElementById('send').disabled)
    await pet.waitForFunction(()=>document.getElementById('bubble').textContent==='')
    const ellipsisParts=spokenRequests.slice(ellipsisBefore).map(r=>r.text)
    assert.deepEqual(ellipsisParts,['我、我还好！','就是有点突然……','你不生气啦？'])
    assert.equal(await pet.evaluate(()=>audioStarts)-startsBefore,3,'All three segments including the suffix reached Web Audio')
    assert.equal(ellipsisParts.join('\n'),(await readFile('tests/snapshots/ellipsis-speech.expected.txt','utf8')).trimEnd())
    fixtureReply=['（轻轻惊讶）鹅，我也！']
    await pet.evaluate(()=>{window.recipeSamples=[];const tick=()=>{const s=focusTestRenderer.inspect();recipeSamples.push({mouth:s.mouthWeights,reactions:s.reactionStates});window.recipeFrame=requestAnimationFrame(tick)};tick()})
    await chat.locator('#input').fill('测试扩展嘴型');await chat.locator('#send').click()
    await pet.waitForFunction(()=>recipeSamples.some(s=>s.reactions.some(r=>r.weight===.65)))
    await pet.waitForFunction(()=>document.getElementById('bubble').textContent==='')
    const recipeSamples=await pet.evaluate(()=>{cancelAnimationFrame(recipeFrame);return recipeSamples})
    assert.ok(recipeSamples.some(s=>s.mouth.some(m=>m.shape==='i'&&Math.abs(m.weight-.42)<.025)),'Saved e recipe reaches the actual audio-driven renderer')
    await writeFile(join(output,'weighted-speech-result.json'),JSON.stringify(recipeSamples))
    await main.locator('[data-field="ttsEnabled"]').uncheck()
    fixtureReply=['（点','头）嗯，我明白了。']
    await pet.evaluate(()=>{window.conversationActionSeen=false})
    await chat.locator('#input').fill('请点头。');await chat.locator('#send').click()
    await pet.waitForFunction(()=>window.conversationActionSeen)
    await pet.screenshot({path:join(output,'satellite-action-playing.png')})
    await pet.locator('#stage').dispatchEvent('contextmenu',{clientX:200,clientY:200})
    await pet.waitForFunction(()=>document.getElementById('stage').dataset.state!=='automatic')
  }
  const playbackStarts=await pet.evaluate(()=>audioStarts);assert.ok(playbackStarts>0)
  await context.close(); assert.deepEqual(errors, [])
  await writeFile(join(output, live ? 'live-browser-result.json' : 'browser-result.json'), JSON.stringify({ live, transcript, syntheses, asrBytes, playbackStarts, pauseTime, errors }, null, 2))
  console.log(`Conversation browser passed (${live ? 'live provider' : 'keyless fixture'}): settings, typing/IME, text, speech, ${live ? 'recording not exercised' : 'recording draft'}.`)
} finally { await browser.close(); await conversation.dispose(); await dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(temp, { recursive: true, force: true }) }
