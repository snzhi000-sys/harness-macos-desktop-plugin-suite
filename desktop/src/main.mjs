import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell } from 'electron'
import { executablePath, readyUrl } from './runtime-paths.mjs'
import { readWindowBounds, writeWindowBounds } from './window-state.mjs'
import { readAppearanceScheme, writeAppearanceScheme } from './appearance-state.mjs'
import { fadeStartupDocument, startupDocument } from './startup-document.mjs'
import { installBundledProfile } from './profile-bootstrap.mjs'
import { migrateLegacyDevData } from './dev-data-migration.mjs'

const STARTUP_TIMEOUT_MS = 60_000
const SHUTDOWN_TIMEOUT_MS = 8_000
const WINDOW_STATE_WRITE_DELAY_MS = 250

let mainWindow
let backend
let backendUrl
let quitting = false
const execFileAsync = promisify(execFile)

// Electron derives userData from its internal app name, not macOS's visible
// product name. Read the packaged channel before the first getPath('userData')
// call so Dev never falls back to this package's npm name and shares neither
// Stable state nor an accidental @deepseek-ai directory.
const packagedChannel = app.isPackaged
  ? JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')).dshDesktopChannel
  : process.env.DSH_DESKTOP_CHANNEL
const desktopChannel = packagedChannel === 'stable' ? 'stable' : 'dev'
app.setName(desktopChannel === 'stable' ? 'DeepSeek Harness' : 'DeepSeek Harness Dev')
const legacyDevUserData = join(app.getPath('appData'), '@deepseek-ai', 'dsh-desktop-builder')
const releaseInfo = JSON.parse(readFileSync(join(app.getAppPath(), 'release-info.json'), 'utf8'))

