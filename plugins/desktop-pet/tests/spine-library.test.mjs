import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectSpine, describeSpine } from '../src/spine-library.mjs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const atlas = '\npage.png\nsize: 64,64\nbody\n  xy: 0,0\n  size: 64,64\n'
const source = () => ({ skeleton: { spine: '4.2.43' }, skins: [{ attachments: { body: { body: {} } } }], animations: { idle: { bones: { root: { rotate: [{ value: 0 }, { time: 6, value: 0 }] } } }, a: { attachments: { default: { mouth: { mouth: {} } } } }, m: { bones: { mouth: { rotate: [{ value: 0 }] } } } } })
test('Spine distinguishes an empty export from a valid zero-duration pose', () => {
  const info = inspectSpine(source(), atlas)
  assert.deepEqual(info.emptyAnimations, ['a'])
  assert.equal(info.animations.find(a => a.name === 'm').timelines, 1)
  assert.equal(info.animations.find(a => a.name === 'idle').durationMs, 6000)
  assert.throws(() => inspectSpine({ ...source(), skeleton: { spine: '4.1.0' } }, atlas), /4.2/)
  assert.throws(() => inspectSpine(source(), atlas.replace('\nbody\n', '\nmissing\n')), /贴图引用缺失/)
  assert.equal(inspectSpine({ ...source(), ik: [{ name: 'arm' }], transform: [{ name: 'head' }] }, atlas).constraintOrderConflicts[0].names.length, 2)
})
test('Spine descriptor rejects configured empty mouth tracks and escaping atlas pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spine-descriptor-'))
  try {
    await writeFile(join(root, 'ske.json'), JSON.stringify(source())); await writeFile(join(root, 'tex.atlas'), atlas); await writeFile(join(root, 'page.png'), '')
    const model = { id: 'fixture', entry: join(root, 'ske.json'), atlas: 'tex.atlas', profile: { idle: 'idle', mouths: ['a', 'm'], neutralMouth: 'm', expressions: [], actions: {} } }
    await assert.rejects(describeSpine(model), /缺少有效关键帧：a/)
    model.profile.mouths = ['m']
    assert.equal((await describeSpine(model)).kind, 'spine')
    await writeFile(join(root, 'tex.atlas'), atlas.replace('page.png', '../outside.png'))
    await assert.rejects(describeSpine(model))
  } finally { await rm(root, { recursive: true, force: true }) }
})
