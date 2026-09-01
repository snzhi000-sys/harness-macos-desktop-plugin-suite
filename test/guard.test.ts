import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext, executeTool, FakeShell, imageRow, mockApproval, psRow } from './helpers.ts'

/** A compose project fixture dir for project-scoped tools. */
const STACK_CWD = new URL('./fixtures/stack/', import.meta.url).pathname

test('guard: denying gate refuses rmi on an in-use image', async () => {
  const shell = new FakeShell([
    { match: 'images', stdout: imageRow({ ID: 'img1234567890', Repository: 'alpine', Tag: 'latest' }) },
    { match: 'ps', stdout: psRow({ Image: 'alpine:latest', ImageID: 'img1234567890' }) },
  ])
  const approval = mockApproval('rejected')
  const { ctx } = await buildContext({ shell, approval })
  const result = await executeTool(ctx, 'docker_rmi', { image: 'alpine' })
  assert.equal(result.isError, true)
  if (result.isError) assert.match(result.error.message, /in use/)
  assert.equal(approval.requests.length, 1)
})

test('guard: approving gate lets rmi on an in-use image proceed exactly once', async () => {
  const shell = new FakeShell([
    { match: 'images', stdout: imageRow({ ID: 'img1234567890', Repository: 'alpine', Tag: 'latest' }) },
    { match: 'ps', stdout: psRow({ Image: 'alpine:latest', ImageID: 'img1234567890' }) },
    { match: 'rmi', stdout: 'Untagged: alpine:latest\n' },
  ])
  const approval = mockApproval('allowed-once')
  const { ctx } = await buildContext({ shell, approval })
  const result = await executeTool(ctx, 'docker_rmi', { image: 'alpine' })
  assert.equal(result.isError, false)
  if (!result.isError) {
    const value = result.value as { removed: string[] }
    assert.deepEqual(value.removed, ['alpine'])
  }
  assert.equal(approval.requests.length, 1, 'approval must be asked exactly once')
})

test('guard: denying gate refuses rm on a running container', async () => {
  const shell = new FakeShell([{ match: 'ps', stdout: psRow({ State: 'running' }) }])
  const approval = mockApproval('rejected')
  const { ctx } = await buildContext({ shell, approval })
  const result = await executeTool(ctx, 'docker_rm', { container: 'box' })
  assert.equal(result.isError, true)
  if (result.isError) assert.match(result.error.message, /running/)
  assert.equal(approval.requests.length, 1)
})

test('guard: rm on a stopped container proceeds without approval', async () => {
  const shell = new FakeShell([
    { match: 'ps', stdout: psRow({ State: 'exited' }) },
    { match: 'rm', stdout: 'box\n' },
  ])
  const approval = mockApproval('rejected')
  const { ctx } = await buildContext({ shell, approval })
  const result = await executeTool(ctx, 'docker_rm', { container: 'box' })
  assert.equal(result.isError, false)
  if (!result.isError) {
    const value = result.value as { affected: string[] }
    assert.deepEqual(value.affected, ['box'])
  }
  assert.equal(approval.requests.length, 0, 'a safe rm must not ask for approval')
})

test('guard: denying gate refuses prune --all', async () => {
  const approval = mockApproval('rejected')
  const { ctx } = await buildContext({ shell: new FakeShell([]), approval })
  const result = await executeTool(ctx, 'docker_prune', { scope: 'images', all: true })
  assert.equal(result.isError, true)
  if (result.isError) assert.match(result.error.message, /approval/)
  assert.equal(approval.requests.length, 1)
})

test('guard: approving gate lets prune proceed exactly once', async () => {
  const approval = mockApproval('allowed-once')
  const shell = new FakeShell([{ match: 'prune', stdout: 'Total reclaimed space: 0B\n' }])
  const { ctx } = await buildContext({ shell, approval })
  const result = await executeTool(ctx, 'docker_prune', { scope: 'images', all: true })
  assert.equal(result.isError, false)
  if (!result.isError) {
    const value = result.value as { scope: string; all: boolean; ok: boolean }
    assert.equal(value.scope, 'images')
    assert.equal(value.all, true)
    assert.equal(value.ok, true)
  }
  assert.equal(approval.requests.length, 1)
})

test('guard: denying gate refuses compose down -v', async () => {
  const approval = mockApproval('rejected')
  const { ctx } = await buildContext({ shell: new FakeShell([]), approval })
  const result = await executeTool(ctx, 'docker_compose_down', { volumes: true }, STACK_CWD)
  assert.equal(result.isError, true)
  if (result.isError) assert.match(result.error.message, /volumes/)
  assert.equal(approval.requests.length, 1)
})

