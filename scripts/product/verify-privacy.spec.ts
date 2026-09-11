import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const verifier = fileURLToPath(new URL('./verify-privacy.mjs', import.meta.url))
const repositories: string[] = []

function repository(files: Record<string, string>, ignore = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-privacy-test-'))
  repositories.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  if (ignore !== '') writeFileSync(join(root, '.gitignore'), ignore)
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

function verify(root: string) {
  return spawnSync(process.execPath, [verifier, root], { encoding: 'utf8' })
}

afterEach(() => {
  for (const root of repositories.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('product privacy verifier', () => {
  it('checks untracked non-ignored files that could be added to Git', () => {
    const root = repository({ 'notes/private.txt': `${homedir()}/private-build-path\n` })
    const result = verify(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('notes/private.txt: private-content-marker')
  })

  it('rejects tracked credential and private-key filenames', () => {
    const root = repository({ '.credentials.yaml': 'credential reference fixture\n', 'signing.key': 'fixture\n' })
    execFileSync('git', ['add', '-f', '.credentials.yaml', 'signing.key'], { cwd: root })
    const result = verify(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('.credentials.yaml: forbidden-state-file')
    expect(result.stderr).toContain('signing.key: forbidden-state-file')
  })

  it('does not inspect intentionally ignored local environment files', () => {
    const root = repository({ '.env': `${homedir()}/local-only\n`, 'README.md': 'public\n' }, '.env\n')
    execFileSync('git', ['add', 'README.md', '.gitignore'], { cwd: root })
    const result = verify(root)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('0 untracked non-ignored files')
  })
})
