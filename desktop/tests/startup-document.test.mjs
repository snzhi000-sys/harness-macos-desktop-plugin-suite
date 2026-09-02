import assert from 'node:assert/strict'
import test from 'node:test'
import { fadeStartupDocument, startupDocument, updateStartupDocument } from '../src/startup-document.mjs'

function decodeDocument(url) {
  return decodeURIComponent(url.slice(url.indexOf(',') + 1))
}

test('renders only three broad theme-aware startup regions instead of detailed UI', () => {
  const html = decodeDocument(startupDocument())
  assert.match(html, /class="panel sessions"/)
  assert.match(html, /class="panel explorer"/)
  assert.match(html, /class="panel chat"/)
  assert.match(html, /正在启动 Harness Web 后端/)
  assert.match(html, /prefers-color-scheme:dark/)
  assert.match(html, /prefers-reduced-motion:reduce/)
  assert.match(html, /animation:shimmer/)
  assert.match(html, /data-leaving/)
  assert.doesNotMatch(html, /class="card"/)
  assert.doesNotMatch(html, /class="message|class="composer|explorer-tree|class="row|class="search|class="bubble/)
})

test('updates the visible startup phase without making startup depend on the document', async () => {
  let script
  await updateStartupDocument({ executeJavaScript: value => { script = value } }, '正在安装/替换插件 Profile')
  assert.match(script, /querySelector\('\.startup-message'\)/)
  assert.match(script, /正在安装\/替换插件 Profile/)
  await assert.doesNotReject(updateStartupDocument({ executeJavaScript: () => { throw new Error('already navigated') } }, '正在启动 Harness Web 后端'))
})

test('fades the startup document without making navigation depend on the cosmetic transition', async () => {
  let script
  await fadeStartupDocument({ executeJavaScript: value => { script = value } })
  assert.match(script, /dataset\.leaving/)
  assert.match(script, /180/)
  await assert.doesNotReject(fadeStartupDocument({ executeJavaScript: () => { throw new Error('already navigated') } }))
})
