import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId } from '@deepseek-ai/dsh-llm'
import { DockerRunner } from '../src/runner.ts'
import { applyPolicy } from '../src/policy.ts'
import { applyContainerTools } from '../src/tools/containers.ts'
import { applyComposeTools } from '../src/tools/compose.ts'
import { mockApproval } from './helpers.ts'
import { resolveConfig } from '../src/types.ts'

/** Probe for a live daemon; the whole file skips cleanly when absent. */
function daemonAvailable(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

const HAS_DAEMON = daemonAvailable()

/** A stack fixture in a temp dir (project name = the dir basename). */
function makeFixture(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-docker-it-'))
  writeFileSync(join(cwd, 'docker-compose.yml'), [
    'services:',
    '  sleeper:',
    '    image: alpine:3.20',
    '    command: ["sleep", "300"]',
    '',
  ].join('\n'))
  return {
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  }
}

async function buildIntegrationContext(cwd: string, approval: ReturnType<typeof mockApproval>) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const config = resolveConfig({ timeoutMs: 120_000 })
  const getConfig = () => config
  const runner = new DockerRunner(ctx, getConfig)
  applyContainerTools(ctx, runner, getConfig)
  applyComposeTools(ctx, runner, getConfig)
  applyPolicy(ctx, runner, getConfig)
  ctx.provide('approval', approval as never)
  const agent = { session: { header: { cwd } } } as unknown as Agent
  const execute = (name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> =>
    ctx.tools.execute({
      callId: `call-${name}-${Math.random().toString(36).slice(2)}` as unknown as CallId,
      name,
      arguments: args,
      agent,
      signal: new AbortController().signal,
    })
  return { ctx, execute }
}

test('integration: compose up / ps / down a tiny alpine stack (typed rows match reality)', { skip: !HAS_DAEMON && 'no live docker daemon — skipping' }, async () => {
  const fixture = makeFixture()
  const approval = mockApproval('allowed-once')
  const { execute } = await buildIntegrationContext(fixture.cwd, approval)
  try {
    // up (detached)
    const up = await execute('docker_compose_up', {})
    assert.equal(up.isError, false)
    if (!up.isError) {
      const value = up.value as { project: string; detached: boolean }
      assert.equal(value.detached, true)
      assert.ok(value.project.length > 0)
    }

    // compose ps reflects the running sleeper service
    const ps = await execute('docker_compose_ps', {})
    assert.equal(ps.isError, false)
    if (!ps.isError) {
      const value = ps.value as { project: string; services: Array<{ name: string; state: string }> }
      assert.equal(value.services.length, 1)
      assert.match(value.services[0]?.name ?? '', /sleeper/)
      assert.equal(value.services[0]?.state, 'running')
    }

    // docker_ps scoped to the project finds the container with service metadata
    const containers = await execute('docker_ps', { all: true })
    assert.equal(containers.isError, false)
    if (!containers.isError) {
      const value = containers.value as { containers: Array<{ service?: string; project?: string; state: string }> }
      const mine = value.containers.filter((c) => c.service === 'sleeper')
      assert.equal(mine.length, 1)
      assert.equal(mine[0]?.state, 'running')
    }

    // down without volumes proceeds without approval
    const down = await execute('docker_compose_down', {})
    assert.equal(down.isError, false)
    if (!down.isError) {
      const value = down.value as { project: string }
      assert.ok(value.project.length > 0)
    }
    assert.equal(approval.requests.length, 0, 'plain down must not ask for approval')

    // the stack is gone
    const after = await execute('docker_compose_ps', {})
    assert.equal(after.isError, false)
    if (!after.isError) {
      const value = after.value as { services: unknown[] }
      assert.equal(value.services.length, 0)
    }
  } finally {
    fixture.cleanup()
  }
})

test('integration: compose down -v requires approval (denied by the gate)', { skip: !HAS_DAEMON && 'no live docker daemon — skipping' }, async () => {
  const fixture = makeFixture()
  const approval = mockApproval('rejected')
  const { execute } = await buildIntegrationContext(fixture.cwd, approval)
  try {
    const up = await execute('docker_compose_up', {})
    assert.equal(up.isError, false)

    const down = await execute('docker_compose_down', { volumes: true })
    assert.equal(down.isError, true)
    if (down.isError) assert.match(down.error.message, /volumes|approval/)
    assert.equal(approval.requests.length, 1, 'down -v must ask exactly once')

    // Cleanup without volumes (allowed), leaving no stack behind.
    const cleanup = await execute('docker_compose_down', {})
    assert.equal(cleanup.isError, false)
  } finally {
    fixture.cleanup()
  }
})

test('integration: down -v proceeds when the gate approves', { skip: !HAS_DAEMON && 'no live docker daemon — skipping' }, async () => {
  const fixture = makeFixture()
  const approval = mockApproval('allowed-once')
  const { execute } = await buildIntegrationContext(fixture.cwd, approval)
  try {
    const up = await execute('docker_compose_up', {})
    assert.equal(up.isError, false)

    const down = await execute('docker_compose_down', { volumes: true })
    assert.equal(down.isError, false)
    if (!down.isError) {
      const value = down.value as { volumes: boolean }
      assert.equal(value.volumes, true)
    }
    assert.equal(approval.requests.length, 1)
  } finally {
    fixture.cleanup()
  }
})
