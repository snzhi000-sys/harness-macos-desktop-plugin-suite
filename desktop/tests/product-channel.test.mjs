import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { desktopPetEnabled, productProfile } from '../product-channel.cjs'

const manifest = JSON.parse(readFileSync(new URL('../../distribution/profile-manifest.json', import.meta.url)))
test('Stable and Dev include Desktop Pet without changing the source selection', () => {
  const before = JSON.stringify(manifest)
  const stable = productProfile(manifest, 'stable')
  assert.equal(stable.requiredRuntimePlugins.length, 7)
  assert.equal(JSON.stringify(stable).includes('dsh-desktop-pet'), true)
  assert.deepEqual(stable, manifest)
  assert.deepEqual(productProfile(manifest, 'dev'), manifest)
  assert.equal(JSON.stringify(manifest), before)
  assert.equal(desktopPetEnabled('stable'), true)
  assert.equal(desktopPetEnabled('dev'), true)
  assert.throws(() => desktopPetEnabled('unknown'))
})

test('Preload exposes pet IPC only to a pet-enabled window', () => {
  const code = readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8')
  for (const enabled of [false, true]) {
    let bridge
    runInNewContext(code, {
      process: { argv: enabled ? ['--dsh-desktop-pet'] : [] },
      require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value } }, ipcRenderer: { invoke: (_channel, value) => value } }),
    })
    assert.equal(typeof bridge.setWindowChrome, 'function')
    assert.equal(typeof bridge.petCommand, enabled ? 'function' : 'undefined')
    if (enabled) assert.equal(bridge.petCommand('probe'), 'probe')
  }
})
