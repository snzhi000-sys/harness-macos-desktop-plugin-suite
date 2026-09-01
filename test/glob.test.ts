import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coveredByApproval, patternMatches, patternName } from '../src/glob.ts'

const DEFAULT_PATTERNS = ['rmi:*', 'rm:*', 'prune:*', 'compose down -v', 'exec:*']

test('glob: patternName strips the docker_ prefix', () => {
  assert.equal(patternName('docker_rmi'), 'rmi')
  assert.equal(patternName('docker_compose_down'), 'compose_down')
  assert.equal(patternName('docker_ps'), 'ps')
  assert.equal(patternName('not_docker'), 'not_docker')
})

test('glob: rmi:* covers docker_rmi', () => {
  assert.equal(patternMatches('rmi:*', 'docker_rmi', false), true)
  assert.equal(coveredByApproval(DEFAULT_PATTERNS, 'docker_rmi', false), true)
})

test('glob: rm:* covers docker_rm', () => {
  assert.equal(patternMatches('rm:*', 'docker_rm', false), true)
  assert.equal(coveredByApproval(DEFAULT_PATTERNS, 'docker_rm', false), true)
})

test('glob: prune:* covers docker_prune', () => {
  assert.equal(patternMatches('prune:*', 'docker_prune', false), true)
  assert.equal(coveredByApproval(DEFAULT_PATTERNS, 'docker_prune', false), true)
})

test('glob: exec:* covers docker_exec', () => {
  assert.equal(patternMatches('exec:*', 'docker_exec', false), true)
  assert.equal(coveredByApproval(DEFAULT_PATTERNS, 'docker_exec', false), true)
})

test('glob: "compose down -v" covers docker_compose_down only with volumes', () => {
  assert.equal(patternMatches('compose down -v', 'docker_compose_down', true), true)
  assert.equal(patternMatches('compose down -v', 'docker_compose_down', false), false)
  assert.equal(coveredByApproval(DEFAULT_PATTERNS, 'docker_compose_down', true), true)
  assert.equal(coveredByApproval(DEFAULT_PATTERNS, 'docker_compose_down', false), false)
})

test('glob: unrelated tools are not covered', () => {
  assert.equal(coveredByApproval(DEFAULT_PATTERNS, 'docker_ps', false), false)
  assert.equal(coveredByApproval(DEFAULT_PATTERNS, 'docker_logs', false), false)
  assert.equal(coveredByApproval(DEFAULT_PATTERNS, 'bash', false), false)
})

test('glob: empty pattern list covers nothing (fail closed)', () => {
  assert.equal(coveredByApproval([], 'docker_rmi', false), false)
  assert.equal(coveredByApproval([], 'docker_rm', false), false)
  assert.equal(coveredByApproval([], 'docker_compose_down', true), false)
})

test('glob: star matches any tool', () => {
  assert.equal(patternMatches('*', 'docker_rmi', false), true)
  assert.equal(patternMatches('*', 'docker_ps', false), true)
})
