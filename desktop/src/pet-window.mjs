/** Owns the companion BrowserWindow, IPC authorization, and channel-local window state. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Keep the entire pet within one available display, including after display removal. */
export function petBounds(value, areas, chatOpen = false) {
  const fallback = areas[0] ?? { x: 0, y: 0, width: 1440, height: 900 }
  const height = Math.min((chatOpen ? 72 : 0) + Math.max(Number.isFinite(value?.height) ? Math.round(value.height) : 420, 180), 1000, fallback.height)
  const width = Math.min(Math.max(chatOpen ? 280 : 0, Math.round((height - (chatOpen ? 72 : 0)) * 0.72)), fallback.width)
  const x = Number.isFinite(value?.x) ? Math.round(value.x) : fallback.x + fallback.width - width - 24
  const y = Number.isFinite(value?.y) ? Math.round(value.y) : fallback.y + fallback.height - height - 16
  const area = areas.find(item => x + width / 2 >= item.x && x + width / 2 < item.x + item.width && y + height / 2 >= item.y && y + height / 2 < item.y + item.height) ?? fallback
  return { x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))), width: Math.min(width, area.width), height: Math.min(height, area.height) }
}

/** Install one desktop IPC endpoint; only the main frame and pet frame may invoke their own commands. */
export function installPetWindow({ app, BrowserWindow, ipcMain, powerMonitor, screen, getMainWindow, getBackendUrl, log }) {
  const statePath = join(app.getPath('userData'), 'desktop-pet-window.json')
  let state = { visible: false }
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8'))
    if (!value || typeof value !== 'object' || typeof value.visible !== 'boolean') throw new Error('Invalid pet window state')
    state = value
  }
  catch (error) { if (error.code !== 'ENOENT') log(`desktop-pet window settings: ${error.message}`) }
  let pet
  let chatOpen = false
  let lease
  let releaseOwner = () => {}
  let pointerTimer
  let saveTimer
  let drag
  let settings = { height: 420, alwaysOnTop: true }
  const configure = command => {
    if (!Number.isInteger(command.height) || command.height < 180 || command.height > 1000 || typeof command.alwaysOnTop !== 'boolean') throw new Error('Invalid window settings')
    settings = { height: command.height, alwaysOnTop: command.alwaysOnTop }
  }
  const areas = () => screen.getAllDisplays().map(display => display.workArea)
  const save = () => {
    clearTimeout(saveTimer)
    if (pet && !pet.isDestroyed()) state = { ...state, ...pet.getBounds(), height: settings.height }
    try {
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 })
      renameSync(`${statePath}.tmp`, statePath)
    } catch (error) { log(`desktop-pet save failed: ${error.message}`) }
  }
  const stopPointer = () => { clearInterval(pointerTimer); pointerTimer = undefined; drag = undefined }
  const cancelConversation = () => { const backend = getBackendUrl(); if (backend) void fetch(new URL('/desktop-pet/api/conversation/stop', backend), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => { /* Backend may already be stopping. */ }) }
  const closeChat = () => { chatOpen = false }
  const destroy = () => { cancelConversation(); closeChat(); stopPointer(); save(); pet?.destroy(); pet = undefined }
  const hide = () => { state.visible = false; destroy() }
  const show = async () => {
    if (!lease || !getBackendUrl()) throw new Error('桌宠插件尚未加载')
    if (pet && !pet.isDestroyed()) { pet.showInactive(); return }
    const window = new BrowserWindow({
      ...petBounds({ ...state, height: settings.height }, areas(), chatOpen), show: false, transparent: true, frame: false,
      resizable: false, hasShadow: false, skipTaskbar: true, alwaysOnTop: settings.alwaysOnTop,
      backgroundColor: '#00000000', title: 'Harness 桌宠',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required', preload: join(import.meta.dirname, 'pet-preload.cjs') },
    })
    pet = window
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.on('close', () => { stopPointer(); save() })
    window.on('closed', () => { if (pet === window) pet = undefined })
    window.on('move', () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 250) })
    window.webContents.on('render-process-gone', () => { hide() })
    try { await window.loadURL(new URL('/desktop-pet/view', getBackendUrl()).href) }
    catch (error) { if (pet === window) destroy(); throw error }
    if (window.isDestroyed() || pet !== window || !lease) return
    state.visible = true
    window.showInactive()
    save()
    pointerTimer = setInterval(() => {
      if (window.isDestroyed()) return
      const point = screen.getCursorScreenPoint()
      if (drag) window.setBounds(petBounds({ ...window.getBounds(), height: settings.height, x: point.x - drag.x, y: point.y - drag.y }, areas(), chatOpen))
      const bounds = window.getBounds()
      window.webContents.send('harness:pet-pointer', { x: point.x - bounds.x, y: point.y - bounds.y })
    }, 33)
  }
  const requireMain = event => {
    const main = getMainWindow()
    const backend = getBackendUrl()
    return main && backend && event.sender === main.webContents && event.senderFrame === main.webContents.mainFrame && new URL(event.senderFrame.url).origin === new URL(backend).origin
  }
  const setChatInput = open => {
    if (typeof open !== 'boolean' || !pet) throw new Error('Invalid chat input state')
    chatOpen = open
    pet.setBounds(petBounds({ ...pet.getBounds(), height: settings.height }, areas(), open))
    if (open) { pet.setIgnoreMouseEvents(false); pet.focus() }
  }
  const handler = async (event, command) => {
    if (!command || typeof command !== 'object') throw new Error('Invalid pet command')
    const fromPet = pet && event.sender === pet.webContents && event.senderFrame === pet.webContents.mainFrame
    if (fromPet) {
      if (command.action === 'chat-input') { setChatInput(command.open); return }
      if (command.action === 'hit' && typeof command.hit === 'boolean') { pet.setIgnoreMouseEvents(!command.hit && !drag, { forward: true }); return }
      if (command.action === 'drag-start') { const point = screen.getCursorScreenPoint(); const bounds = pet.getBounds(); drag = { x: point.x - bounds.x, y: point.y - bounds.y }; pet.setIgnoreMouseEvents(false); return }
      if (command.action === 'drag-end') { drag = undefined; save(); return }
      if (command.action === 'hide') { hide(); return }
      if (command.action === 'open-settings') { getMainWindow()?.show(); getMainWindow()?.webContents.send('harness:pet-open-settings'); return }
      throw new Error('Pet command not allowed')
    }
    if (!requireMain(event)) throw new Error('Pet command requires the Harness main frame')
    if (command.action === 'attach') {
      if (typeof command.lease !== 'string' || command.lease.length > 100) throw new Error('Invalid lease')
      configure(command)
      const mediaSession = event.sender.session
      const expectedChat = new URL('/desktop-pet/chat', getBackendUrl()).href
      const ownsMedia = (contents, url) => contents === getMainWindow()?.webContents && url === expectedChat && Boolean(lease)
      const ownsClipboard = (contents, url) => {
        if (contents !== getMainWindow()?.webContents || !url) return false
        try { return new URL(url).origin === new URL(getBackendUrl()).origin }
        catch { return false }
      }
      mediaSession.setPermissionCheckHandler((contents, permission, origin, details) =>
        permission === 'clipboard-sanitized-write' ? ownsClipboard(contents, details.requestingUrl) && ownsClipboard(contents, origin)
          : permission === 'media' && details.mediaType === 'audio' && ownsMedia(contents, details.requestingUrl) && origin === new URL(expectedChat).origin)
      mediaSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(
        permission === 'clipboard-sanitized-write' ? ownsClipboard(contents, details.requestingUrl)
          : permission === 'media' && ownsMedia(contents, details.requestingUrl) && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio'))
      releaseOwner()
      lease = command.lease
      const owner = event.sender
      const detached = () => { lease = undefined; destroy(); releaseOwner() }
      const navigated = (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) detached() }
      owner.once('destroyed', detached)
      owner.on('did-start-navigation', navigated)
      releaseOwner = () => { owner.removeListener('destroyed', detached); owner.removeListener('did-start-navigation', navigated); releaseOwner = () => {} }
      if (state.visible) await show()
      return { visible: state.visible }
    }
    if (command.lease !== lease || !lease) throw new Error('Desktop pet plugin is not attached')
    if (command.action === 'detach') { lease = undefined; releaseOwner(); destroy(); return }
    if (command.action === 'show') { await show(); return { visible: state.visible } }
    if (command.action === 'hide') { hide(); return { visible: false } }
    if (command.action === 'react') {
      if (!['touch', 'click', 'annoyed', 'release', 'complete'].includes(command.reaction)) throw new Error('Unsupported pet reaction')
      if (!pet || pet.isDestroyed()) return false
      pet.webContents.send('harness:pet-reaction', command.reaction)
      return true
    }
    if (command.action === 'status') {
      if (!['idle', 'thinking', 'working', 'replying', 'waiting', 'complete', 'error'].includes(command.kind)) throw new Error('Unsupported pet status')
      if (!pet || pet.isDestroyed()) return false
      pet.webContents.send('harness:pet-status', { kind: command.kind })
      return true
    }
    if (command.action === 'configure') {
      configure(command)
      const visible = state.visible
      destroy()
      if (visible) await show()
      return
    }
    throw new Error('Unknown pet command')
  }
  ipcMain.handle('harness:pet-command', handler)
  const displayChanged = () => { if (pet) { pet.setBounds(petBounds({ ...pet.getBounds(), height: settings.height }, areas(), chatOpen)); save() } }
  const suspend = () => { if (pet) destroy() }
  const resume = () => { if (state.visible && lease) void show().catch(error => log(`desktop-pet resume: ${error.message}`)) }
  powerMonitor?.on('suspend', suspend)
  powerMonitor?.on('resume', resume)
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, displayChanged)
  return () => {
    lease = undefined
    releaseOwner()
    destroy()
    ipcMain.removeHandler('harness:pet-command')
    powerMonitor?.removeListener('suspend', suspend)
    powerMonitor?.removeListener('resume', resume)
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, displayChanged)
  }
}
