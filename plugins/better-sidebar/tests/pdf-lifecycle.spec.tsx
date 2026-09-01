// @vitest-environment jsdom

import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PdfView } from '../src/client/PdfView.tsx'

describe('PDF Preview resource lifecycle', () => {
  let host: HTMLDivElement
  let root: Root
  const createObjectURL = vi.fn(() => 'blob:http://localhost/report')
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
    })))
  })

  afterEach(() => {
    act(() => { root.unmount() })
    host.remove()
    vi.unstubAllGlobals()
  })

  it('revokes its Blob URL when the Preview unmounts', async () => {
    await act(async () => {
      root.render(<PdfView scope={{ sessionId: 's1', cwd: '/work' }} path="/work/report.pdf" title="report.pdf" />)
    })
    await vi.waitFor(() => {
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(host.querySelector('iframe')?.getAttribute('src')).toBe('blob:http://localhost/report')
    })

    act(() => { root.unmount() })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/report')
    root = createRoot(host)
  })
})
