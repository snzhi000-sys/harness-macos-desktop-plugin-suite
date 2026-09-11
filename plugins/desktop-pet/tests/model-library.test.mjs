import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rename, rm, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverModels, inspectModel, createModelLibrary, checkModels } from '../src/model-library.mjs'
import { suggestedProfile, validateProfile } from '../src/character-profile.mjs'

test('legacy entry discovery, empty-group actions and imported dependencies survive source movement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pet-import-')), source = join(root, 'source')
  try {
    await mkdir(source)
    await writeFile(join(source, 'model.moc'), 'fixture moc')
    await writeFile(join(source, 'texture.png'), 'fixture texture')
    await writeFile(join(source, 'IDLING_01.mtn'), '$fps=30\nPARAM_ANGLE_X=0,1,2\n')
    await writeFile(join(source, 'unsafe.js'), 'throw new Error("must not import")')
    await writeFile(join(source, 'rem.json'), JSON.stringify({ model: 'model.moc', textures: ['texture.png'], motions: { '': [{ file: 'IDLING_01.mtn' }] } }))
    const [candidate] = await discoverModels(source)
    assert.equal(candidate.entry, join(source, 'rem.json'))
    const info = await inspectModel(candidate.entry)
    assert.deepEqual(info.motions[0], { group: '', index: 0, file: 'IDLING_01.mtn', durationMs: 100, loop: false })
    const profile = suggestedProfile(info)
    assert.deepEqual(profile.actions.idle.motions, [{ group: '', index: 0 }])
    assert.equal(validateProfile(profile, info).version, 1)
    const library = createModelLibrary(join(root, 'state'))
    const imports = await Promise.all([library.import(candidate.entry, 'A'), library.import(candidate.entry, 'B')])
    assert.equal((await library.list()).length, 1)
    assert.equal(imports[0].id, imports[1].id)
    assert.equal(imports[1].duplicate, true)
    const checks = await checkModels([candidate.entry, join(source, 'missing.json')])
    assert.equal(checks[0].status, 'ready'); assert.equal(checks[1].status, 'failed')
    await library.updateProfile(imports[0].id, profile)
    assert.deepEqual((await library.import(candidate.entry)).profile, profile)
    await assert.rejects(library.savePreview(imports[0].id, 'data:image/png;base64,bm90IHBuZw=='), /PNG/)
    await rename(source, join(root, 'moved'))
    const stored = await createModelLibrary(join(root, 'state')).get(imports[0].id)
    assert.equal((await inspectModel(stored.entry)).kind, 'cubism2')
    assert.deepEqual(stored.profile.actions.idle.motions, [{ group: '', index: 0 }])
    await assert.rejects(readFile(join(stored.entry, '..', 'unsafe.js')), { code: 'ENOENT' })
    profile.actions.touch.motions = [{ group: '', index: 99 }]
    assert.throws(() => validateProfile(profile, info), /动作不存在/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('import rejects missing dependencies and symlink escapes without registering partial models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pet-import-invalid-')), source = join(root, 'source')
  try {
    await mkdir(source); await writeFile(join(root, 'outside.moc'), 'outside')
    await symlink(join(root, 'outside.moc'), join(source, 'model.moc'))
    const entry = join(source, 'entry.json')
    await writeFile(entry, JSON.stringify({ model: 'model.moc', textures: [] }))
    const library = createModelLibrary(join(root, 'state'))
    await assert.rejects(library.import(entry), /超出所选目录/)
    assert.deepEqual(await library.list(), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
