import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, isHardDestructive } from '../src/classify.ts'
import { DEFAULT_CONFIG, resolveConfig } from '../src/types.ts'
import type { ResolvedFacts } from '../src/types.ts'

const config = resolveConfig(undefined)

function verdict(tool: string, args: Record<string, unknown>, resolved: ResolvedFacts = {}, cfg = config) {
  return classify(tool, args, resolved, cfg)
}

test('classify: docker_ps / logs / inspect / start / stop / restart are safe', () => {
  for (const tool of ['docker_ps', 'docker_logs', 'docker_inspect', 'docker_start', 'docker_stop', 'docker_restart']) {
    assert.equal(verdict(tool, {}).effect, 'safe', `${tool} must be safe`)
  }
})

test('classify: docker_images and docker_compose_up / docker_compose_ps are safe', () => {
  assert.equal(verdict('docker_images', {}).effect, 'safe')
  assert.equal(verdict('docker_compose_up', { detach: false }).effect, 'safe')
  assert.equal(verdict('docker_compose_ps', {}).effect, 'safe')
})

test('classify: docker_compose_down is safe without volumes, guarded with volumes', () => {
  assert.equal(verdict('docker_compose_down', {}).effect, 'safe')
  assert.equal(verdict('docker_compose_down', { volumes: false }).effect, 'safe')
  const guarded = verdict('docker_compose_down', { volumes: true })
  assert.equal(guarded.effect, 'guarded')
  assert.match(guarded.reason, /volumes/)
})

test('classify: docker_rm is safe on a stopped container, guarded on a running one', () => {
  assert.equal(verdict('docker_rm', { container: 'x' }, { running: false }).effect, 'safe')
  const guarded = verdict('docker_rm', { container: 'x' }, { running: true })
  assert.equal(guarded.effect, 'guarded')
  assert.match(guarded.reason, /running/)
})

test('classify: docker_rm with force is guarded even when facts are unknown', () => {
  const guarded = verdict('docker_rm', { container: 'x', force: true })
  assert.equal(guarded.effect, 'guarded')
  assert.match(guarded.reason, /force/)
})

test('classify: docker_rmi is safe on an unused image, guarded when in use', () => {
  assert.equal(verdict('docker_rmi', { image: 'alpine' }, { imageInUse: false }).effect, 'safe')
  const guarded = verdict('docker_rmi', { image: 'alpine' }, { imageInUse: true })
  assert.equal(guarded.effect, 'guarded')
  assert.match(guarded.reason, /in use/)
})

test('classify: docker_prune scopes', () => {
  // system scope (default) is guarded
  assert.equal(verdict('docker_prune', {}).effect, 'guarded')
  assert.equal(verdict('docker_prune', { scope: 'system' }).effect, 'guarded')
  // --all is guarded regardless of scope
  assert.equal(verdict('docker_prune', { scope: 'images', all: true }).effect, 'guarded')
  // --volumes is guarded
  assert.equal(verdict('docker_prune', { volumes: true }).effect, 'guarded')
  // a narrow scope without --all/--volumes is safe
  assert.equal(verdict('docker_prune', { scope: 'images' }).effect, 'safe')
  assert.equal(verdict('docker_prune', { scope: 'containers' }).effect, 'safe')
  assert.equal(verdict('docker_prune', { scope: 'volumes' }).effect, 'safe')
  assert.equal(verdict('docker_prune', { scope: 'networks' }).effect, 'safe')
})

test('classify: docker_exec is read-only-safe by default, guarded with write/interactive', () => {
  assert.equal(verdict('docker_exec', { container: 'x', command: ['ls'] }).effect, 'safe')
  const write = verdict('docker_exec', { container: 'x', command: ['sh'], write: true })
  assert.equal(write.effect, 'guarded')
  assert.match(write.reason, /write/)
  const interactive = verdict('docker_exec', { container: 'x', command: ['sh'], interactive: true })
  assert.equal(interactive.effect, 'guarded')
  assert.match(interactive.reason, /interactive/)
})

test('classify: execReadOnly: false flips docker_exec to always safe', () => {
  const lax = resolveConfig({ execReadOnly: false })
  assert.equal(verdict('docker_exec', { container: 'x', command: ['ls'] }, {}, lax).effect, 'safe')
  assert.equal(verdict('docker_exec', { container: 'x', command: ['sh'], write: true }, {}, lax).effect, 'safe')
  assert.equal(verdict('docker_exec', { container: 'x', command: ['sh'], interactive: true }, {}, lax).effect, 'safe')
})

test('classify: default config carries the documented approval globs', () => {
  assert.deepEqual(DEFAULT_CONFIG.approval, ['rmi:*', 'rm:*', 'prune:*', 'compose down -v', 'exec:*'])
  assert.equal(DEFAULT_CONFIG.execReadOnly, true)
  assert.equal(DEFAULT_CONFIG.healthContext.enabled, false)
})

test('isHardDestructive agrees with classify', () => {
  assert.equal(isHardDestructive('docker_rm', { container: 'x' }, { running: true }, config), true)
  assert.equal(isHardDestructive('docker_rm', { container: 'x' }, { running: false }, config), false)
  assert.equal(isHardDestructive('docker_rmi', { image: 'x' }, { imageInUse: true }, config), true)
  assert.equal(isHardDestructive('docker_prune', { all: true }, {}, config), true)
  assert.equal(isHardDestructive('docker_compose_down', { volumes: true }, {}, config), true)
  assert.equal(isHardDestructive('docker_exec', { container: 'x', command: ['ls'], write: true }, {}, config), true)
})
