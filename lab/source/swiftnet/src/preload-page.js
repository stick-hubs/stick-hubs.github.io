// Runs in every tab. Only SwiftNet's own swiftnet:// pages get the "sn" helper; websites get nothing.
const {contextBridge, ipcRenderer} = require('electron');

if (location.protocol === 'swiftnet:') {
    contextBridge.exposeInMainWorld('sn', {
        get: (what, arg) => ipcRenderer.invoke('sn:get', what, arg),
        set: (what, value) => ipcRenderer.invoke('sn:set', what, value),
        onChanged: fn => ipcRenderer.on('sn:changed', (e, what) => fn(what))
    });
}
