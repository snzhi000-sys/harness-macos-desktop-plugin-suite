// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileReferenceChip, parseFileReferenceRuns,
} from '../src/client/chat/FileReferenceProjection.tsx'

afterEach(cleanup)

describe('logged file reference projection', () => {
  it('parses adjacent legacy and v2 references without exposing injected line bodies', () => {
    const text = [
      '请看 ',
      '<file-reference path="legacy.md"/> ',
      '<file-reference version="2" kind="file" mode="lines" path="src/a.ts" start="5" end="12">',
      '<![CDATA[\n5| const marker = "</file-reference>";\n]]>',
      '</file-reference> 后续',
    ].join('')
    const runs = parseFileReferenceRuns(text)
    expect(runs.filter(run => run.kind === 'reference').map(run => (
      run.kind === 'reference' ? run.reference : null
    ))).toEqual([
      expect.objectContaining({ name: 'legacy.md', mode: 'path', kind: 'file' }),
      expect.objectContaining({ name: 'a.ts', mode: 'lines', start: 5, end: 12 }),
    ])
    expect(runs.map(run => run.kind === 'text' ? run.text : '').join('')).toBe('请看   后续')
  })

  it('decodes escaped attributes and leaves malformed containers untouched', () => {
    const escaped = parseFileReferenceRuns('<file-reference version="2" kind="folder" mode="path" path="a&amp;b&quot;c"/>')
    expect(escaped[0]).toEqual({
      kind: 'reference',
      reference: expect.objectContaining({ path: 'a&b"c', name: 'a&b"c', kind: 'folder' }),
    })
    const malformed = '<file-reference path="a.ts">missing close'
    expect(parseFileReferenceRuns(malformed)).toEqual([{ kind: 'text', text: malformed }])
  })

  it('renders file, folder, and line chips as non-interactive content', () => {
    const view = render(<div>
      <FileReferenceChip reference={{ path: 'a.ts', name: 'a.ts', kind: 'file', mode: 'path' }} />
      <FileReferenceChip reference={{ path: 'src', name: 'src', kind: 'folder', mode: 'path' }} />
      <FileReferenceChip reference={{
        path: '很长的文件名称用于验证超过二十个汉字以后省略.md',
        name: '很长的文件名称用于验证超过二十个汉字以后省略.md',
        kind: 'file', mode: 'lines', start: 5, end: 12,
      }} />
    </div>)
    expect(view.container.querySelectorAll('[data-file-reference-chip]')).toHaveLength(3)
    expect(view.container.querySelector('[data-file-reference-kind="folder"] svg')).toBeTruthy()
    expect(view.getByText('5–12')).toBeTruthy()
    expect(view.container.querySelector('[data-file-reference-chip="lines"] svg')).toBeNull()
    expect(view.container.querySelector('button')).toBeNull()
    const longName = view.getByText('很长的文件名称用于验证超过二十个汉字以后省略.md')
    expect(longName.className).toContain('fileReferenceName')
  })
})
