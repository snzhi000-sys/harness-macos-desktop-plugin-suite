import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  baseName,
  composeProjectName,
  findComposeFile,
  resolveContainerRef,
  resolveProject,
} from '../src/project.ts'
import type { ContainerRow, ProjectContext } from '../src/types.ts'

const COMPOSE_FILES = ['docker-compose.yml', 'compose.yaml']

/** An in-memory probe over a fixture directory tree. */
function probeFor(tree: Record<string, true>): (path: string) => boolean {
  return (path) => tree[path] === true
}

function row(partial: Partial<ContainerRow> & Pick<ContainerRow, 'id' | 'name'>): ContainerRow {
  return { image: 'alpine', state: 'running', status: 'Up', ports: [], ...partial }
}

test('project: composeProjectName lowercases the directory basename', () => {
  assert.equal(composeProjectName('MyStack'), 'mystack')
  assert.equal(composeProjectName('dev'), 'dev')
})

test('project: findComposeFile walks up in config order', () => {
  const probe = probeFor({ '/a/b/docker-compose.yml': true, '/a/compose.yaml': true })
  assert.equal(findComposeFile('/a/b/c', COMPOSE_FILES, probe), '/a/b/docker-compose.yml')
  // The order within one directory decides the winner.
  const probe2 = probeFor({ '/a/b/compose.yaml': true, '/a/b/docker-compose.yml': true })
  assert.equal(findComposeFile('/a/b/c', ['compose.yaml', 'docker-compose.yml'], probe2), '/a/b/compose.yaml')
})

test('project: findComposeFile returns undefined when no ancestor has one', () => {
  assert.equal(findComposeFile('/a/b/c', COMPOSE_FILES, probeFor({})), undefined)
})

test('project: findComposeFile stops at the filesystem root', () => {
  const probe = probeFor({ '/docker-compose.yml': true })
  assert.equal(findComposeFile('/a/b', COMPOSE_FILES, probe), '/docker-compose.yml')
})

test('project: resolveProject derives the project name from the compose file directory', () => {
  const tree = { '/work/bingo/docker-compose.yml': true }
  const project = resolveProject('/work/bingo', COMPOSE_FILES, probeFor(tree))
  assert.deepEqual(project, { file: '/work/bingo/docker-compose.yml', project: 'bingo', cwd: '/work/bingo' })
})

test('project: resolveProject honors an explicit project override and skips detection', () => {
  const project = resolveProject('/nowhere', COMPOSE_FILES, probeFor({}), 'explicit-stack')
  assert.deepEqual(project, { file: '', project: 'explicit-stack', cwd: '/nowhere' })
})

test('project: resolveProject returns undefined with no file and no override', () => {
  assert.equal(resolveProject('/nowhere', COMPOSE_FILES, probeFor({})), undefined)
})

test('project: compose.yaml is discovered (config-ordered)', () => {
  const tree = { '/work/app/compose.yaml': true }
  const project = resolveProject('/work/app', ['docker-compose.yml', 'compose.yaml'], probeFor(tree))
  assert.equal(project?.project, 'app')
  assert.equal(project?.file, '/work/app/compose.yaml')
})

test('project: resolveContainerRef resolves a project-scoped service name first', () => {
  const project: ProjectContext = { file: '/x/docker-compose.yml', project: 'bingo', cwd: '/x' }
  const containers = [
    row({ id: 'aaa', name: 'bingo-db-1', service: 'db', project: 'bingo' }),
    row({ id: 'bbb', name: 'db', service: 'other', project: 'other' }),
  ]
  const resolved = resolveContainerRef('db', project, containers)
  assert.ok(resolved.ok)
  if (resolved.ok) assert.equal(resolved.ref, 'bingo-db-1')
})

test('project: resolveContainerRef falls back to an unambiguous global match', () => {
  const containers = [row({ id: 'aaa', name: 'mybox', state: 'exited' })]
  const resolved = resolveContainerRef('mybox', undefined, containers)
  assert.ok(resolved.ok)
  if (resolved.ok) assert.equal(resolved.ref, 'mybox')
})

test('project: resolveContainerRef matches id prefixes', () => {
  const containers = [row({ id: '1a2b3c4d', name: 'box' })]
  const resolved = resolveContainerRef('1a2b', undefined, containers)
  assert.ok(resolved.ok)
  if (resolved.ok) assert.equal(resolved.ref, 'box')
})

test('project: resolveContainerRef rejects empty refs', () => {
  const result = resolveContainerRef('  ', undefined, [])
  assert.ok(!result.ok)
  if (!result.ok) assert.match(result.error, /non-empty/)
})

test('project: resolveContainerRef reports unknown refs', () => {
  const result = resolveContainerRef('nope', undefined, [row({ id: 'aaa', name: 'box' })])
  assert.ok(!result.ok)
  if (!result.ok) assert.match(result.error, /no container matches/)
})

test('project: resolveContainerRef reports ambiguity with candidates instead of guessing', () => {
  const containers = [
    row({ id: 'aaa', name: 'api', project: 'p1' }),
    row({ id: 'bbb', name: 'api', project: 'p2' }),
  ]
  const resolved = resolveContainerRef('api', undefined, containers)
  assert.ok(!resolved.ok)
  if (!resolved.ok) {
    assert.match(resolved.error, /ambiguous/)
    assert.match(resolved.error, /p1/)
    assert.match(resolved.error, /p2/)
  }
})

test('project: baseName handles trailing slashes', () => {
  assert.equal(baseName('/a/b/'), 'b')
  assert.equal(baseName('/a/b'), 'b')
  assert.equal(baseName('b'), 'b')
})
