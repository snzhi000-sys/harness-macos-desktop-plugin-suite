import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installBundledProfile } from '../src/profile-bootstrap.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-bootstrap-'))
  const resourcesPath = join(root, 'resources')
  const bootstrap = join(resourcesPath, 'profile-bootstrap')
  const userData = join(root, 'user-data')
  mkdirSync(bootstrap, { recursive: true })
  writeFileSync(join(bootstrap, 'profile-id'), '0123456789abcdef\n')
  writeFileSync(join(bootstrap, 'profile.tar.gz'), 'fixture')
  return { resourcesPath, userData }
}

test('installs a clean bundled profile for a first launch', async () => {
  const paths = fixture()
  const installed = await installBundledProfile({
    isPackaged: true,
    ...paths,
    extractArchive: async (_archive, destination) => {
      mkdirSync(join(destination, 'node_modules'), { recursive: true })
      writeFileSync(join(destination, 'package.json'), '{"name":"clean-profile"}\n')
    },
  })
  assert.equal(installed, true)
  assert.equal(JSON.parse(readFileSync(join(paths.userData, 'harness', 'profiles', 'web', 'package.json'), 'utf8')).name, 'clean-profile')
})

test('never overwrites an existing user profile', async () => {
  const paths = fixture()
  const profile = join(paths.userData, 'harness', 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), '{"name":"user-profile"}\n')
  let extracted = false
  const installed = await installBundledProfile({ isPackaged: true, ...paths, extractArchive: async () => { extracted = true } })
  assert.equal(installed, false)
  assert.equal(extracted, false)
  assert.equal(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).name, 'user-profile')
})

test('does not install a bundled profile during source development', async () => {
  const paths = fixture()
  assert.equal(await installBundledProfile({ isPackaged: false, ...paths }), false)
})
