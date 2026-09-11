import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

import plugin, { createTool, redactOutput, validateInvocation } from '../index.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lark-cli-test-'))
  const workspace = join(root, 'workspace')
  const stateDir = join(root, 'state')
  mkdirSync(workspace)
  mkdirSync(stateDir)
  const executable = join(root, 'lark-cli')
  writeFileSync(executable, '#!/bin/sh\nexit 0\n')
  chmodSync(executable, 0o755)
  return { root, workspace, stateDir, executable }
}

function execution(workspace, overrides = {}) {
  return {
    callId: 'call-test',
    signal: new AbortController().signal,
    agent: { session: { header: { id: 'session-test', cwd: workspace } } },
    ...overrides,
  }
}

function subprocessResult({ stdout = '', stderr = '', exitCode = 0, signal = null } = {}) {
  return {
    pid: 123,
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: Buffer.byteLength(stdout), lossy: false }) },
      stderr: { readFrom: () => ({ text: stderr, nextOffset: Buffer.byteLength(stderr), lossy: false }) },
    },
    done: Promise.resolve({ exitCode, signal }),
    terminate() {},
    waitForExit: async () => true,
  }
}

function harness(options = {}) {
  const spawns = []
  const policies = []
  const approvals = []
  const ctx = {
    approval: {
      request: async request => {
        approvals.push(request)
        return options.approval ?? 'allowed-once'
      },
    },
    sandbox: {
      confine(argv, policy) {
        policies.push(policy)
        return {
          argv: ['sandbox-runner', '--', ...argv],
          enforcement: options.enforcement ?? 'full',
          denialSignatures: [],
          runnerFailureRules: [],
        }
      },
    },
    subprocess: {
      spawn(spec) {
        spawns.push(spec)
        return options.spawn?.(spec) ?? subprocessResult(options.result)
      },
    },
  }
  return { ctx, spawns, policies, approvals }
}

test('allows only the explicit domain/shortcut matrix', () => {
  const { workspace } = fixture()
  writeFileSync(join(workspace, 'file.txt'), 'fixture')
  assert.equal(validateInvocation(['docs', '+fetch', '--doc', 'https://example.test/doc'], workspace).risk, 'read')
  assert.equal(validateInvocation(['drive', '+upload', '--dry-run', '--file', 'file.txt'], workspace).risk, 'read')
  assert.equal(validateInvocation(['drive', '+upload', '--dry-run=false', '--file', 'file.txt'], workspace).risk, 'write')
  assert.throws(() => validateInvocation(['api', 'GET', '/open-apis/x'], workspace), /not allowed/)
  assert.throws(() => validateInvocation(['skills', 'read', 'lark-doc'], workspace), /not allowed/)
  assert.throws(() => validateInvocation(['drive', 'files', 'list'], workspace), /not allowed/)
  assert.throws(() => validateInvocation(['drive', '+sync', '--local-dir', workspace], workspace), /not allowed/)
  assert.throws(() => validateInvocation(['docs', '+fetch', '--profile', 'other'], workspace), /flag is not allowed/)
  assert.throws(() => validateInvocation(['docs', '+resource-update', '--url', 'https://example.test/image.png'], workspace), /flag is not allowed/)
  assert.throws(() => validateInvocation(['markdown', '+fetch', '--output', 'result.md'], workspace), /flag is not allowed/)
})

test('shell metacharacters remain ordinary argv values', async () => {
  const { workspace, stateDir, executable } = fixture()
  const h = harness()
  const tool = createTool(h.ctx, { executable, stateDir })
  await tool.execute({ args: ['docs', '+fetch', '--doc', '|', '$(', 'touch', 'pwned', ')'], purpose: 'read' }, execution(workspace))
  assert.deepEqual(h.spawns[0].argv, [
    'sandbox-runner', '--', executable, 'docs', '+fetch', '--doc', '|', '$(', 'touch', 'pwned', ')',
  ])
  assert.equal(h.spawns[0].argv.includes('-c'), false)
})

