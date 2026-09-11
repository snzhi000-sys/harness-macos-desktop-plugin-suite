/** Inspect and import data-only model dependencies; downloaded web scripts never become executable assets. */
import { readFile, realpath, readdir, mkdir, copyFile, rename, writeFile, rm } from 'node:fs/promises'
import { dirname, basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

/** Reject references outside the user-selected model root, including symlinks. */
export async function containedAsset(root, child) {
  const actualRoot = await realpath(root)
  const target = await realpath(resolve(actualRoot, child))
  const path = relative(actualRoot, target)
  if (path === '..' || path.startsWith('../') || isAbsolute(path)) throw new Error('模型资源超出所选目录')
  return target
}

/** Identify model JSON by its contents; legacy files need not have a .model.json suffix. */
export function modelKind(data) {
  if (typeof data?.FileReferences?.Moc === 'string' && Array.isArray(data.FileReferences.Textures)) return 'cubism4'
  if (typeof data?.model === 'string' && Array.isArray(data.textures)) return 'cubism2'
  return null
}

/** Resolve and inspect the dependencies referenced by one model entry. */
export async function inspectModel(entry) {
  if (typeof entry !== 'string' || !isAbsolute(entry)) throw new Error('请选择本地模型入口')
  const data = JSON.parse(await readFile(entry, 'utf8'))
  const kind = modelKind(data)
  if (!kind) throw new Error('不是可识别的 Live2D 模型入口')
  const v4 = kind === 'cubism4'
  const refs = v4 ? data.FileReferences : data
  const dependencies = [v4 ? refs.Moc : refs.model, ...(v4 ? refs.Textures : refs.textures)]
  for (const key of v4 ? ['Physics', 'Pose', 'DisplayInfo', 'UserData'] : ['physics', 'pose']) if (refs[key]) dependencies.push(refs[key])
  const motions = []
  const parameterIds = new Set()
  for (const [group, values] of Object.entries(v4 ? refs.Motions ?? {} : refs.motions ?? {})) {
    if (!Array.isArray(values)) throw new Error(`动作组无效：${group}`)
    for (const [index, value] of values.entries()) {
      const file = v4 ? value.File : value.file
      dependencies.push(file)
      const content = await readFile(await containedAsset(dirname(entry), file), 'utf8')
      let durationMs = 0
      let loop = false
      if (v4) { const motion = JSON.parse(content); durationMs = Math.round(motion.Meta.Duration * 1000); loop = Boolean(motion.Meta.Loop); for (const curve of motion.Curves ?? []) if (curve.Target === 'Parameter') parameterIds.add(curve.Id) }
      else {
        const fps = Number(content.match(/\$fps\s*=\s*([\d.]+)/)?.[1] ?? 30)
        const lengths = content.split(/\r?\n/).filter(line => /^[A-Z][A-Z0-9_]*=/.test(line)).map(line => line.slice(line.indexOf('=') + 1).split(',').length)
        for (const line of content.split(/\r?\n/)) if (/^[A-Z][A-Z0-9_]*=/.test(line)) parameterIds.add(line.slice(0, line.indexOf('=')))
        durationMs = Math.round(Math.max(1, ...lengths) / fps * 1000)
      }
      if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 3600000) throw new Error(`动作时长无效：${file}`)
      motions.push({ group, index, file, durationMs, loop })
    }
  }
  const expressions = (v4 ? refs.Expressions ?? [] : refs.expressions ?? []).map(item => ({ name: v4 ? item.Name : item.name, file: v4 ? item.File : item.file }))
  dependencies.push(...expressions.map(item => item.file))
  for (const child of dependencies) {
    if (typeof child !== 'string' || !/\.(moc3?|png|jpe?g|webp|json|mtn)$/i.test(child)) throw new Error(`不支持的模型依赖：${child}`)
    await containedAsset(dirname(entry), child)
  }
  return { kind, name: data.Name ?? data.name ?? basename(entry).replace(/(?:\.model3?)?\.json$/i, ''), entry, data, dependencies: [...new Set(dependencies)], motions, expressions, parameterIds: [...parameterIds].sort(), hitAreas: v4 ? data.HitAreas ?? [] : data.hit_areas ?? [], customAreas: data.hit_areas_custom ?? null, physics: Boolean(v4 ? refs.Physics : refs.physics), pose: Boolean(v4 ? refs.Pose : refs.pose) }
}

