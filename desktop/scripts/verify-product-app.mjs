import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { desktopPetEnabled } from '../product-channel.cjs'

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
if (packagedManifest.dshDesktopPet !== desktopPetEnabled(channel)) throw new Error('Desktop Pet channel selection mismatch')
if (desktopPetEnabled(channel)) {
  asar.extractFile(appAsar, 'src/pet-window.mjs')
  asar.extractFile(appAsar, 'src/pet-preload.cjs')
  if (!plistValue('NSMicrophoneUsageDescription')) throw new Error('Missing microphone usage description')
}
const releaseInfo = JSON.parse(asar.extractFile(appAsar, 'release-info.json').toString())
if (releaseInfo.channel !== channel) throw new Error(`release-info channel is not ${channel}`)
if (typeof releaseInfo.version !== 'string' || !/^v\d+\.\d{2}\.\d{2}$/.test(releaseInfo.version)) throw new Error('release-info version is invalid')
if (typeof releaseInfo.builtAt !== 'string' || !Number.isFinite(Date.parse(releaseInfo.builtAt))) throw new Error('release-info build time is missing or invalid')

const profileArchive = join(appPath, 'Contents', 'Resources', 'profile-bootstrap', 'profile.tar.gz')
const runtimeArchive = join(appPath, 'Contents', 'Resources', 'runtime-bootstrap', 'runtime.tar.gz')
if (desktopPetEnabled(channel)) {
  const profile = JSON.parse(execFileSync('/usr/bin/tar', ['-xOzf', profileArchive, './package.json'], { encoding: 'utf8' }))
  if (!profile.dsh?.profile?.bundles?.includes('dsh-desktop-pet')) throw new Error('Profile is missing Desktop Pet')
}
const extracted = mkdtempSync(join(tmpdir(), 'dsh-product-app-verify-'))
try {
  execFileSync('/usr/bin/tar', [
    '-xzf', profileArchive, '-C', extracted,
    './cordis.patch.yml',
    './node_modules/dsh-better-sidebar/lib/client.js',
    './node_modules/dsh-file-edit/package.json',
    './node_modules/dsh-file-edit/client/dist/client.js',
    './node_modules/dsh-file-edit/host/index.mjs',
    './node_modules/dsh-file-edit/host/shell-snapshot-transaction.mjs',
  ])
  const client = readFileSync(join(extracted, 'node_modules', 'dsh-better-sidebar', 'lib', 'client.js'), 'utf8')
  if (client.includes('openBrowserPanel') || client.includes('打开网页浏览器')) throw new Error('packaged Better Sidebar still contains the removed titlebar browser entry')
  if (!client.includes('openContentPanel') || !client.includes('aboutBuiltAt')) throw new Error('packaged Better Sidebar is missing current titlebar or release-info UI')
  if (!client.includes('关于 App') || !client.includes('zhee')
    || !client.includes('https://github.com/snzhi000-sys/harness-macos-desktop-plugin-suite')) {
    throw new Error('packaged Better Sidebar is missing the fixed About App author information')
  }

  const fileEditHost = readFileSync(join(
    extracted, 'node_modules', 'dsh-file-edit', 'host', 'index.mjs',
  ), 'utf8')
  const fileEditClient = readFileSync(join(extracted, 'node_modules/dsh-file-edit/client/dist/client.js'), 'utf8')
  if (!fileEditHost.includes('capturePartialShell') || !fileEditHost.includes('auditCoverage')
    || fileEditHost.includes('FULL_ACCESS_AUDIT_NOTICE')
    || fileEditClient.includes('data-audit-coverage')) {
    throw new Error('packaged File Edit must retain partial audit without repeated warning UI or output')
  }
  if (!fileEditClient.includes('tabRevealTick') || !fileEditClient.includes('revealFileTab')
    || !fileEditClient.includes('revealedSessionRef') || !fileEditClient.includes('prefers-reduced-motion: reduce')
    || !fileEditClient.includes('dsh-fe-tab-controls') || fileEditClient.includes('dsh-fe-tab-actions')) {
    throw new Error('packaged File Edit is missing active-tab reveal or safe tab controls')
  }
  const fileEditManifest = JSON.parse(readFileSync(join(
    extracted, 'node_modules', 'dsh-file-edit', 'package.json',
  ), 'utf8'))
  if (fileEditManifest.version !== '1.13.43-local') {
    throw new Error('packaged File Edit version does not include the stage-7 shell audit closure')
  }
  if (!fileEditHost.includes('writeUserDocument')
    || !fileEditHost.includes('assertAgentFileMutationAllowed(exec, item.diskPath)')) {
    throw new Error('packaged File Edit is missing manual-save separation or dismissible review coverage')
  }
  if (!fileEditHost.includes('function settleAcceptedHunk(f, hunk)')
    || !fileEditHost.includes('JSON.stringify({ version: 7')
    || fileEditHost.includes('f.decisions.set(hunkId, action)')) {
    throw new Error('packaged File Edit host is missing durable partial-review settlement')
  }
  const snapshotTransaction = readFileSync(join(
    extracted, 'node_modules', 'dsh-file-edit', 'host', 'shell-snapshot-transaction.mjs',
  ), 'utf8')
  const firstScreenSnapshot = fileEditHost.slice(
    fileEditHost.indexOf('async getModifiedSnapshot(args)'),
    fileEditHost.indexOf('async listTree(args)'),
  )
  const cordisPatch = readFileSync(join(extracted, 'cordis.patch.yml'), 'utf8')
  if (!fileEditHost.includes('captureTransactionalShell(exec, next)')
    || !snapshotTransaction.includes("failure: 'snapshot-finalize-stale'")
    || !snapshotTransaction.includes('changes = calculateChanges(')
    || !snapshotTransaction.includes("['-cR', source, destination]")
    || !snapshotTransaction.includes('version: 2')
    || !snapshotTransaction.includes('withRootLock(roots')
    || !snapshotTransaction.includes('committedRetentionMs')
    || !fileEditHost.includes('stageShellDeletion(st, sid, settled')
    || !fileEditHost.includes('recoverShellTransactions(sid)')
    || firstScreenSnapshot.includes('recoverShellTransactions')
    || !cordisPatch.includes('shellTransactionLifecycle: true')) {
    throw new Error('packaged File Edit host is missing the complete recoverable shell transaction lifecycle')
  }

  execFileSync('/usr/bin/tar', [
    '-xzf', runtimeArchive, '-C', extracted,
    './node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js',
    './node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
    './node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js',
    './node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
    './node_modules/@deepseek-ai/dsh-bash-local/lib/index.js',
    './node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js',
    './node_modules/@deepseek-ai/dsh-tool-pwsh/lib/index.js',
  ])
  const runtimeClient = readFileSync(join(
    extracted, 'node_modules', '@deepseek-ai', 'dsh-client-runtime', 'lib', 'client.js',
  ), 'utf8')
  for (const tool of ['bash', 'pwsh']) {
    const consumer = readFileSync(join(extracted, 'node_modules', '@deepseek-ai', 'dsh-tool-' + tool, 'lib', 'index.js'), 'utf8')
    if (!consumer.includes('Full Access does not restrict writes to audit_root.')
      || consumer.includes('workspaceRoot: auditRoot')) {
      throw new Error('packaged ' + tool + ' still narrows Full Access for file review')
    }
  }
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
  if (!conversationClient.includes('Shell 审核可能不完整')) {
    throw new Error('packaged permission confirmation still promises complete Shell recovery')
  }
  if (!conversationClient.includes('此前运行失败，后续已恢复')) {
    throw new Error('packaged Conversation UI is missing recovered historical failure presentation')
  }
  if (!conversationClient.includes('data-history-pager')
    || !conversationClient.includes('正在加载更早消息…')
    || !runtimeClient.includes('historyError')
    || !/this\.history\(\{ maxMessages: 10 \}\)/.test(runtimeClient)) {
    throw new Error('packaged Runtime is missing ten-message paging and the animated top history pager')
  }

  const deepseekRuntime = readFileSync(join(
    extracted, 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js',
  ), 'utf8')
  const bashRuntime = readFileSync(join(
    extracted, 'node_modules', '@deepseek-ai', 'dsh-bash-local', 'lib', 'index.js',
  ), 'utf8')
  if (!bashRuntime.includes('SHELL_PROCESS_TREE_SURVIVED')) {
    throw new Error('packaged Bash runtime is missing foreground process-tree settlement')
  }
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