test('upload inputs must resolve to real workspace files and reject symlink escapes', () => {
  const { root, workspace } = fixture()
  const inside = join(workspace, 'inside.md')
  const insideReal = realpathSync(workspace) + '/inside.md'
  const outside = join(root, 'outside.md')
  writeFileSync(inside, 'inside')
  writeFileSync(outside, 'outside')
  symlinkSync(outside, join(workspace, 'escape.md'))
  assert.doesNotThrow(() => validateInvocation(['drive', '+upload', '--file', inside], workspace))
  assert.deepEqual(validateInvocation(['drive', '+upload', '--file', 'inside.md'], workspace).args.slice(-2), ['--file', insideReal])
  assert.deepEqual(validateInvocation(['markdown', '+create', '--content', '@inside.md'], workspace).args.slice(-2), ['--content', `@${insideReal}`])
  assert.throws(() => validateInvocation(['drive', '+upload', '--file', outside], workspace), /inside the current workspace/)
  assert.throws(() => validateInvocation(['drive', '+upload', '--file', 'escape.md'], workspace), /inside the current workspace/)
  assert.throws(() => validateInvocation(['markdown', '+create', '--content', '-'], workspace), /stdin payloads are not supported/)
})

test('ordinary remote writes execute without an approval prompt', async () => {
  const { workspace, stateDir, executable } = fixture()
  const h = harness({ approval: 'rejected' })
  const tool = createTool(h.ctx, { executable, stateDir })
  await tool.execute({ args: ['docs', '+update', '--doc', 'doc-token', '--command', 'overwrite'], purpose: 'update a document' }, execution(workspace))
  assert.equal(h.approvals.length, 0)
  assert.equal(h.spawns.length, 1)
})

test('high-risk remote writes execute only after an allowed-once approval', async () => {
  for (const denied of ['rejected', 'cancelled', 'unavailable']) {
    const { workspace, stateDir, executable } = fixture()
    const h = harness({ approval: denied })
    const tool = createTool(h.ctx, { executable, stateDir })
    await assert.rejects(
      tool.execute({ args: ['wiki', '+node-delete', '--node-token', 'wiki-token'], purpose: 'delete a page' }, execution(workspace)),
      new RegExp(`approval did not grant.*${denied}`),
    )
    assert.equal(h.spawns.length, 0)
    assert.equal(h.approvals.length, 1)
  }

  const { workspace, stateDir, executable } = fixture()
  const h = harness({ approval: 'allowed-once' })
  const tool = createTool(h.ctx, { executable, stateDir })
  await tool.execute({ args: ['wiki', '+node-delete', '--node-token', 'wiki-token'], purpose: 'delete a page' }, execution(workspace))
  assert.equal(h.approvals.length, 1)
  assert.equal(h.spawns.length, 1)
})

test('dry-run skips approval and every execution is confined to state plus temp roots', async () => {
  const { workspace, stateDir, executable } = fixture()
  const local = join(workspace, 'upload.md')
  writeFileSync(local, 'data')
  const h = harness()
  const tool = createTool(h.ctx, { executable, stateDir })
  await tool.execute({ args: ['drive', '+upload', '--dry-run', `--file=${local}`], purpose: 'preview upload' }, execution(workspace))
  assert.equal(h.approvals.length, 0)
  assert.equal(h.policies.length, 1)
  assert.deepEqual(h.policies[0], { mode: 'workspace-write', workspaceRoot: stateDir, sessionId: 'session-test' })
  assert.match(h.spawns[0].cwd, /dsh-lark-cli-/)
  assert.equal(h.spawns[0].env.HOME.length > 0, true)
  assert.match(h.spawns[0].env.TMPDIR, /dsh-lark-cli-/)
})

