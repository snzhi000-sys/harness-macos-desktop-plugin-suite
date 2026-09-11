/** Native chat + actual ASR through Chromium capture/resampling. Uses a known virtual microphone, never ambient speech. */
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { conversationStore } from '../src/conversation-store.mjs'
import { writeSettings } from '../src/settings.mjs'
if (!process.env.PET_LIVE_CREDENTIAL_FILE) throw new Error('Explicit PET_LIVE_CREDENTIAL_FILE required')
const temp = await mkdtemp(join(tmpdir(), 'pet-native-chat-')), output = resolve('../../desktop/.artifacts/pet-conversation-development')
await mkdir(output,{recursive:true})
const source = await readFile(process.env.PET_LIVE_CREDENTIAL_FILE, 'utf8'), store = conversationStore(join(temp, 'harness/state/dsh-desktop-pet'))
const llm=source.match(/火山方舟大模型调用key\s*[:：]\s*([^\s`]+)/i)?.[1], speech=source.match(/api key\s*[:：]\s*([^\s`]+)/i)?.[1], model=source.match(/"model"\s*:\s*"([^"]+)"/)?.[1]
if(!llm||!speech||!model)throw Error('Private test configuration incomplete')
store.save({config:{...store.config,model,ttsEnabled:true},keys:{llm,tts:speech,asr:speech}})
writeSettings(join(temp,'harness/state/dsh-desktop-pet/settings.json'),{modelId:'mengmei'})
let app
try{
 app=await electron.launch({executablePath:resolve('../../desktop/.artifacts/electron-pet-smoke/Electron.app/Contents/MacOS/Electron'),args:[resolve('tests/electron-fixture.mjs'),`--user-data-dir=${temp}`,'--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${join(output,'capture-48k.wav')}`],env:{...process.env,DSH_HOME:join(temp,'harness')}})
 app.context().setDefaultTimeout(25000)
 const main=await app.firstWindow();await main.getByRole('button',{name:'🐾 桌宠',exact:true}).click()
 console.log('Capture flags',await app.evaluate(({app})=>({fake:app.commandLine.hasSwitch('use-fake-device-for-media-stream'),file:app.commandLine.hasSwitch('use-file-for-fake-audio-capture')})))
 await main.getByRole('button',{name:'显示',exact:true}).click()
 await main.locator('[data-tab="history"]').click()
 await main.frameLocator('iframe[title="聊天记录与高级对话"]').locator('#input').waitFor()
 const chat=main.frames().find(frame=>frame.url().endsWith('/desktop-pet/chat'))
 const pet=app.windows().find(page=>page.url().endsWith('/desktop-pet/view')); await pet.locator('canvas').waitFor()
 const before=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Harness 桌宠').getBounds())
 await pet.locator('#stage').dispatchEvent('contextmenu',{clientX:180,clientY:180}); await pet.locator('[data-action="chat"]').click()
 await pet.locator('#pet-input').fill('你好，请用一句话回复。'); await pet.locator('#pet-chat button').click()
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),2)
 const after=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Harness 桌宠').getBounds())
 assert.equal(after.height,before.height+72)
 await pet.waitForFunction(()=>document.getElementById('bubble').textContent.length>4)
 await pet.screenshot({path:join(output,'native-compact.png')})
 await pet.locator('#stage').dispatchEvent('contextmenu',{clientX:180,clientY:180});await pet.getByRole('button',{name:'关闭聊天',exact:true}).click()
 assert.equal(await pet.locator('#pet-chat').isVisible(),false)
 await chat.waitForFunction(()=>document.querySelectorAll('.message').length===2&&!document.getElementById('send').disabled)
 await main.screenshot({path:join(output,'native-chat.png')})
 // Electron's file-backed fake microphone returns silence on this host; inject a known Web Audio stream.
 // The real permission request still runs, and the product capture/worklet/upload path is unchanged.
 await chat.evaluate(bytes=>{
   const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
   navigator.mediaDevices.getUserMedia=async constraints=>{
     const permissionStream=await get(constraints);permissionStream.getTracks().forEach(t=>t.stop())
     const context=new AudioContext({sampleRate:48000}), destination=context.createMediaStreamDestination(), source=context.createBufferSource()
     source.buffer=await context.decodeAudioData(Uint8Array.from(bytes).buffer);source.connect(destination);await context.resume();source.start(context.currentTime+1)
     for(const track of destination.stream.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{stop();void context.close()}}
     return destination.stream
   }
 },[...await readFile(join(output,'default.wav'))])
 await chat.evaluate(()=>{const original=window.fetch;window.captureEvidence={bytes:0,peak:0,chunks:0};window.fetch=async(...args)=>{if(String(args[0]).endsWith('/record/chunk')){const bytes=Uint8Array.from(atob(JSON.parse(args[1].body).pcm),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer);captureEvidence.bytes+=bytes.length;captureEvidence.chunks++;for(let i=0;i<bytes.length;i+=2)captureEvidence.peak=Math.max(captureEvidence.peak,Math.abs(view.getInt16(i,true)))}return original(...args)}})
 await chat.locator('#record').click();await chat.getByRole('button',{name:'结束录音'}).waitFor();await chat.waitForTimeout(6500);await chat.locator('#record').click()
 await chat.getByText('识别完成，可修改后发送。',{exact:true}).waitFor();const transcript=await chat.locator('#input').inputValue()
 assert.ok(transcript.includes('桌面伙伴'),transcript)
 await main.screenshot({path:join(output,'native-asr.png')})
 await chat.locator('#input').fill('我刚刚用语音和你打招呼了。');await chat.locator('#send').click();await chat.waitForFunction(()=>document.querySelectorAll('.message').length===4&&!document.getElementById('send').disabled)
 const windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({title:w.getTitle(),url:w.webContents.getURL()})))
 assert.equal(windows.filter(w=>w.title==='伙伴聊天').length,0)
 const capture = await chat.evaluate(()=>window.captureEvidence)
 await main.getByRole('button',{name:'关闭',exact:true}).click();await main.waitForTimeout(400)
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>w.getTitle()==='伙伴聊天').length),0)
 await writeFile(join(output,'native-conversation-result.json'),JSON.stringify({passed:true,transcript,capture,input:'Web Audio virtual microphone with generated test speech; not physical microphone acceptance',windows:windows.map(w=>w.title)},null,2))
 console.log('Native conversation passed: embedded chat, real model, virtual capture through AudioWorklet to real ASR, explicit send and close.')
} catch (error) {
  if (app) for (const page of app.windows()) if (page.url().includes('/desktop-pet/chat')) {
    console.log('Chat failure state', await page.locator('#status').textContent(), await page.locator('#input').inputValue(),await page.evaluate(()=>window.captureEvidence))
    await page.screenshot({ path: join(output, 'native-failure.png') })
  }
  throw error
} finally { await app?.close(); await rm(temp, { recursive: true, force: true }) }
