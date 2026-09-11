const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('harnessDesktop', {
  ...(process.argv.includes('--dsh-desktop-pet') ? {
    petCommand(value) { return ipcRenderer.invoke('harness:pet-command', value) },
    onPetSettings(callback) {
      const listener = () => callback()
      ipcRenderer.on('harness:pet-open-settings', listener)
      return () => ipcRenderer.removeListener('harness:pet-open-settings', listener)
    },
  } : {}),
  setWindowChrome(value) {
    if (value === null || typeof value !== 'object') return
    const { backgroundColor, foregroundColor, scheme } = value
    if (typeof backgroundColor !== 'string' || typeof foregroundColor !== 'string') return
    if (scheme !== 'light' && scheme !== 'dark') return
    ipcRenderer.send('harness:window-chrome', { backgroundColor, foregroundColor, scheme })
  },
})
