import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { scanReleaseTree } from '../src/release-privacy.mjs'

function fixture() {
  return mkdtempSync(join(tmpdir(), 'dsh-release-privacy-test-'))
}

test('release privacy rejects personal build paths and state files', () => {
  const root = fixture()
  try {
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'nested', 'client.js'), 'source: /Users/build-user/private/project\n')
    writeFileSync(join(root, '.credentials.yaml'), 'fixture\n')

    const violations = scanReleaseTree(root, { markers: ['/Users/build-user'] })
    assert.deepEqual(violations, [
      ['release/.credentials.yaml', 'forbidden-state-file'],
      ['release/nested/client.js', 'private-content-marker'],
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('release privacy rejects absolute symlinks', () => {
  const root = fixture()
  try {
    symlinkSync('/private/build-output', join(root, 'runtime-link'))
    assert.deepEqual(scanReleaseTree(root, { markers: [] }), [
      ['release/runtime-link', 'absolute-symlink'],
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('release privacy accepts relative links and public text', () => {
  const root = fixture()
  try {
    writeFileSync(join(root, 'README.md'), 'public release\n')
    symlinkSync('README.md', join(root, 'readme-link'))
    assert.deepEqual(scanReleaseTree(root, { markers: ['/Users/build-user'] }), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
