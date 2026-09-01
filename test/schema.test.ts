import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext, executeTool, FakeShell, imageRow, psRow } from './helpers.ts'

const emptyShell = new FakeShell([])

test('schema: docker_ps accepts minimal args and returns typed rows', async () => {
  const shell = new FakeShell([{ match: 'ps', stdout: psRow({ Names: 'web', State: 'running' }) }])
  const { ctx } = await buildContext({ shell })
  const result = await executeTool(ctx, 'docker_ps', {})
  assert.equal(result.isError, false)
  if (!result.isError) {
    const value = result.value as { containers: Array<{ name: string; state: string }> }
    assert.equal(value.containers.length, 1)
    assert.equal(value.containers[0]?.name, 'web')
    assert.equal(value.containers[0]?.state, 'running')
  }
})

test('schema: docker_ps rejects a non-boolean all', async () => {
  const { ctx } = await buildContext({ shell: emptyShell })
  const result = await executeTool(ctx, 'docker_ps', { all: 'yes' })
  assert.equal(result.isError, true)
})

test('schema: docker_rm requires a non-empty container ref (execute-level hand check)', async () => {
  const { ctx } = await buildContext({ shell: new FakeShell([{ match: 'ps', stdout: psRow({}) }]) })
  const result = await executeTool(ctx, 'docker_rm', { container: '' })
  assert.equal(result.isError, true)
  if (result.isError) assert.match(result.error.message, /non-empty/)
})

test('schema: docker_rm rejects a missing required container', async () => {
  const { ctx } = await buildContext({ shell: emptyShell })
  const result = await executeTool(ctx, 'docker_rm', {})
  assert.equal(result.isError, true)
})

test('schema: docker_logs rejects a non-integer tail', async () => {
  const shell = new FakeShell([
    { match: 'ps', stdout: psRow({}) },
    { match: 'logs', stdout: 'line one\nline two\n' },
  ])
  const { ctx } = await buildContext({ shell })
  const result = await executeTool(ctx, 'docker_logs', { container: 'box', tail: 'many' })
  assert.equal(result.isError, true)
})

test('schema: docker_logs rejects a negative tail (hand-checked bound)', async () => {
  const shell = new FakeShell([{ match: 'ps', stdout: psRow({}) }])
  const { ctx } = await buildContext({ shell })
  const result = await executeTool(ctx, 'docker_logs', { container: 'box', tail: -1 })
  assert.equal(result.isError, true)
  if (result.isError) assert.match(result.error.message, /tail/)
})

test('schema: docker_logs rejects a tail above the cap', async () => {
  const shell = new FakeShell([{ match: 'ps', stdout: psRow({}) }])
  const { ctx } = await buildContext({ shell })
  const result = await executeTool(ctx, 'docker_logs', { container: 'box', tail: 999_999 })
  assert.equal(result.isError, true)
  if (result.isError) assert.match(result.error.message, /cap/)
})

test('schema: docker_logs pulls tail+1 and flags truncation honestly', async () => {
  const shell = new FakeShell([
    { match: 'ps', stdout: psRow({}) },
    { match: 'logs', stdout: 'a\nb\nc\nd\n' },
  ])
  const { ctx } = await buildContext({ shell })
  const result = await executeTool(ctx, 'docker_logs', { container: 'box', tail: 3 })
  assert.equal(result.isError, false)
  if (!result.isError) {
    const value = result.value as { lines: string[]; truncated: boolean }
    assert.deepEqual(value.lines, ['b', 'c', 'd'])
    assert.equal(value.truncated, true)
  }
})

test('schema: docker_exec rejects an empty command array (hand-checked)', async () => {
  const shell = new FakeShell([{ match: 'ps', stdout: psRow({}) }])
  const { ctx } = await buildContext({ shell })
  const result = await executeTool(ctx, 'docker_exec', { container: 'box', command: [] })
  assert.equal(result.isError, true)
  if (result.isError) assert.match(result.error.message, /command/)
})

test('schema: docker_exec carries a non-zero exit as a successful domain value', async () => {
  const shell = new FakeShell([
    { match: 'ps', stdout: psRow({}) },
    { match: 'exec', exitCode: 1, stderr: 'ls: no such file' },
  ])
  const { ctx } = await buildContext({ shell })
  const result = await executeTool(ctx, 'docker_exec', { container: 'box', command: ['ls', '/nope'] })
  assert.equal(result.isError, false)
  if (!result.isError) {
    const value = result.value as { exitCode: number | null; stderr: string }
    assert.equal(value.exitCode, 1)
    assert.match(value.stderr, /no such file/)
  }
})

test('schema: docker_compose_up rejects a non-array services', async () => {
  const { ctx } = await buildContext({ shell: emptyShell })
  const result = await executeTool(ctx, 'docker_compose_up', { services: 'web' })
  assert.equal(result.isError, true)
})

test('schema: docker_prune rejects an unknown scope enum', async () => {
  const { ctx } = await buildContext({ shell: emptyShell })
  const result = await executeTool(ctx, 'docker_prune', { scope: 'everything' })
  assert.equal(result.isError, true)
})

test('schema: docker_inspect rejects an empty target', async () => {
  const { ctx } = await buildContext({ shell: emptyShell })
  const result = await executeTool(ctx, 'docker_inspect', { target: '  ' })
  assert.equal(result.isError, true)
})

test('schema: docker_images returns rows with inUse from the ps -a cross-reference', async () => {
  const shell = new FakeShell([
    { match: 'images', stdout: imageRow({ ID: 'img1234567890', Repository: 'alpine', Tag: 'latest' }) },
    { match: 'ps', stdout: psRow({ Image: 'alpine:latest', ImageID: 'img1234567890' }) },
  ])
  const { ctx } = await buildContext({ shell })
  const result = await executeTool(ctx, 'docker_images', {})
  assert.equal(result.isError, false)
  if (!result.isError) {
    const value = result.value as { images: Array<{ repository: string; inUse: boolean }> }
    assert.equal(value.images[0]?.repository, 'alpine')
    assert.equal(value.images[0]?.inUse, true)
  }
})

test('schema: compose tools require a detected or explicit project', async () => {
  const { ctx } = await buildContext({ shell: emptyShell })
  const result = await executeTool(ctx, 'docker_compose_ps', {}, '/tmp/nowhere-for-dsh-docker-tests')
  assert.equal(result.isError, true)
  if (result.isError) assert.match(result.error.message, /project/)
})
