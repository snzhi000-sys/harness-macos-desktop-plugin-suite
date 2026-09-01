#!/usr/bin/env node
/**
 * Build the client bundle: src/client/index.ts → lib/client.js, in the
 * DSH web-module format — a single file that registers its factory with
 * `window.__ModuleLoader__.load({ id, factory })`. External packages
 * (`react`, every `@deepseek-ai/*`) stay external and resolve through the
 * shell's module loader at runtime. `pnpm build` runs tsc first, then this.
 */
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

await build({
  entryPoints: [join(root, 'src/client/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
  outfile: join(root, 'lib/client.js'),
  sourcemap: true,
  banner: { js: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},\n\tfactory: (require) => {` },
  footer: { js: '\n\t\treturn module.exports;\n\t}\n});' },
  logLevel: 'info',
})
