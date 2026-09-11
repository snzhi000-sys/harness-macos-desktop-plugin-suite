/** Download a pinned, data-only local research collection; verify every Git blob and support resumption. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inspectModel } from '../src/model-library.mjs'
const research = resolve('../../desktop/.artifacts/desktop-pet-research-2026-09-08')
const output = resolve('../../desktop/.artifacts/desktop-pet-library')
const commit = '94ae3e5628226726af96c6b4bf0e1ce5c728e28e'
const source = `Eikanya/Live2d-model@${commit}`
const execute = promisify(execFile)
const rootTree = JSON.parse(await readFile(join(research, 'models-tree.json'), 'utf8')).tree
const galTree = JSON.parse(await readFile(join(research, 'models-galgame-tree.json'), 'utf8')).tree.map(item => ({ ...item, path: `galgame live2d/${item.path}` }))
const tree = new Map([...rootTree, ...galTree].map(item => [item.path, item]))
const entries = [...tree.keys()].filter(path => /BanG Dream!.*\.model\.json$|galgame live2d\/Fox Hime Zero\/.*\.model3\.json$|destiny_child_kr 天命之子\/(?:c000_(?:01|10|11|12|13|14|15|16)|c00[1-5789]_01)\/model\.json$/.test(path))
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
await mkdir(output, { recursive: true })
let bytesDownloaded = 0
async function obtain(path) {
  const item = tree.get(path)
  if (!item || item.type !== 'blob' || item.mode !== '100644') throw new Error(`索引缺少数据文件：${path}`)
  const target = join(output, 'sources', path)
  try { const bytes = await readFile(target); if (blob(bytes) === item.sha) return bytes } catch (error) { if (error.code !== 'ENOENT') throw error }
  let failure
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const host = attempt === 0 ? `https://cdn.jsdelivr.net/gh/Eikanya/Live2d-model@${commit}/` : `https://raw.githubusercontent.com/Eikanya/Live2d-model/${commit}/`
      const url = attempt === 1 ? `https://api.github.com/repos/Eikanya/Live2d-model/git/blobs/${item.sha}` : `${host}${path.split('/').map(encodeURIComponent).join('/')}`
      const { stdout } = await execute('/usr/bin/curl', ['--silent', '--show-error', '--fail', '--location', '--max-time', '25', url], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
      const bytes = attempt === 1 ? Buffer.from(JSON.parse(stdout.toString('utf8')).content, 'base64') : stdout
      if (blob(bytes) !== item.sha) throw new Error(`Git blob 校验失败：${path}`)
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); bytesDownloaded += bytes.length; return bytes
    } catch (error) { failure = error }
  }
  throw failure
}
const results = []
for (const entry of entries) {
  try {
    const data = JSON.parse((await obtain(entry)).toString('utf8'))
    const v4 = Boolean(data.FileReferences), refs = data.FileReferences ?? data
    const files = [v4 ? refs.Moc : refs.model, ...(v4 ? refs.Textures : refs.textures)]
    for (const key of v4 ? ['Physics', 'Pose', 'DisplayInfo', 'UserData'] : ['physics', 'pose']) if (refs[key]) files.push(refs[key])
    for (const group of Object.values(v4 ? refs.Motions ?? {} : refs.motions ?? {})) for (const motion of group) files.push(v4 ? motion.File : motion.file)
    for (const expression of v4 ? refs.Expressions ?? [] : refs.expressions ?? []) files.push(v4 ? expression.File : expression.file)
    const dependencies = [...new Set(files)]
    for (let start = 0; start < dependencies.length; start += 4) await Promise.all(dependencies.slice(start, start + 4).map(async file => {
      if (typeof file !== 'string' || !/\.(moc3?|png|jpe?g|webp|json|mtn)$/i.test(file) || posix.isAbsolute(file)) throw new Error('Unsupported data dependency')
      const path = posix.normalize(posix.join(posix.dirname(entry), file))
      if (!path.startsWith(`${posix.dirname(entry)}/`)) throw new Error('Escaping dependency')
      await obtain(path)
    }))
    const local = join(output, 'sources', entry), info = await inspectModel(local)
    const name = `${entry.split('/')[0]} · ${posix.basename(posix.dirname(entry))}`
    results.push({ entry: local, repositoryEntry: entry, name, source, status: 'checked', kind: info.kind, motions: info.motions.length, expressions: info.expressions.length })
    console.log(`已下载并检查 ${name}`)
  } catch (error) { results.push({ repositoryEntry: entry, status: 'failed', error: error.message }); console.error(entry, error.message) }
  await writeFile(join(output, 'download-result.json'), JSON.stringify({ source, bytesDownloaded, results }, null, 2))
}
console.log(`完成：${results.filter(item => item.status === 'checked').length}/${entries.length}；新增 ${(bytesDownloaded / 1048576).toFixed(1)} MiB`)
