const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('auto', {
  startRecording: url => ipcRenderer.invoke('start-recording', url),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  runWorkflow: repeats => ipcRenderer.invoke('run-workflow', repeats),
  stopAutomation: () => ipcRenderer.invoke('stop-automation'),
  stopBrowser: () => ipcRenderer.invoke('stop-browser'),
  getWorkflow: () => ipcRenderer.invoke('get-workflow'),
  saveWorkflow: data => ipcRenderer.invoke('save-workflow', data),
  on: (channel, callback) => {
    const allowed = ['recorded-step', 'recording-state', 'run-status', 'browser-status', 'automation-error'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_, data) => callback(data));
  }
});
