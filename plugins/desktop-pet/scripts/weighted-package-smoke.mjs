/** Final Dev package UI with empty userData: weighted variants, phoneme recipes and leased preview. */
import { _electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const data=await mkdtemp(join(tmpdir(),'pet-weight-package-')),out=resolve('../../desktop/.artifacts/pet-weighted-actions')
await mkdir(out,{recursive:true});let app
try {
  app=await _electron.launch({executablePath:resolve('../../desktop/dist/dev/mac-arm64/DeepSeek Harness Dev.app/Contents/MacOS/DeepSeek Harness Dev'),args:[`--user-data-dir=${data}`],timeout:300000})
  const page=await app.firstWindow();await page.waitForURL(/http:\/\/127\.0\.0\.1:/,{timeout:300000});page.setDefaultTimeout(20000)
  await page.waitForTimeout(2000)
  for(const name of [/^(Continue|继续)$/,/^(稍后配置|Configure later)$/]) { const button=page.getByRole('button',{name});if(await button.isVisible())await button.click() }
  const workspace=join(data,'验证工作区');await mkdir(workspace)
  const result=await page.evaluate(async path=>{const r=await fetch('/api/workspace.create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'intimacy-workspace',method:'workspace.create',payload:{path}})});return r.json()},workspace)
  assert.equal(result.result.ok,true)
  await page.reload()
  await page.getByRole('button',{name:/^(稍后配置|Configure later)$/}).click()
  await page.getByRole('button',{name:'🐾 桌宠',exact:true}).click()
  await page.locator('[data-tab="actions"]').click()
  const row=page.locator('fieldset').filter({has:page.locator('textarea[data-action-id="xi"]')}).first()
  await row.locator('[data-preset-name]').fill('轻笑体验')
  await row.locator('[data-weight-number]').fill('35')
  await row.locator('textarea').fill('轻笑\n浅浅一笑')
  const mouth=page.locator('[data-phoneme="e"]')
  await mouth.locator('[data-weight-number]').fill('45')
  await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByText('设置已保存。',{exact:true}).waitFor()
  const config=()=>page.evaluate(async()=>{const r=await fetch('/desktop-pet/api/conversation/config');return(await r.json()).config})
  const saved=await config();assert.equal(saved.actionPresets.mengmei.find(p=>p.name==='轻笑体验').weight,.35);assert.equal(saved.mouthRecipes.mengmei.find(r=>r.phoneme==='e').weight,.45)
  await page.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'🐾 桌宠',exact:true}).click()
  await page.locator('[data-tab="actions"]').click()
  await page.waitForFunction(()=>document.querySelector('[data-plugin="desktop-pet"]').shadowRoot.querySelector('[data-phoneme="e"] [data-weight-number]')?.value==='45')
  await page.locator('[data-phoneme="e"] [data-weight-number]').fill('60')
  await page.frameLocator('iframe[title="动作立绘预览"]').locator('#stage[data-state="debug"]').waitFor()
  await page.screenshot({path:join(out,'packaged-actions.png')})
  await page.locator('[data-tab="voice"]').click();assert.equal(await page.locator('iframe[title="动作立绘预览"]').getAttribute('src'),'about:blank')
  await writeFile(join(out,'packaged-ui.json'),JSON.stringify({emptyUserData:true,weightedPresetSaved:true,phonemeRecipeSaved:true,reopened:true,previewPlayed:true,previewReleased:true},null,2))
  console.log('Packaged Dev weighted actions and speech recipes passed')
}finally{if(app)await app.close();await rm(data,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
