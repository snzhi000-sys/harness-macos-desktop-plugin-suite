const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('harnessPet', {
  command: value => ipcRenderer.invoke('harness:pet-command', value),
  onStatus: callback => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('harness:pet-status', listener)
    return () => ipcRenderer.removeListener('harness:pet-status', listener)
  },
  onReaction: callback => {
    const listener = (_event, reaction) => callback(reaction)
    ipcRenderer.on('harness:pet-reaction', listener)
    return () => ipcRenderer.removeListener('harness:pet-reaction', listener)
  },
  onPointer: callback => {
    const listener = (_event, point) => callback(point)
    ipcRenderer.on('harness:pet-pointer', listener)
    return () => ipcRenderer.removeListener('harness:pet-pointer', listener)
  },
})
