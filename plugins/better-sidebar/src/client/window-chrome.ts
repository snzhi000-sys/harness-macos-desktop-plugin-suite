/**
 * Renderer-owned window chrome projection.
 *
 * Harness normally projects the selected session into `document.title`, so
 * Electron mirrors every task switch into the native window title. This
 * plugin deliberately keeps the product title stable and also exposes the
 * resolved page background through the standard theme-color metadata used by
 * browser/desktop shells that support renderer-driven chrome colors.
 */

export const WINDOW_TITLE = 'Harness'

interface DesktopWindowChrome {
  setWindowChrome(value: {
    backgroundColor: string
    foregroundColor: string
    scheme: 'light' | 'dark'
  }): void
}

declare global {
  interface Window {
    harnessDesktop?: DesktopWindowChrome
  }
}

/** Keep the title and surrounding-chrome metadata aligned with the app theme. */
export function registerWindowChrome(): () => void {
  const originalTitle = document.title
  let ownedThemeMeta: HTMLMetaElement | undefined
  let titlebar: HTMLDivElement | undefined
  let titlebarStyle: HTMLStyleElement | undefined

  if (window.harnessDesktop !== undefined) {
    document.documentElement.setAttribute('data-dsh-desktop-titlebar', '')
    titlebarStyle = document.createElement('style')
    titlebarStyle.setAttribute('data-dsh-desktop-titlebar-style', '')
    titlebarStyle.textContent = `
html[data-dsh-desktop-titlebar] {
  box-sizing: border-box;
  height: 100%;
  padding-top: 32px;
}
[data-dsh-desktop-titlebar-bar] {
  -webkit-app-region: drag;
  align-items: center;
  display: flex;
  height: 32px;
  inset: 0 0 auto;
  justify-content: center;
  position: fixed;
  user-select: none;
  z-index: 2147483000;
}
[data-dsh-desktop-titlebar-label] {
  font: 600 13px/32px -apple-system, BlinkMacSystemFont, sans-serif;
  left: 50%;
  pointer-events: none;
  position: absolute;
  transform: translateX(-50%);
  white-space: nowrap;
}
`
    document.head.appendChild(titlebarStyle)
    titlebar = document.createElement('div')
    titlebar.setAttribute('data-dsh-desktop-titlebar-bar', '')
    const label = document.createElement('span')
    label.setAttribute('data-dsh-desktop-titlebar-label', '')
    label.textContent = WINDOW_TITLE
    titlebar.appendChild(label)
    document.body.appendChild(titlebar)
  }

  const apply = (): void => {
    if (document.title !== WINDOW_TITLE) document.title = WINDOW_TITLE

    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (meta === null) {
      meta = document.createElement('meta')
      meta.name = 'theme-color'
      meta.setAttribute('data-dsh-better-sidebar-window-chrome', '')
      document.head.appendChild(meta)
      ownedThemeMeta = meta
    }
    const background = getComputedStyle(document.body).backgroundColor
    const foreground = getComputedStyle(document.body).color
    if (background !== '' && meta.content !== background) meta.content = background
    if (titlebar !== undefined) {
      titlebar.style.backgroundColor = background
      titlebar.style.color = foreground
      window.harnessDesktop?.setWindowChrome({
        backgroundColor: background,
        foregroundColor: foreground,
        scheme: document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light',
      })
    }
  }

  apply()
  // MutationObserver callbacks already run after the current batch of DOM
  // writes, so the computed surface is settled when `apply` measures it.
  const titleObserver = new MutationObserver(apply)
  titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true })
  const themeObserver = new MutationObserver(apply)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme'] })

  return () => {
    titleObserver.disconnect()
    themeObserver.disconnect()
    ownedThemeMeta?.remove()
    titlebar?.remove()
    titlebarStyle?.remove()
    document.documentElement.removeAttribute('data-dsh-desktop-titlebar')
    if (document.title === WINDOW_TITLE) document.title = originalTitle
  }
}
