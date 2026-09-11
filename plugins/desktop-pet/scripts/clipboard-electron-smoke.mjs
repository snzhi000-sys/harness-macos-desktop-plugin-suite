/** Actual Electron clipboard writes through the shared UI helper after the pet installs its Session policy. */
import {_electron as electron} from 'playwright'
import {build} from 'esbuild'
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import assert from 'node:assert/strict'
const temp=await mkdtemp(join(tmpdir(),'harness-copy-')),output=resolve('../../desktop/.artifacts/explorer-clipboard')
await mkdir(output,{recursive:true})
const bundle=await build({stdin:{contents:`export {writeClipboard} from '../../packages/client/ui-primitives/src/clipboard.ts';export {relativeTo} from '../better-sidebar/src/client/paths.ts'`,resolveDir:process.cwd()},bundle:true,format:'iife',globalName:'copyFixture',write:false})
let app,saved
try {
 app=await electron.launch({executablePath:resolve('../../desktop/.artifacts/electron-pet-smoke/Electron.app/Contents/MacOS/Electron'),args:[resolve('tests/electron-fixture.mjs'),`--user-data-dir=${temp}`],env:{...process.env,DSH_HOME:join(temp,'harness')}})
 saved=await app.evaluate(({clipboard})=>clipboard.readText())
 const page=await app.firstWindow();await page.getByRole('button',{name:'🐾 桌宠',exact:true}).click()
 await page.getByRole('button',{name:'关闭',exact:true}).click();await page.bringToFront()
 await page.addScriptTag({content:bundle.outputFiles[0].text})
 const cases=[['file-relative','资料/测试 文件.md'],['file-absolute','/workspace/资料/测试 文件.md'],['folder-relative','资料/子目录'],['folder-absolute','/workspace/资料/子目录']]
 const actual=[]
 for(const [name,expected]of cases) {
  await page.evaluate(({name,expected})=>{document.querySelector('#copy-fixture')?.remove();const b=document.createElement('button');b.id='copy-fixture';b.textContent=name;b.onclick=async()=>{const text=name.endsWith('relative')?copyFixture.relativeTo('/workspace','/workspace/'+expected):expected;window.copyResult=await copyFixture.writeClipboard(text);b.dataset.finished='true'};document.body.append(b)}, {name,expected})
  await page.locator('#copy-fixture').click();await page.locator('#copy-fixture[data-finished="true"]').waitFor()
  assert.equal(await page.evaluate(()=>window.copyResult),true,name)
  const text=await app.evaluate(({clipboard})=>clipboard.readText());assert.equal(text,expected,name);actual.push(`${name}: ${text}`)
 }
 const denied=await page.evaluate(async()=>{try{await navigator.clipboard.readText();return false}catch{return true}})
 assert.equal(denied,true,'Write permission does not grant clipboard reads')
 const snapshot=actual.join('\n')+'\n';assert.equal(snapshot,await readFile(resolve('tests/clipboard.expected.txt'),'utf8'));await writeFile(join(output,'clipboard.actual.txt'),snapshot);await page.screenshot({path:join(output,'clipboard.png')});console.log(snapshot)
} finally {if(app){if(saved!==undefined)await app.evaluate(({clipboard},text)=>clipboard.writeText(text),saved);await app.close()}await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
