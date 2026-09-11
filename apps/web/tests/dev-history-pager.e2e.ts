// Opt-in smoke against an actual packaged Dev Electron app, never everyday userData.
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
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

const app = process.env.DSH_DEV_PAGER_APP
const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms))

it.skipIf(app === undefined)('packaged Dev opens ten-message history and animates reader-owned paging', async () => {
  const appPath = resolve(app!)
  if (!appPath.endsWith('/DeepSeek Harness Dev.app')) throw new Error('Only a Dev app is allowed')
  const userData = await mkdtemp(join(tmpdir(), 'dsh-dev-pager-'))
  const cwd = join(userData, 'workspace')
  await mkdir(cwd)
  const id = SessionId('dev-pager-smoke')
  const fixture = createChatScrollFixture({ markerPrefix: 'DEV_PAGER', title: 'Dev pagination smoke', turns: 32 })
  const text = fixture.log.replaceAll('{{sessionId}}', id).replaceAll('{{cwd}}', cwd)
  const header = JSON.parse(text.split('\n')[0]!) as SessionHeader
  const seeder = new Context()
  try {
    await seeder.plugin(SessionStore)
    await seeder.plugin(JsonlSessionPersistence, { root: join(userData, 'harness', 'sessions') })
    await seeder.sessionPersistence.create(header)
    await seeder.sessionPersistence.append(id, parseSessionLog(text))
  } finally { await seeder.fiber.dispose() }
  const child = spawn(join(appPath, 'Contents', 'MacOS', 'DeepSeek Harness Dev'), [
    `--user-data-dir=${userData}`, '--remote-debugging-port=0',
  ], { stdio: 'ignore' })
  let browser: Browser | undefined
  let release = (): void => {}
  try {
    let port = ''
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Dev exited before ready')
      try { port = (await readFile(join(userData, 'DevToolsActivePort'), 'utf8')).split('\n')[0]! } catch { /* Startup has not created the port file yet. */ }
      if (port) break
      await delay(2_000)
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    await expect.poll(() => browser!.contexts()[0]?.pages().length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0)
    const page = browser.contexts()[0]!.pages()[0]!
    await page.waitForURL(/http:\/\/127\.0\.0\.1:/, { timeout: 300_000 })
    const limits: number[] = []
    let held = false
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    await page.route('**/api/session.history', async (route) => {
      const { payload } = route.request().postDataJSON() as { payload: { maxMessages: number; beforeSeq?: number } }
      limits.push(payload.maxMessages)
      if (payload.beforeSeq !== undefined && !held) { held = true; await gate }
      await route.continue()
    })
    const search = page.getByRole('button', { name: /^(搜索会话|Search sessions)$/ })
    await page.getByRole('button', { name: /^(稍后配置|Configure later)$/ }).click({ timeout: 60_000 })
    await search.click({ timeout: 60_000 })
    // Use local metadata, independent of the asynchronous full-text search index.
    await page.getByRole('textbox', { name: /^(搜索会话…|Search sessions\.\.\.)$/ }).fill('workspace')
    const result = page.getByRole('tree', { name: /搜索结果|Search results/ }).getByRole('treeitem')
    await expect.poll(() => result.count(), { timeout: 60_000 }).toBe(1)
    await result.click()
    const pager = page.locator('[data-history-pager]')
    await pager.waitFor({ timeout: 60_000 })
    await page.getByText(fixture.markers.assistant(fixture.turns), { exact: false }).last().waitFor({ timeout: 60_000 })
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => { done() }))))
    expect(await pager.getAttribute('data-history-pager')).toBe('idle')
    expect(held).toBe(false)
    const scroll = page.locator('[data-conversation-scroll]')
    await scroll.evaluate((el) => { el.scrollTop = 0 })
    await delay(100)
    await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBe(0)
    expect(held).toBe(false)
    const before = await page.locator('[data-chat-flow-key]').count()
    await scroll.hover()
    await page.mouse.wheel(0, -200)
    await expect.poll(() => held).toBe(true)
    await expect.poll(() => pager.getAttribute('data-history-pager')).toBe('loading')
    const status = pager.locator('[data-visible="true"]')
    await expect.poll(() => status.evaluate(el => getComputedStyle(el).opacity)).toBe('1')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await status.locator('span').evaluate(el => getComputedStyle(el).animationName)).toBe('none')
    await page.screenshot({ path: join(tmpdir(), 'harness-dev-history-pager.png') })
    release()
    await expect.poll(() => page.locator('[data-chat-flow-key]').count()).toBeGreaterThan(before)
    await expect.poll(() => pager.getAttribute('data-history-pager')).toBe('idle')
    const count = limits.length
    await delay(500)
    expect(limits.length).toBe(count)
    expect(limits.length).toBeGreaterThan(0)
    expect(limits.every(limit => limit === 10)).toBe(true)
    console.log('Packaged Dev history pager: ten-message requests, idle startup, upward-only trigger, fade, reduced motion and no chained requests verified')
  } catch (error) {
    await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(tmpdir(), 'harness-dev-history-pager-failure.png') })
    throw error
  } finally {
    release()
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await delay(250)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await delay(250)
    }
    if (child.exitCode === null && child.signalCode === null) throw new Error('Dev did not exit; retaining temporary data')
    await rm(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}, 420_000)
