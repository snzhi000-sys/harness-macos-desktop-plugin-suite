/** Isolated Electron entry assembles real Host routes, client bundle, preload, and pet window. */
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { once, EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/host.mjs'
import { installPetWindow } from '../../../desktop/src/pet-window.mjs'

app.whenReady().then(async () => {
let route
let disposeHost
apply({ webServer: { register(value) { route = value; return () => { route = undefined } } }, effect(factory) { disposeHost = factory() } })
const server = createServer(async (req, res) => {
  if (req.url === '/') {
    res.setHeader('content-type', 'text/html')
    res.end('<!doctype html><meta charset="utf-8"><title>桌宠隔离测试</title><h1>Harness desktop-pet fixture</h1><script>window.__ModuleLoader__={load({factory}){factory(()=>{throw new Error("Unexpected external")}).apply({effect(fn){window.disposePlugin=fn()}})}};</script><script src="/client.js"></script>')
  } else if (req.url === '/client.js') { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL('../dist/client.js', import.meta.url))) }
  else if (route) await route.handler(req, res)
  else res.writeHead(404).end()
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const url = `http://127.0.0.1:${server.address().port}`
const window = new BrowserWindow({ width: 1000, height: 850, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, additionalArguments: ['--dsh-desktop-pet'], preload: fileURLToPath(new URL('../../../desktop/src/preload.cjs', import.meta.url)) } })
// Deterministic display input keeps automated drags independent of the user's physical mouse.
globalThis.petFixturePointer = { x: 0, y: 0 }
globalThis.petFixtureMouseIgnore = {}
function PetBrowserWindow(options) {
  const pet = new BrowserWindow(options)
  const ignore = pet.setIgnoreMouseEvents.bind(pet)
  pet.setIgnoreMouseEvents = (value, flags) => { globalThis.petFixtureMouseIgnore[pet.id] = value; return ignore(value, flags) }
  return pet
}
const displayInput = { getAllDisplays: () => screen.getAllDisplays(), getCursorScreenPoint: () => globalThis.petFixturePointer, on: (...args) => screen.on(...args), removeListener: (...args) => screen.removeListener(...args) }
globalThis.petFixturePower = new EventEmitter()
const disposeWindow = installPetWindow({ app, BrowserWindow: PetBrowserWindow, ipcMain, screen: displayInput, powerMonitor: globalThis.petFixturePower, getMainWindow: () => window, getBackendUrl: () => url, log: console.error })
await window.loadURL(url)
app.on('before-quit', () => { disposeWindow(); disposeHost(); server.closeAllConnections(); server.close() })
}).catch(error => { console.error(error); app.exit(1) })
