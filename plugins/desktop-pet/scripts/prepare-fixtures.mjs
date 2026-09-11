/** Download official SDK test assets to an ignored local directory, never into the plugin package. */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
const target = resolve('../../desktop/.artifacts/desktop-pet-fixtures')
const base = 'https://raw.githubusercontent.com/Live2D/CubismWebSamples/4-r.7/'
async function download(url, path) {
  try { if ((await readFile(path)).length > 0) return } catch (error) { if (error.code !== 'ENOENT') throw error }
  console.log(`Downloading ${url.split('/').at(-1)}`)
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`Fixture download failed: ${response.status} ${url}`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.from(await response.arrayBuffer()))
}
await download(`${base}LICENSE.md`, join(target, 'LICENSE.md'))
await download('https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html', join(target, 'free-material-license.html'))
await download('https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html', join(target, 'core-license.html'))
await download('https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js', join(target, 'live2dcubismcore.min.js'))
const model = join(target, 'Haru', 'Haru.model3.json')
await download(`${base}Samples/Resources/Haru/Haru.model3.json`, model)
const json = JSON.parse(await readFile(model, 'utf8'))
const refs = json.FileReferences
const files = [refs.Moc, refs.Physics, refs.Pose, refs.DisplayInfo, refs.UserData, ...refs.Textures, ...refs.Expressions.map(item => item.File), ...Object.values(refs.Motions).flat().map(item => item.File)].filter(Boolean)
for (const file of files) await download(`${base}Samples/Resources/Haru/${file}`, join(target, 'Haru', file))
await writeFile(join(target, 'ATTRIBUTION.txt'), 'Haru © Live2D Inc. Official CubismWebSamples 4-r.7. Local development verification only; assets and Core are not included in the plugin package. Voice files are not downloaded or played. See LICENSE.md and accompanying agreements.\n')
console.log(`Prepared official Cubism test fixtures: ${target}`)
