import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openPathWithSystemApp, revealPathInFileManager } from '../src/reveal-path.ts'

describe('Explorer system file-manager reveal', () => {
  it('passes files and folders to Finder as one injection-safe argument', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-reveal-'))
    try {
      const folder = join(root, '中文 folder')
      const file = join(folder, 'a "quoted" file.md')
      mkdirSync(folder)
      writeFileSync(file, 'content')
      const launch = vi.fn(async () => {})

      await revealPathInFileManager(root, file, { platform: 'darwin', launch })
      await revealPathInFileManager(root, folder, { platform: 'darwin', launch })

      expect(launch).toHaveBeenNthCalledWith(1, '/usr/bin/open', ['-R', file])
      expect(launch).toHaveBeenNthCalledWith(2, '/usr/bin/open', ['-R', folder])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('allows the workspace root but rejects outside and missing targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-reveal-root-'))
    try {
      const launch = vi.fn(async () => {})
      await revealPathInFileManager(root, root, { platform: 'darwin', launch })
      expect(launch).toHaveBeenCalledWith('/usr/bin/open', ['-R', root])

      await expect(revealPathInFileManager(root, dirname(root), { platform: 'darwin', launch }))
        .rejects.toMatchObject({ code: 'forbidden', status: 403 })
      await expect(revealPathInFileManager(root, join(root, 'missing.txt'), { platform: 'darwin', launch }))
        .rejects.toMatchObject({ code: 'fs-error', status: 400 })
      expect(launch).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports unsupported platforms and Finder launch failures without fallback commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-reveal-error-'))
    try {
      const unsupportedLaunch = vi.fn(async () => {})
      await expect(revealPathInFileManager(root, root, { platform: 'linux', launch: unsupportedLaunch }))
        .rejects.toMatchObject({ code: 'unsupported-platform', status: 501 })
      expect(unsupportedLaunch).not.toHaveBeenCalled()

      const failedLaunch = vi.fn(async () => { throw new Error('Finder unavailable') })
      await expect(revealPathInFileManager(root, root, { platform: 'darwin', launch: failedLaunch }))
        .rejects.toMatchObject({ code: 'fs-error', status: 500 })
      expect(failedLaunch).toHaveBeenCalledWith('/usr/bin/open', ['-R', root])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('opens a workspace file in the default app without shell interpolation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-system-open-'))
    try {
      const file = join(root, 'movie with spaces.mp4')
      writeFileSync(file, 'video')
      const launch = vi.fn(async () => {})
      await openPathWithSystemApp(root, file, { platform: 'darwin', launch })
      expect(launch).toHaveBeenCalledWith('/usr/bin/open', [file])
      await expect(openPathWithSystemApp(root, dirname(root), { platform: 'darwin', launch }))
        .rejects.toMatchObject({ code: 'forbidden', status: 403 })
      expect(launch).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a system-open symlink that escapes the workspace realpath', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-system-open-link-'))
    const outside = mkdtempSync(join(tmpdir(), 'dsh-sidebar-system-open-outside-'))
    try {
      const outsideFile = join(outside, 'outside.mp4')
      const link = join(root, 'linked.mp4')
      writeFileSync(outsideFile, 'video')
      symlinkSync(outsideFile, link)
      const launch = vi.fn(async () => {})
      await expect(openPathWithSystemApp(root, link, { platform: 'darwin', launch }))
        .rejects.toMatchObject({ code: 'forbidden', status: 403 })
      expect(launch).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
