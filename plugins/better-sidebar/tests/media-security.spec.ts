import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { mediaSecurityHeaders, resolveWorkspaceMediaPath } from '../src/index.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Preview media workspace boundary', () => {
  it('sandboxes SVG bytes and prevents MIME sniffing for every media type', () => {
    expect(mediaSecurityHeaders('image/svg+xml')).toMatchObject({
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'content-security-policy': expect.stringContaining('sandbox'),
    })
    expect(mediaSecurityHeaders('application/pdf')).toMatchObject({
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    })
    expect(mediaSecurityHeaders('application/pdf')).not.toHaveProperty('content-security-policy')
  })

  it('accepts real files inside the workspace', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-media-boundary-'))
    directories.push(directory)
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace)
    const file = join(workspace, 'photo.png')
    writeFileSync(file, 'png')
    await expect(resolveWorkspaceMediaPath(workspace, file)).resolves.toMatchObject({ path: realpathSync(file), size: 3 })
  })

  it('rejects lexical outside paths and symlinks that resolve outside', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-media-boundary-'))
    directories.push(directory)
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace)
    const secret = join(directory, 'secret.svg')
    writeFileSync(secret, '<svg><script>top.steal()</script></svg>')
    await expect(resolveWorkspaceMediaPath(workspace, secret)).rejects.toMatchObject({ status: 403 })

    const escape = join(workspace, 'escape.svg')
    symlinkSync(secret, escape)
    await expect(resolveWorkspaceMediaPath(workspace, escape)).rejects.toMatchObject({ status: 403 })
  })
})