/** Discover candidate entries without executing scripts or following directory symlinks. */
export async function discoverModels(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('请选择本地模型目录')
  const found = []
  let visited = 0
  const walk = async (dir, depth) => {
    if (depth > 7) return
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (++visited > 10000) throw new Error('目录过大，请选择具体角色目录')
      const path = join(dir, item.name)
      if (item.isDirectory()) await walk(path, depth + 1)
      else if (item.isFile() && extname(path).toLowerCase() === '.json') {
        let data
        try { data = JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error instanceof SyntaxError) continue; throw error }
        const kind = modelKind(data)
        if (kind) found.push({ entry: path, kind, name: data.Name ?? data.name ?? basename(dir) })
      }
    }
  }
  await walk(directory, 0)
  if (!found.length) throw new Error('目录中没有找到 Live2D 模型')
  return found
}

/** Persist imported, self-contained models; settings remain per model and are updated atomically. */
export function createModelLibrary(root) {
  const index = join(root, 'models.json')
  let mutation = Promise.resolve()
  const list = async () => {
    try {
      const value = JSON.parse(await readFile(index, 'utf8'))
      if (value.version !== 1 || !Array.isArray(value.models)) throw new Error('模型库格式无效')
      return value.models
    } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  const save = async models => {
    await mkdir(root, { recursive: true })
    const temp = `${index}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify({ version: 1, models }, null, 2), { mode: 0o600 })
    await rename(temp, index)
  }
  const serial = operation => { const result = mutation.then(operation); mutation = result.catch(() => {}); return result }
  return {
    list,
    async get(id) { const model = (await list()).find(item => item.id === id); if (!model) throw new Error('模型不存在，请重新选择'); return model },
    import(entry, name, source = '') { return serial(async () => {
      const info = await inspectModel(entry)
      const digest = createHash('sha256').update(JSON.stringify(info.data))
      for (const file of [...info.dependencies].sort()) digest.update(file).update(await readFile(await containedAsset(dirname(entry), file)))
      const fingerprint = digest.digest('hex')
      const existing = (await list()).find(item => item.fingerprint === fingerprint)
      if (existing) return { ...existing, duplicate: true }
      const id = randomUUID()
      const directory = join(root, 'models', id)
      await mkdir(directory, { recursive: true })
      try {
        for (const file of info.dependencies) { const target = join(directory, file); await mkdir(dirname(target), { recursive: true }); await copyFile(await containedAsset(dirname(entry), file), target) }
        // Viewer-specific scheduling is represented by our profile; malformed optional group IDs are omitted.
        const data = structuredClone(info.data)
        if (info.kind === 'cubism4') data.Groups = (data.Groups ?? []).filter(group => Array.isArray(group.Ids))
        const target = join(directory, info.kind === 'cubism4' ? 'entry.model3.json' : 'entry.model.json')
        await writeFile(target, JSON.stringify(data, null, 2))
        const model = { id, name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : info.name, kind: info.kind, entry: target, source: String(source).slice(0, 2000), fingerprint, capabilities: { motions: info.motions.length, expressions: info.expressions.length, physics: info.physics }, importedAt: new Date().toISOString(), profile: null }
        await writeFile(join(directory, 'SOURCE.json'), JSON.stringify({ source: model.source, originalEntry: entry, importedAt: model.importedAt }, null, 2))
        await save([...(await list()), model])
        return model
      } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
    }) },
    updateProfile(id, profile) { return serial(async () => { const models = await list(); const model = models.find(item => item.id === id); if (!model) throw new Error('模型不存在'); model.profile = profile; await save(models); return model }) },
    savePreview(id, png) { return serial(async () => {
      if (typeof png !== 'string' || png.length > 2800000 || !png.startsWith('data:image/png;base64,')) throw new Error('预览图片无效')
      const bytes = Buffer.from(png.slice(22), 'base64')
      if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('需要 PNG 预览')
      const models = await list(), model = models.find(item => item.id === id)
      if (!model) throw new Error('模型不存在')
      const path = join(dirname(model.entry), 'preview.png')
      await writeFile(`${path}.tmp`, bytes); await rename(`${path}.tmp`, path)
      model.previewAt = new Date().toISOString(); await save(models); return model
    }) },
  }
}

/** Inspect each candidate independently; incomplete assets remain visible with their own failure. */
export async function checkModels(entries) {
  if (!Array.isArray(entries) || entries.length > 200 || entries.some(entry => typeof entry !== 'string')) throw new Error('每批最多检查 200 个模型入口')
  const results = []
  for (const entry of entries) {
    try { const info = await inspectModel(entry); results.push({ entry, status: 'ready', kind: info.kind, motions: info.motions.length, expressions: info.expressions.length, physics: info.physics }) }
    catch (error) { results.push({ entry, status: 'failed', error: error.message }) }
  }
  return results
}
