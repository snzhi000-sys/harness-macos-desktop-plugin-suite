const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('harnessDesktop', {
  setWindowChrome(value) {
    if (value === null || typeof value !== 'object') return
    const { backgroundColor, foregroundColor, scheme } = value
    if (typeof backgroundColor !== 'string' || typeof foregroundColor !== 'string') return
    if (scheme !== 'light' && scheme !== 'dark') return
    ipcRenderer.send('harness:window-chrome', { backgroundColor, foregroundColor, scheme })
  },
})
