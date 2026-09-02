import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const channel = process.argv[2]
const appPath = resolve(process.argv[3] ?? '')
if (channel !== 'dev' && channel !== 'stable') throw new Error('channel must be dev or stable')

const expected = channel === 'dev'
  ? { id: 'ai.deepseek.harness.desktop.dev', name: 'DeepSeek Harness Dev' }
  : { id: 'ai.deepseek.harness.desktop', name: 'DeepSeek Harness' }
const plist = join(appPath, 'Contents', 'Info.plist')
const plistValue = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim()
if (plistValue('CFBundleIdentifier') !== expected.id) throw new Error(`unexpected bundle id in ${appPath}`)
if (plistValue('CFBundleName') !== expected.name) throw new Error(`unexpected bundle name in ${appPath}`)

const appAsar = join(appPath, 'Contents', 'Resources', 'app.asar')
const packagedManifest = JSON.parse(asar.extractFile(appAsar, 'package.json').toString())
if (packagedManifest.dshDesktopChannel !== channel) throw new Error(`packaged channel is not ${channel}`)
const releaseInfo = JSON.parse(asar.extractFile(appAsar, 'release-info.json').toString())
if (releaseInfo.channel !== channel) throw new Error(`release-info channel is not ${channel}`)
if (typeof releaseInfo.version !== 'string' || !/^v\d+\.\d{2}\.\d{2}$/.test(releaseInfo.version)) throw new Error('release-info version is invalid')
if (typeof releaseInfo.builtAt !== 'string' || !Number.isFinite(Date.parse(releaseInfo.builtAt))) throw new Error('release-info build time is missing or invalid')

const profileArchive = join(appPath, 'Contents', 'Resources', 'profile-bootstrap', 'profile.tar.gz')
const runtimeArchive = join(appPath, 'Contents', 'Resources', 'runtime-bootstrap', 'runtime.tar.gz')
const extracted = mkdtempSync(join(tmpdir(), 'dsh-product-app-verify-'))
try {
  execFileSync('/usr/bin/tar', ['-xzf', profileArchive, '-C', extracted, './node_modules/dsh-better-sidebar/lib/client.js'])
  const client = readFileSync(join(extracted, 'node_modules', 'dsh-better-sidebar', 'lib', 'client.js'), 'utf8')
  if (client.includes('openBrowserPanel') || client.includes('打开网页浏览器')) throw new Error('packaged Better Sidebar still contains the removed titlebar browser entry')
  if (!client.includes('openContentPanel') || !client.includes('aboutBuiltAt')) throw new Error('packaged Better Sidebar is missing current titlebar or release-info UI')
  if (!client.includes('关于 App') || !client.includes('zhee')
    || !client.includes('https://github.com/snzhi000-sys/harness-macos-desktop-plugin-suite')) {
    throw new Error('packaged Better Sidebar is missing the fixed About App author information')
  }

  execFileSync('/usr/bin/tar', [
    '-xzf', runtimeArchive, '-C', extracted,
    './node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js',
    './node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
    './node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js',
    './node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
  ])
  const runtimeClient = readFileSync(join(
    extracted, 'node_modules', '@deepseek-ai', 'dsh-client-runtime', 'lib', 'client.js',
  ), 'utf8')
  if (runtimeClient.includes('if (this.openState === "loading" || this.stitching)')) {
    throw new Error('packaged Client Runtime still delays live messages behind the initial history request')
  }
  if (!runtimeClient.includes('if (this.openState === "loading")')
    || !runtimeClient.includes('this.scheduleConversation(this.conversation.append({')) {
    throw new Error('packaged Client Runtime is missing immediate authoritative live-message projection')
  }

  const conversationClient = readFileSync(join(
    extracted, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js',
  ), 'utf8')
  if (!conversationClient.includes('此前运行失败，后续已恢复')) {
    throw new Error('packaged Conversation UI is missing recovered historical failure presentation')
  }

  const deepseekRuntime = readFileSync(join(
    extracted, 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js',
  ), 'utf8')
  if (deepseekRuntime.includes('toolCalls.length > 0 && reasoning.length > 0')
    || !deepseekRuntime.includes('thinkingEnabled ? { reasoning_content: reasoning }')) {
    throw new Error('packaged DeepSeek adapter is missing complete thinking-history passback')
  }

  const piAiRuntime = readFileSync(join(
    extracted, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js',
  ), 'utf8')
  if (!piAiRuntime.includes('alignReplayBlocks') || !piAiRuntime.includes('return foreignAssistant(message)')) {
    throw new Error('packaged pi-ai adapter is missing stale replay-state recovery')
  }
} finally {
  rmSync(extracted, { recursive: true, force: true })
}

execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
console.log(`product app verified: ${expected.name}, ${releaseInfo.version}, ${releaseInfo.builtAt}`)