async function runtimeDirectory() {
  if (!app.isPackaged) return join(import.meta.dirname, '..', '..', '.desktop-runtime')

  const bootstrap = join(process.resourcesPath, 'runtime-bootstrap')
  const runtimeId = readFileSync(join(bootstrap, 'runtime-id'), 'utf8').trim()
  if (!/^[a-f0-9]{16}$/.test(runtimeId)) throw new Error('Packaged runtime identifier is invalid')
  const runtimes = join(app.getPath('userData'), 'runtimes')
  const runtime = join(runtimes, runtimeId)
  const readyMarker = join(runtime, '.ready')
  if (existsSync(readyMarker)) return runtime

  const staging = join(runtimes, `${runtimeId}.installing`)
  mkdirSync(runtimes, { recursive: true })
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  log(`extracting packaged runtime ${runtimeId}`)
  try {
    await execFileAsync('/usr/bin/tar', ['-xzf', join(bootstrap, 'runtime.tar.gz'), '-C', staging])
    appendFileSync(join(staging, '.ready'), `${runtimeId}\n`)
    if (existsSync(runtime)) rmSync(runtime, { recursive: true, force: true })
    renameSync(staging, runtime)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  log(`packaged runtime ${runtimeId} ready`)
  return runtime
}

function desktopLogPath() {
  const directory = join(app.getPath('userData'), 'logs')
  mkdirSync(directory, { recursive: true })
  return join(directory, 'desktop.log')
}

function log(message) {
  appendFileSync(desktopLogPath(), `${new Date().toISOString()} ${message}\n`)
}

function statusDocument(title, detail) {
  const escapedTitle = title.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const escapedDetail = detail.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<style>body{font:15px -apple-system,BlinkMacSystemFont,sans-serif;display:grid;place-items:center;margin:0;min-height:100vh;background:#f6f8fb;color:#172033}.card{width:min(560px,calc(100vw - 64px));padding:36px;border-radius:18px;background:white;box-shadow:0 18px 60px #1720331c}h1{font-size:23px;margin:0 0 14px}p{line-height:1.65;white-space:pre-wrap;margin:0;color:#566176}@media(prefers-color-scheme:dark){body{background:#15171b;color:#f2f4f8}.card{background:#22252b}p{color:#b8c0cc}}</style>
</head><body><main class="card"><h1>${escapedTitle}</h1><p>${escapedDetail}</p></main></body></html>`)}`
}

function createWindow() {
  const statePath = join(app.getPath('userData'), 'window-state.json')
  const appearancePath = join(app.getPath('userData'), 'appearance-state.json')
  const savedScheme = readAppearanceScheme(appearancePath)
  if (savedScheme !== undefined) nativeTheme.themeSource = savedScheme
  const dark = nativeTheme.shouldUseDarkColors
  const initialBounds = readWindowBounds(statePath, screen.getAllDisplays().map(display => display.workArea))
  const window = new BrowserWindow({
    ...initialBounds,
    minWidth: 920,
    minHeight: 640,
    title: 'Harness',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: dark ? '#17181a' : '#f7f7f8',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(import.meta.dirname, 'preload.cjs'),
    },
  })
  let stateWriteTimer
  const saveWindowBounds = () => {
    if (stateWriteTimer !== undefined) clearTimeout(stateWriteTimer)
    stateWriteTimer = undefined
    if (window.isDestroyed()) return
    try {
      writeWindowBounds(statePath, window.getNormalBounds())
    } catch (error) {
      log(`failed to save window state: ${String(error)}`)
    }
  }
  const scheduleWindowBoundsSave = () => {
    if (stateWriteTimer !== undefined) clearTimeout(stateWriteTimer)
    stateWriteTimer = setTimeout(saveWindowBounds, WINDOW_STATE_WRITE_DELAY_MS)
  }
  window.on('resize', scheduleWindowBoundsSave)
  window.on('move', scheduleWindowBoundsSave)
  window.on('close', saveWindowBounds)
  window.on('page-title-updated', event => {
    event.preventDefault()
    window.setTitle('Harness')
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (backendUrl !== undefined && new URL(url).origin === new URL(backendUrl).origin) return
    event.preventDefault()
    void shell.openExternal(url)
  })
  window.on('closed', () => {
    if (stateWriteTimer !== undefined) clearTimeout(stateWriteTimer)
    if (mainWindow === window) mainWindow = undefined
  })
  const updateWindowChrome = (event, value) => {
    if (event.sender !== window.webContents) return
    if (value === null || typeof value !== 'object') return
    const { backgroundColor, scheme } = value
    if (typeof backgroundColor !== 'string') return
    if (scheme !== 'light' && scheme !== 'dark') return
    nativeTheme.themeSource = scheme
    window.setBackgroundColor(backgroundColor)
    try {
      writeAppearanceScheme(appearancePath, scheme)
    } catch (error) {
      log(`failed to save appearance state: ${String(error)}`)
    }
  }
  ipcMain.on('harness:window-chrome', updateWindowChrome)
  window.once('closed', () => { ipcMain.removeListener('harness:window-chrome', updateWindowChrome) })
  mainWindow = window
  return window
}

async function startBackend() {
  const userData = app.getPath('userData')
  if (migrateLegacyDevData({ channel: desktopChannel, userData, legacyUserData: legacyDevUserData })) {
    log('migrated legacy Dev settings into channel-specific userData')
  }
  const runtimeDir = await runtimeDirectory()
  const node = join(runtimeDir, 'bin', 'node')
  const cli = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const dshHome = join(userData, 'harness')
  mkdirSync(dshHome, { recursive: true })
  if (await installBundledProfile({ channel: desktopChannel, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, userData })) {
    log('installed or upgraded bundled clean plugin profile')
  }
  const child = spawn(node, [cli, 'web', '--host', '127.0.0.1', '--port', '0'], {
    cwd: dshHome,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_DESKTOP_RELEASE_INFO: JSON.stringify(releaseInfo),
      PATH: executablePath(runtimeDir, process.env.PATH),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backend = child
  let stdout = ''

  const readiness = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Harness did not become ready within ${String(STARTUP_TIMEOUT_MS / 1000)} seconds`))
    }, STARTUP_TIMEOUT_MS)
    const settle = (action) => {
      clearTimeout(timeout)
      action()
    }
    child.once('error', error => settle(() => reject(error)))
    child.once('exit', (code, signal) => {
      if (backend === child) backend = undefined
      if (backendUrl === undefined) {
        settle(() => reject(new Error(`Harness exited before startup (code ${String(code)}, signal ${String(signal)})`)))
      } else if (!quitting) {
        log(`backend exited unexpectedly: code=${String(code)} signal=${String(signal)}`)
        mainWindow?.loadURL(statusDocument('DeepSeek Harness 已停止', `后端进程意外退出。\n\n日志：${desktopLogPath()}`)).catch(error => log(`failed to show exit page: ${String(error)}`))
      }
    })
    child.stdout.on('data', chunk => {
      const text = chunk.toString()
      stdout += text
      log(`[backend stdout] ${text.trimEnd()}`)
      const url = readyUrl(stdout)
      if (url !== undefined && backendUrl === undefined) {
        backendUrl = url
        settle(() => resolve(url))
      }
    })
    child.stderr.on('data', chunk => log(`[backend stderr] ${chunk.toString().trimEnd()}`))
  })

  return readiness
}

async function stopBackend() {
  const child = backend
  backend = undefined
  backendUrl = undefined
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolve => {
    const timeout = setTimeout(() => {
      log('backend did not stop after SIGTERM; sending SIGKILL')
      child.kill('SIGKILL')
    }, SHUTDOWN_TIMEOUT_MS)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

async function boot() {
  const window = createWindow()
  await window.loadURL(startupDocument())
  try {
    backendUrl = await startBackend()
    log(`backend ready at ${backendUrl}`)
    await fadeStartupDocument(window.webContents)
    await window.loadURL(backendUrl)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`startup failed: ${message}`)
    await stopBackend()
    await window.loadURL(statusDocument('无法启动 DeepSeek Harness', `${message}\n\n日志：${desktopLogPath()}`))
    dialog.showErrorBox('DeepSeek Harness 启动失败', `${message}\n\n请查看日志：${desktopLogPath()}`)
  }
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) mainWindow = createWindow()
    if (backendUrl !== undefined) void mainWindow.loadURL(backendUrl)
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(boot).catch(error => {
    log(`desktop boot failed: ${String(error)}`)
    dialog.showErrorBox('DeepSeek Harness 启动失败', String(error))
    app.exit(1)
  })

  app.on('activate', () => {
    if (mainWindow !== undefined) return
    const window = createWindow()
    void window.loadURL(backendUrl ?? startupDocument())
  })

  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void stopBackend().finally(() => app.exit(0))
  })
}
