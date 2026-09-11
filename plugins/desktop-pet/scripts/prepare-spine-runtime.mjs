/** Install the unmodified, checksum-pinned official Spine 4.2 distribution and its license. */
import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const url = 'https://registry.npmjs.org/@esotericsoftware/spine-webgl/-/spine-webgl-4.2.120.tgz'
const digest = 'd1cfacd523602524ed497c8b794cd394a52cc8118cf6a680b4542585e1f36666'
const bytes = process.argv[2] ? await readFile(process.argv[2]) : await fetch(url, { signal: AbortSignal.timeout(30000) }).then(async r => { if (!r.ok) throw new Error(`Spine download ${r.status}`); return Buffer.from(await r.arrayBuffer()) })
if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Spine package checksum mismatch')
const temp = await mkdtemp(join(tmpdir(), 'spine-runtime-'))
try {
  await writeFile(join(temp, 'runtime.tgz'), bytes)
  execFileSync('tar', ['-xzf', join(temp, 'runtime.tgz'), '-C', temp, 'package/dist/iife/spine-webgl.js', 'package/LICENSE'])
  await mkdir('assets/cores', { recursive: true })
  await copyFile(join(temp, 'package/dist/iife/spine-webgl.js'), 'assets/cores/spine-webgl.js')
  await copyFile(join(temp, 'package/LICENSE'), 'assets/cores/spine-LICENSE.txt')
  await writeFile('assets/cores/spine-SOURCE.json', JSON.stringify({ version: '4.2.120', url, sha256: digest }, null, 2) + '\n')
} finally { await rm(temp, { recursive: true, force: true }) }