test('guard: compose down without volumes proceeds without approval', async () => {
  const approval = mockApproval('rejected')
  const shell = new FakeShell([{ match: 'down', stdout: '' }])
  const { ctx } = await buildContext({ shell, approval })
  const result = await executeTool(ctx, 'docker_compose_down', {}, STACK_CWD)
  assert.equal(result.isError, false)
  assert.equal(approval.requests.length, 0)
})

test('guard: denying gate refuses writeful exec', async () => {
  const shell = new FakeShell([{ match: 'ps', stdout: psRow({}) }])
  const approval = mockApproval('rejected')
  const { ctx } = await buildContext({ shell, approval })
  const result = await executeTool(ctx, 'docker_exec', { container: 'box', command: ['rm', '-rf', '/tmp/x'], write: true })
  assert.equal(result.isError, true)
  if (result.isError) assert.match(result.error.message, /write|approval/)
  assert.equal(approval.requests.length, 1)
})

test('guard: read-only exec proceeds without approval', async () => {
  const shell = new FakeShell([
    { match: 'ps', stdout: psRow({}) },
    { match: 'exec', stdout: 'total 0\n' },
  ])
  const approval = mockApproval('rejected')
  const { ctx } = await buildContext({ shell, approval })
  const result = await executeTool(ctx, 'docker_exec', { container: 'box', command: ['ls'] })
  assert.equal(result.isError, false)
  if (!result.isError) {
    const value = result.value as { exitCode: number | null; stdout: string }
    assert.equal(value.exitCode, 0)
    assert.equal(value.stdout, 'total 0\n')
  }
  assert.equal(approval.requests.length, 0)
})

test('guard: execReadOnly: false lets writeful exec proceed ungated', async () => {
  const shell = new FakeShell([
    { match: 'ps', stdout: psRow({}) },
    { match: 'exec', stdout: 'ok\n' },
  ])
  const approval = mockApproval('rejected')
  const { ctx } = await buildContext({ shell, approval, config: { execReadOnly: false } })
  const result = await executeTool(ctx, 'docker_exec', { container: 'box', command: ['touch', '/tmp/marker'], write: true })
  assert.equal(result.isError, false)
  assert.equal(approval.requests.length, 0)
})

test('guard: guarded ops fail closed with no approval gate composed', async () => {
  const shell = new FakeShell([{ match: 'ps', stdout: psRow({ State: 'running' }) }])
  const { ctx } = await buildContext({ shell })
  const result = await executeTool(ctx, 'docker_rm', { container: 'box' })
  assert.equal(result.isError, true)
  if (result.isError) assert.match(result.error.message, /no approval channel|fails closed/)
})

test('guard: guarded ops not covered by the approval globs are refused outright', async () => {
  const shell = new FakeShell([{ match: 'ps', stdout: psRow({ State: 'running' }) }])
  const approval = mockApproval('allowed-once')
  const { ctx } = await buildContext({ shell, approval, config: { approval: [] } })
  const result = await executeTool(ctx, 'docker_rm', { container: 'box' })
  assert.equal(result.isError, true)
  if (result.isError) assert.match(result.error.message, /not covered/)
  assert.equal(approval.requests.length, 0, 'no approval must be asked when the globs do not cover the op')
})

test('guard backstop: a preempting allow from another listener is refused without a token', async () => {
  const shell = new FakeShell([
    { match: 'images', stdout: imageRow({ ID: 'img1234567890', Repository: 'alpine', Tag: 'latest' }) },
    { match: 'ps', stdout: psRow({ Image: 'alpine:latest', ImageID: 'img1234567890' }) },
  ])
  // A rogue listener that allows docker_rmi without consulting the gate,
  // registered BEFORE the dsh-docker policy.
  const { ctx } = await buildContext({
    shell,
    beforePolicy: (ctx) => {
      ctx.on('tools/pre-execute', async (_exec, _next) => ({ kind: 'allow' as const }))
    },
  })
  const result = await executeTool(ctx, 'docker_rmi', { image: 'alpine' })
  assert.equal(result.isError, true)
  if (result.isError) assert.match(result.error.message, /approval token/)
})

test('guard: unrelated tools are untouched by the guard', async () => {
  const approval = mockApproval('rejected')
  const shell = new FakeShell([{ match: 'ps', stdout: psRow({}) }])
  const { ctx } = await buildContext({ shell, approval })
  // docker_ps is not destructive: no approval asked, no guard denial.
  const result = await executeTool(ctx, 'docker_ps', {})
  assert.equal(result.isError, false)
  assert.equal(approval.requests.length, 0)
})
