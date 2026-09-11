// Isolated packaged-Dev UI fixture; no model calls or personal userData.
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'

const app = process.env.DSH_DEV_AUDIT_APP
const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms))

it.skipIf(app === undefined)('packaged Dev reviews legacy partial coverage without warning UI', async () => {
  const appPath = resolve(app!)
  if (!appPath.endsWith('/DeepSeek Harness Dev.app')) throw new Error('Only Dev is allowed')
  const userData = await mkdtemp(join(tmpdir(), 'dsh-dev-partial-audit-'))
  const cwd = join(userData, 'workspace')
  await mkdir(cwd)
  await writeFile(join(cwd, 'review.txt'), 'after\n')
  const id = SessionId('dev-partial-audit')
  const fixture = createChatScrollFixture({ markerPrefix: 'AUDIT', title: 'Partial audit fixture', turns: 1 })
  const text = fixture.log.replaceAll('{{sessionId}}', id).replaceAll('{{cwd}}', cwd)
  const seeder = new Context()
  try {
    await seeder.plugin(SessionStore)
    await seeder.plugin(JsonlSessionPersistence, { root: join(userData, 'harness', 'sessions') })
    await seeder.sessionPersistence.create(JSON.parse(text.split('\n')[0]!) as SessionHeader)
    await seeder.sessionPersistence.append(id, parseSessionLog(text))
  } finally { await seeder.fiber.dispose() }
  const ledger = join(userData, 'harness', 'dsh-file-edit-state')
  await mkdir(ledger, { recursive: true })
  await writeFile(join(ledger, id + '.json'), JSON.stringify({
    version: 7, root: cwd, baseReady: false, files: {
      'review.txt': {
        base: { present: true, content: 'before\n', eol: true, crlf: false, size: 7, version: 'fixture-before' },
        cur: { present: true, content: 'after\n', eol: true, crlf: false, size: 6, version: 'fixture-after' },
        rev: 1, decisions: {},
      },
    }, auditCoverage: { kind: 'partial' },
  }))
  const child = spawn(join(appPath, 'Contents', 'MacOS', 'DeepSeek Harness Dev'), [
    '--user-data-dir=' + userData, '--remote-debugging-port=0',
  ], { stdio: 'ignore' })
  let browser: Browser | undefined
  try {
    let port = ''
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Dev exited before ready')
      try { port = (await readFile(join(userData, 'DevToolsActivePort'), 'utf8')).split('\n')[0]! } catch { /* Waiting for this test's Dev. */ }
      if (port) break
      await delay(2000)
    }
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
    const page = browser.contexts()[0]!.pages()[0]!
    await page.waitForURL(/http:\/\/127\.0\.0\.1:/, { timeout: 300_000 })
    // The packaged first-run surface presents the internal-testing notice.
    await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 60_000 })
    const configureLater = page.getByRole('button', { name: /^(稍后配置|Configure later)$/ })
    const search = page.getByRole('button', { name: /^(搜索会话|Search sessions)$/ })
    await configureLater.click({ timeout: 60_000 })
    await search.click()
    await page.getByRole('textbox', { name: /^(搜索会话…|Search sessions\.\.\.)$/ }).fill('workspace')
    const row = page.getByRole('tree', { name: /搜索结果|Search results/ }).getByRole('treeitem')
    await expect.poll(() => row.count(), { timeout: 60_000 }).toBe(1)
    await row.click()
    const bar = page.locator('.dsh-fe-bar').first()
    await bar.waitFor({ timeout: 60_000 })
    expect(await page.locator('[data-audit-coverage]').count()).toBe(0)
    expect(await bar.textContent()).not.toContain('审核不完整')
    expect(await bar.textContent()).not.toContain('部分修改无法恢复')
    await page.getByRole('button', { name: '收起修改文件列表（折叠为一行）', exact: true }).click()
    await expect.poll(() => bar.locator('.dsh-fe-body').evaluate(el => el.getBoundingClientRect().height)).toBe(0)
    await page.getByRole('button', { name: '展开修改文件列表', exact: true }).click()
    expect(await page.getByText('审核不完整', { exact: true }).count()).toBe(0)
    await page.screenshot({ path: join(tmpdir(), 'harness-dev-partial-audit.png') })
    await page.reload()
    await bar.waitFor({ timeout: 60_000 })
    expect(await bar.textContent()).not.toContain('审核不完整')
    expect(await bar.textContent()).not.toContain('部分修改无法恢复')
    await page.getByRole('button', { name: '全部接受', exact: true }).click()
    await expect.poll(() => page.locator('.dsh-fe-bar').count(), { timeout: 10_000 }).toBe(0)
    await page.reload()
    await page.locator('textarea[data-phase]').waitFor({ timeout: 60_000 })
    expect(await page.locator('.dsh-fe-bar').count()).toBe(0)
  } catch (error) {
    const page = browser?.contexts()[0]?.pages()[0]
    await page?.screenshot({ path: join(tmpdir(), 'harness-dev-partial-audit-failure.png') })
    console.log((await page?.locator('body').innerText())?.slice(0, 5000))
    throw error
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await delay(250)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await delay(250)
    if (child.exitCode === null && child.signalCode === null) throw new Error('Dev did not exit; retaining temporary data')
    await rm(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}, 420_000)
