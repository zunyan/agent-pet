const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tooltipAPI', {
  onData: (callback) => {
    ipcRenderer.on('tooltip-data', (event, data) => callback(data));
  },
  reportSize: (size) => ipcRenderer.send('tooltip-size', size)
});
