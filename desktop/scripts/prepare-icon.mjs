import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const buildDir = join(desktopDir, 'build')
const iconset = join(buildDir, 'icon.iconset')
const source = join(desktopDir, '..', 'apps', 'web', 'public', 'favicon.svg')
const scaledSvg = join(buildDir, 'icon-source.svg')
const masterPng = join(buildDir, 'icon-master.png')

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} exited ${String(result.status)}`)
}

mkdirSync(buildDir, { recursive: true })
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset)
const svg = readFileSync(source, 'utf8')
  .replace('width="50.000000" height="50.000000"', 'width="1024" height="1024"')
writeFileSync(scaledSvg, svg)
run('/usr/bin/sips', ['-s', 'format', 'png', scaledSvg, '--out', masterPng])

for (const size of [16, 32, 128, 256, 512]) {
  run('/usr/bin/sips', ['-z', String(size), String(size), masterPng, '--out', join(iconset, `icon_${String(size)}x${String(size)}.png`)])
  const retina = size * 2
  run('/usr/bin/sips', ['-z', String(retina), String(retina), masterPng, '--out', join(iconset, `icon_${String(size)}x${String(size)}@2x.png`)])
}
run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')])
rmSync(scaledSvg, { force: true })
rmSync(masterPng, { force: true })
console.log('desktop icon prepared')
