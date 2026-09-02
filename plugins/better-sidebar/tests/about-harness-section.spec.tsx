import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { AboutHarnessSection } from '../src/client/AboutHarnessSection.tsx'
import { attachLocale } from '../src/client/locales.ts'

describe('About App section', () => {
  afterEach(() => attachLocale(undefined))

  it('ships the fixed author and repository information in the rendered section', () => {
    attachLocale({ getSnapshot: () => ({ active: 'zh-CN' }) })
    const html = renderToString(createElement(AboutHarnessSection))

    expect(html).toContain('关于 App')
    expect(html).toContain('作者')
    expect(html).toContain('>zhee<')
    expect(html).toContain('GitHub 地址')
    expect(html).toContain('href="https://github.com/snzhi000-sys/harness-macos-desktop-plugin-suite"')
    expect(html).toContain('target="_blank"')
  })
})
