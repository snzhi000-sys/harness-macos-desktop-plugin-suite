import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

async function install(paths, { channel = 'dev', name = 'clean-profile', profileId, productContent } = {}) {
  if (profileId) writeFileSync(join(paths.resourcesPath, 'profile-bootstrap', 'profile-id'), `${profileId}\n`)
  return installBundledProfile({
    channel,
    isPackaged: true,
    ...paths,
    extractArchive: async (_archive, destination) => {
      mkdirSync(join(destination, 'node_modules'), { recursive: true })
      writeFileSync(join(destination, 'package.json'), `${JSON.stringify({ name })}\n`)
      if (productContent) {
        mkdirSync(join(destination, 'node_modules', 'dsh-product', 'lib'), { recursive: true })
        writeFileSync(join(destination, 'node_modules', 'dsh-product', 'lib', 'index.js'), `${productContent}\n`)
      }
    },
  })
}

test('installs a clean bundled profile for a first launch', async () => {
  const paths = fixture()
  const installed = await install(paths)
  assert.equal(installed, true)
  assert.equal(JSON.parse(readFileSync(join(paths.userData, 'harness', 'profiles', 'web', 'package.json'), 'utf8')).name, 'clean-profile')
  assert.equal(readFileSync(join(paths.userData, 'harness', 'profiles', '.web-bundled-profile-id'), 'utf8').trim(), '0123456789abcdef')
})

test('does not extract a Dev profile when its bundled identifier matches', async () => {
  const paths = fixture()
  await install(paths)
  let extracted = false
  const installed = await installBundledProfile({ channel: 'dev', isPackaged: true, ...paths, extractArchive: async () => { extracted = true } })
  assert.equal(installed, false)
  assert.equal(extracted, false)
})

test('upgrades an existing Dev profile when its bundled identifier is absent', async () => {
  const paths = fixture()
  const profile = join(paths.userData, 'harness', 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), '{"name":"old-dev-profile"}\n')
  const installed = await install(paths, { name: 'new-dev-profile' })
  assert.equal(installed, true)
  assert.equal(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).name, 'new-dev-profile')
  assert.equal(existsSync(join(paths.userData, 'harness', 'profiles', 'web.previous-upgrade')), false)
})

test('upgrades a Dev profile when its bundled identifier changes', async () => {
  const paths = fixture()
  await install(paths, { name: 'old-dev-profile', profileId: '1111111111111111' })
  const installed = await install(paths, { name: 'new-dev-profile', profileId: '2222222222222222' })
  assert.equal(installed, true)
  assert.equal(JSON.parse(readFileSync(join(paths.userData, 'harness', 'profiles', 'web', 'package.json'), 'utf8')).name, 'new-dev-profile')
  assert.equal(readFileSync(join(paths.userData, 'harness', 'profiles', '.web-bundled-profile-id'), 'utf8').trim(), '2222222222222222')
})

test('preserves Dev credentials, sessions, and state while upgrading the profile', async () => {
  const paths = fixture()
  const harness = join(paths.userData, 'harness')
  const profile = join(harness, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), '{"name":"old-dev-profile"}\n')
  mkdirSync(join(harness, 'sessions'), { recursive: true })
  mkdirSync(join(harness, 'state'), { recursive: true })
  writeFileSync(join(harness, '.credentials.yaml'), 'secret-ref: preserved\n')
  writeFileSync(join(harness, 'sessions', 'session.jsonl'), 'preserved session\n')
  writeFileSync(join(harness, 'state', 'explorer.json'), '{"preserved":true}\n')

  await install(paths, { name: 'new-dev-profile' })

  assert.equal(readFileSync(join(harness, '.credentials.yaml'), 'utf8'), 'secret-ref: preserved\n')
  assert.equal(readFileSync(join(harness, 'sessions', 'session.jsonl'), 'utf8'), 'preserved session\n')
  assert.equal(readFileSync(join(harness, 'state', 'explorer.json'), 'utf8'), '{"preserved":true}\n')
})

test('keeps the old Dev profile when extraction or validation fails', async () => {
  const paths = fixture()
  const profile = join(paths.userData, 'harness', 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), '{"name":"old-dev-profile"}\n')
  await assert.rejects(() => installBundledProfile({
    channel: 'dev',
    isPackaged: true,
    ...paths,
    extractArchive: async (_archive, destination) => {
      writeFileSync(join(destination, 'package.json'), '{"name":"incomplete"}\n')
    },
  }), /incomplete/)
  assert.equal(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).name, 'old-dev-profile')
})

test('merges product packages into Stable while preserving user composition and plugins', async () => {
  const paths = fixture()
  const harness = join(paths.userData, 'harness')
  const profile = join(harness, 'profiles', 'web')
  mkdirSync(join(profile, 'node_modules', 'personal-plugin'), { recursive: true })
  mkdirSync(join(profile, 'node_modules', 'dsh-product', 'lib'), { recursive: true })
  mkdirSync(join(harness, 'sessions'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), '{"name":"stable-user-profile","dsh":{"profile":{"bundles":["personal-plugin"]}}}\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: personal-patch\n')
  writeFileSync(join(profile, 'node_modules', 'personal-plugin', 'index.js'), 'personal\n')
  writeFileSync(join(profile, 'node_modules', 'dsh-product', 'lib', 'index.js'), 'old product\n')
  writeFileSync(join(harness, '.credentials.yaml'), 'credential: preserved\n')
  writeFileSync(join(harness, 'sessions', 'one.jsonl'), 'session preserved\n')

  const installed = await install(paths, { channel: 'stable', productContent: 'new product' })

  assert.equal(installed, true)
  assert.equal(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).name, 'stable-user-profile')
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), '- id: personal-patch\n')
  assert.equal(readFileSync(join(profile, 'node_modules', 'personal-plugin', 'index.js'), 'utf8'), 'personal\n')
  assert.equal(readFileSync(join(profile, 'node_modules', 'dsh-product', 'lib', 'index.js'), 'utf8'), 'new product\n')
  assert.equal(readFileSync(join(harness, '.credentials.yaml'), 'utf8'), 'credential: preserved\n')
  assert.equal(readFileSync(join(harness, 'sessions', 'one.jsonl'), 'utf8'), 'session preserved\n')
  assert.equal(readFileSync(join(harness, 'profiles', '.web-bundled-profile-id'), 'utf8').trim(), '0123456789abcdef')
})

test('does not extract a Stable product profile when its bundled identifier matches', async () => {
  const paths = fixture()
  await install(paths, { channel: 'stable', productContent: 'current product' })
  let extracted = false
  const installed = await installBundledProfile({ channel: 'stable', isPackaged: true, ...paths, extractArchive: async () => { extracted = true } })
  assert.equal(installed, false)
  assert.equal(extracted, false)
})

test('does not install a bundled profile during source development', async () => {
  const paths = fixture()
  assert.equal(await installBundledProfile({ channel: 'dev', isPackaged: false, ...paths }), false)
})
