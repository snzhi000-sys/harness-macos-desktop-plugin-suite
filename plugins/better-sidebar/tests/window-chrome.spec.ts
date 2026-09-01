// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { registerWindowChrome, WINDOW_TITLE } from '../src/client/window-chrome.ts'

describe('registerWindowChrome', () => {
  let dispose: (() => void) | undefined

  beforeEach(() => {
    document.title = 'Task — DeepSeek Harness'
    document.head.querySelectorAll('meta[name="theme-color"]').forEach(node => { node.remove() })
    document.body.style.backgroundColor = 'rgb(255, 255, 255)'
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    document.body.removeAttribute('style')
    document.body.removeAttribute('data-ds-dark-theme')
    document.head.querySelectorAll('meta[name="theme-color"]').forEach(node => { node.remove() })
    delete window.harnessDesktop
  })

  it('keeps the native window title independent from task switches', async () => {
    dispose = registerWindowChrome()
    expect(document.title).toBe(WINDOW_TITLE)
    document.title = 'Another task — DeepSeek Harness'
    await Promise.resolve()
    expect(document.title).toBe(WINDOW_TITLE)
  })

  it('creates and updates theme-color from the resolved body surface', async () => {
    dispose = registerWindowChrome()
    const meta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    expect(meta?.content).toBe('rgb(255, 255, 255)')

    document.body.style.backgroundColor = 'rgb(17, 17, 20)'
    document.body.setAttribute('data-ds-dark-theme', '')
    await Promise.resolve()
    expect(meta?.content).toBe('rgb(17, 17, 20)')
  })

  it('reuses a presenter-owned meta node and does not remove it on dispose', () => {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
    dispose = registerWindowChrome()
    dispose()
    dispose = undefined
    expect(meta.isConnected).toBe(true)
  })

  it('mounts a centered desktop drag region and forwards resolved theme colors', async () => {
    const updates: unknown[] = []
    window.harnessDesktop = { setWindowChrome: value => { updates.push(value) } }
    dispose = registerWindowChrome()
    expect(document.querySelector('[data-dsh-desktop-titlebar-label]')?.textContent).toBe(WINDOW_TITLE)
    expect(document.documentElement.hasAttribute('data-dsh-desktop-titlebar')).toBe(true)
    expect(updates.at(-1)).toEqual({
      backgroundColor: 'rgb(255, 255, 255)',
      foregroundColor: 'rgb(0, 0, 0)',
      scheme: 'light',
    })

    document.body.style.backgroundColor = 'rgb(17, 17, 20)'
    document.body.style.color = 'rgb(240, 240, 242)'
    document.body.setAttribute('data-ds-dark-theme', '')
    await Promise.resolve()
    expect(updates.at(-1)).toEqual({
      backgroundColor: 'rgb(17, 17, 20)',
      foregroundColor: 'rgb(240, 240, 242)',
      scheme: 'dark',
    })

    dispose()
    dispose = undefined
    expect(document.querySelector('[data-dsh-desktop-titlebar-bar]')).toBeNull()
    expect(document.documentElement.hasAttribute('data-dsh-desktop-titlebar')).toBe(false)
  })

  it('offsets both fixed side rails below the 32px desktop titlebar', () => {
    const styles = readFileSync(resolve('src/client/sidebar.module.css'), 'utf8')
    expect(styles).toMatch(/data-dsh-desktop-titlebar\]\) \.panel\s*\{\s*top:\s*32px;/)
    expect(styles).toMatch(/data-dsh-desktop-titlebar\]\) \.leftPanel\s*\{\s*top:\s*32px;/)
  })
})
