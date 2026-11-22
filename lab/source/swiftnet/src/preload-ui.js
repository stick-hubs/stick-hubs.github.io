// Bridge for SwiftNet's own toolbar and tab strip (ui/index.html).
const {contextBridge, ipcRenderer} = require('electron');

const CHANNELS = ['state', 'find:result', 'find:show', 'find:hide', 'focus:address'];

contextBridge.exposeInMainWorld('swift', {
    command: (cmd, arg) => ipcRenderer.send('ui:command', cmd, arg),
    layout: (top, bottom) => ipcRenderer.send('ui:layout', top, bottom),
    ready: () => ipcRenderer.send('ui:ready'),
    find: (text, opts) => ipcRenderer.send('ui:find', text, opts),
    download: (action, id) => ipcRenderer.send('ui:download', action, id),
    bookmarkMenu: index => ipcRenderer.send('ui:bookmarkMenu', index),
    on: (channel, fn) => {
        if (CHANNELS.includes(channel)) ipcRenderer.on(channel, (e, data) => fn(data));
    }
});
