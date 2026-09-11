import { build } from 'esbuild'
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises'
const { builtinLibrary } = await import('../src/builtin-library.mjs')
const library = builtinLibrary()
for (const model of library.list()) { await library.describe(model.id); await library.asset(model.id, 'preview.png') }
await mkdir('dist', { recursive: true })
await rm('dist/client.js.map', { force: true })
// Harness loads plugin bundles as classic scripts and materializes their CJS factory lazily.
const client = await build({ entryPoints: ['src/client.mjs'], bundle: true, format: 'cjs', platform: 'browser', target: 'chrome120', write: false })
await writeFile('dist/client.js', `globalThis.__ModuleLoader__.load({id:"dsh-desktop-pet",factory:function(require){var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`)
for (const entry of ['view', 'chat', 'live2d', 'live2d2', 'dragonbones', 'spine']) {
  await build({ entryPoints: [`src/${entry}.mjs`], outfile: `dist/${entry}.js`, bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', sourcemap: true })
}
await copyFile('src/view.html', 'dist/view.html')
await copyFile('src/chat.html', 'dist/chat.html')
await copyFile('src/recorder-worklet.js', 'dist/recorder-worklet.js')
