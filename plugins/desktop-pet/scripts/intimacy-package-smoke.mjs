/** Final Dev package UI with empty userData: editable inclusive ranges, rejected overlap and persistence. */
import { _electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const data=await mkdtemp(join(tmpdir(),'pet-intimacy-package-')),out=resolve('../../desktop/.artifacts/pet-intimacy')
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
  await page.locator('[data-tab="intimacy"]').click()
  await page.locator('[data-max]').first().waitFor()
  await page.waitForFunction(()=>document.querySelector('[data-plugin="desktop-pet"]').shadowRoot.querySelector('[data-max]')?.value==='10')
  await page.locator('[data-max]').first().fill('15');await page.locator('[data-min]').nth(1).fill('16')
  await page.locator('[data-level-name]').first().fill('1级 · 初识测试')
  await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByText('设置已保存。',{exact:true}).waitFor()
  const config=()=>page.evaluate(async()=>{const r=await fetch('/desktop-pet/api/conversation/config');return (await r.json()).config})
  assert.equal((await config()).intimacyLevels[0].max,15)
  await page.locator('[data-max]').first().fill('16')
  await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByText(/区间不能重叠或遗漏/).waitFor()
  assert.equal((await config()).intimacyLevels[0].max,15,'Rejected edits do not overwrite saved settings')
  await page.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'🐾 桌宠',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('[data-plugin="desktop-pet"]').shadowRoot.querySelector('[data-max]')?.value==='15')
  assert.equal(await page.locator('[data-min]').nth(1).inputValue(),'16')
  assert.equal(await page.locator('[data-level-name]').first().inputValue(),'1级 · 初识测试')
  assert.equal(await page.locator('[data-max]').last().inputValue(),'')
  await page.screenshot({path:join(out,'packaged-intimacy.png')})
  await page.locator('[data-tab="prompts"]').click()
  assert.match(await page.locator('[data-field="emotionPrompt"]').inputValue(),/\{\{亲密情况\}\}/)
  assert.match(await page.locator('[data-field="emotionPrompt"]').inputValue(),/\{\{聊天记录\}\}/)
  assert.equal(await page.locator('[data-field="emotionHistoryMessages"]').inputValue(),'8')
  assert.equal(await page.locator('[data-field="emotionCharacterName"]').inputValue(),'糖糖')
  await writeFile(join(out,'packaged-ui.json'),JSON.stringify({emptyUserData:true,explicitMinMax:true,rangeSaved:true,reopened:true,overlapRejected:true,unlimitedLastLevel:true,emotionVariable:true,historyVariable:true,historyMessages:8,characterName:true},null,2)+'\n')
  console.log('Packaged Dev intimacy settings: ranges, rejected overlap, reopen and prompt variable passed.')
} finally {if(app)await app.close();await rm(data,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
