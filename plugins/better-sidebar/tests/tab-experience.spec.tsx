// @vitest-environment jsdom

import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TabBar, tabTooltip } from '../src/client/TabBar.tsx'
import type { SidebarTab } from '../src/client/state.ts'

const browser: SidebarTab = {
  id: 'browser:one',
  type: 'browser',
  title: 'example.com',
  path: 'https://example.com/',
}
const preview: SidebarTab = {
  id: 'preview:/work/docs/report.pdf',
  type: 'preview',
  title: 'report.pdf',
  path: '/work/docs/report.pdf',
  viewerId: 'pdf',
}

describe('multi-tab experience', () => {
  let host: HTMLDivElement
  let root: Root
  let scrollIntoView: ReturnType<typeof vi.fn>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
  })

  afterEach(() => {
    act(() => { root.unmount() })
    host.remove()
  })

  it('shows a Preview full path while leaving Browser labels unchanged', () => {
    expect(tabTooltip(preview)).toBe('/work/docs/report.pdf')
    expect(tabTooltip(browser)).toBe('example.com')
  })

  it('keeps an activated tab visible and closes it on middle click', () => {
    const onClose = vi.fn()
    act(() => {
      root.render(
        <TabBar
          paneId="pane:right"
          tabs={[browser, preview]}
          active={preview.id}
          onActivate={() => {}}
          onClose={onClose}
          onNewTab={() => {}}
          newTabOptions={[]}
          onDropTab={() => {}}
        />,
      )
    })

    const previewTab = host.querySelector<HTMLElement>(`[title="${preview.path}"]`)
    expect(previewTab).not.toBeNull()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })

    act(() => {
      previewTab!.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    })
    expect(onClose).toHaveBeenCalledWith(preview.id)
  })
})
