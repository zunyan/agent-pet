const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  dragStart: (x, y) => ipcRenderer.send('drag-start', { x, y }),
  dragEnd: () => ipcRenderer.send('drag-end'),
  resizePetWindow: (height) => ipcRenderer.send('resize-pet-window', height),
  showTooltip: (payload) => ipcRenderer.send('show-tooltip', payload),
  hideTooltip: () => ipcRenderer.send('hide-tooltip'),
  onTasksUpdate: (callback) => {
    ipcRenderer.on('tasks-update', (event, tasks) => callback(tasks));
  },
  openProject: (cwd) => ipcRenderer.send('open-project', cwd),
  dismissTask: (taskId) => ipcRenderer.send('dismiss-task', taskId),
  onSkinConfig: (callback) => {
    ipcRenderer.on('skin-config', (event, config) => callback(config));
  },
  setSkin: (skinName) => {
    ipcRenderer.send('set-skin', skinName);
  },
  selectWorkingDirectory: () => ipcRenderer.invoke('select-working-directory'),
  claudeSpawn: (cwd) => ipcRenderer.invoke('claude-spawn', cwd),
  claudeWrite: (id, input) => ipcRenderer.invoke('claude-write', { id, input }),
  claudeKill: (id) => ipcRenderer.invoke('claude-kill', id),
  claudeAttach: (sessionId) => ipcRenderer.invoke('claude-attach', sessionId),
  openTerminalClient: (sessionId) => ipcRenderer.invoke('open-terminal-client', sessionId),
  claudeResize: (id, cols, rows) => ipcRenderer.invoke('claude-resize', { id, cols, rows }),
  getSessions: () => ipcRenderer.invoke('get-sessions'),
  onSessionsUpdate: (callback) => {
    ipcRenderer.on('sessions-update', (event, sessions) => callback(sessions));
  },
  onSessionOutput: (callback) => {
    ipcRenderer.on('session-output', (event, { id, data }) => callback(id, data));
  },
  // Terminal window specific
  onTerminalOutput: (callback) => {
    ipcRenderer.on('terminal-output', (event, { id, data }) => callback(id, data));
  },
  onSetSessionId: (callback) => {
    ipcRenderer.on('set-session-id', (event, sessionId) => callback(sessionId));
  },
  terminalWrite: (id, data) => ipcRenderer.invoke('terminal-write', { id, data })
});