test('rejects partial sandbox enforcement before spawning', async () => {
  const { workspace, stateDir, executable } = fixture()
  const h = harness({ enforcement: 'partial' })
  const tool = createTool(h.ctx, { executable, stateDir })
  await assert.rejects(
    tool.execute({ args: ['auth', 'status'], purpose: 'status' }, execution(workspace)),
    /full filesystem sandbox enforcement is required/,
  )
  assert.equal(h.spawns.length, 0)
})

test('timeout aborts the managed subprocess call', async () => {
  const { workspace, stateDir, executable } = fixture()
  let observedAbort = false
  const h = harness({
    spawn(spec) {
      let resolveDone
      const done = new Promise(resolve => { resolveDone = resolve })
      spec.signal.addEventListener('abort', () => {
        observedAbort = true
        resolveDone({ exitCode: null, signal: 'SIGTERM' })
      }, { once: true })
      return {
        ...subprocessResult(),
        done,
      }
    },
  })
  const tool = createTool(h.ctx, { executable, stateDir, timeoutMs: 1_000 })
  await assert.rejects(
    tool.execute({ args: ['auth', 'status'], purpose: 'status' }, execution(workspace)),
    /command timed out/,
  )
  assert.equal(observedAbort, true)
})

test('redacts credential tokens while preserving non-secret document identifiers', async () => {
  const { workspace, stateDir, executable } = fixture()
  const h = harness({ result: {
    stdout: '{"access_token":"secret-a","file_token":"doc-123"}',
    stderr: 'Authorization: Bearer secret-b\nrefresh_token=secret-c',
  } })
  const tool = createTool(h.ctx, { executable, stateDir })
  const result = await tool.execute({ args: ['auth', 'status'], purpose: 'status' }, execution(workspace))
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret-[abc]/)
  assert.match(result.stdout, /doc-123/)
  assert.match(redactOutput('{"device_code":"short-lived"}', { preserveDeviceCode: true }), /short-lived/)
})

test('plugin registers only lark_cli and its scoped prompt', () => {
  const { stateDir, executable } = fixture()
  const tools = []
  const prompts = []
  const ctx = {
    tools: { register: tool => { tools.push(tool); return () => {} } },
    systemPrompt: { section: section => { prompts.push(section); return () => {} } },
    effect: callback => callback(),
    approval: {}, sandbox: {}, subprocess: {},
  }
  plugin.apply(ctx, { executable, stateDir })
  assert.deepEqual(tools.map(tool => tool.name), ['lark_cli'])
  assert.deepEqual(prompts.map(prompt => prompt.name), ['tool:lark-cli'])
})

const seatbeltProbe = process.platform === 'darwin'
  ? spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '--', '/usr/bin/true'], { stdio: 'ignore' })
  : undefined

test('real subprocess and macOS sandbox allow only the lark state root', {
  skip: process.platform !== 'darwin' || seatbeltProbe?.status !== 0,
}, async () => {
  const root = mkdtempSync(join(homedir(), '.dsh-lark-cli-e2e-'))
  const stateDir = join(root, 'state')
  const workspace = join(root, 'workspace')
  mkdirSync(stateDir)
  mkdirSync(workspace)
  const executable = join(root, 'lark-cli')
  writeFileSync(executable, '#!/bin/sh\nprintf controlled > "$3"\n')
  chmodSync(executable, 0o755)

  const ctx = new Context()
  try {
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalSandboxProvider, {})
    const tool = createTool(ctx, { executable, stateDir })
    const stateTarget = join(stateDir, 'allowed.txt')
    const workspaceTarget = join(workspace, 'denied.txt')
    const allowed = await tool.execute(
      { args: ['auth', 'status', stateTarget], purpose: 'sandbox state write probe' },
      execution(workspace),
    )
    assert.equal(allowed.ok, true)
    assert.equal(readFileSync(stateTarget, 'utf8'), 'controlled')

    const denied = await tool.execute(
      { args: ['auth', 'status', workspaceTarget], purpose: 'sandbox workspace denial probe' },
      execution(workspace),
    )
    assert.equal(denied.ok, false)
    assert.equal(existsSync(workspaceTarget), false)
  } finally {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
