import { describe, expect, it } from 'vitest'
import {
  deleteUncommonPaths,
  renameUncommonPaths,
  toggleUncommonPath,
} from '../src/client/uncommon-paths.ts'

describe('Explorer uncommon path projection', () => {
  it('toggles files and folders independently', () => {
    const folder = { path: '/workspace/archive', isDir: true }
    const file = { path: '/workspace/notes.md', isDir: false }
    expect(toggleUncommonPath([], folder.path, folder.isDir)).toEqual([folder])
    expect(toggleUncommonPath([folder], file.path, file.isDir)).toEqual([folder, file])
    expect(toggleUncommonPath([folder, file], folder.path, folder.isDir)).toEqual([file])
  })

  it('migrates a renamed directory and all marked descendants', () => {
    expect(renameUncommonPaths([
      { path: '/workspace/old', isDir: true },
      { path: '/workspace/old/note.md', isDir: false },
      { path: '/workspace/other.md', isDir: false },
    ], '/workspace/old', '/workspace/archive')).toEqual([
      { path: '/workspace/archive', isDir: true },
      { path: '/workspace/archive/note.md', isDir: false },
      { path: '/workspace/other.md', isDir: false },
    ])
  })

  it('removes a deleted path and every marked descendant', () => {
    expect(deleteUncommonPaths([
      { path: '/workspace/archive', isDir: true },
      { path: '/workspace/archive/note.md', isDir: false },
      { path: '/workspace/other.md', isDir: false },
    ], '/workspace/archive')).toEqual([{ path: '/workspace/other.md', isDir: false }])
  })
})
