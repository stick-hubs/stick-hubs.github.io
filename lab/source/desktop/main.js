// Stick Lab desktop app
const {app, BrowserWindow, protocol, net, shell, Menu, dialog} = require('electron');
const path = require('path');
const fs = require('fs');
const {pathToFileURL} = require('url');

const APP_HOST = 'app.stick-lab.local';
const APP_ORIGIN = `https://${APP_HOST}`;
const GUI_DIR = path.join(__dirname, '..', 'gui');

// Files the user asked to open (double-click, "Open with", drag onto the app icon)
const pendingFiles = [];
const isProjectFile = p => /\.(sl|sb3|sb2|sb)$/i.test(p || '');
const collectFiles = argv => argv.filter(a => isProjectFile(a) && fs.existsSync(a));

if (!app.requestSingleInstanceLock()) {
    app.quit();
}

protocol.registerSchemesAsPrivileged([
    {scheme: 'https', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true}}
]);

const editorUrl = filePath => {
    let url = `${APP_ORIGIN}/editor.html`;
    if (filePath) {
        const openUrl = `${APP_ORIGIN}/__open/${encodeURIComponent(path.basename(filePath))}?path=${encodeURIComponent(filePath)}`;
        url += `?project_url=${encodeURIComponent(openUrl)}`;
    }
    return url;
};

const createWindow = filePath => {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        title: filePath ? `${path.basename(filePath)} - Stick Lab` : 'Stick Lab',
        icon: path.join(__dirname, '..', 'build', 'icon.png'),
        backgroundColor: '#e5f0ff',
        show: false,
        webPreferences: {
            contextIsolation: true,
            sandbox: true,
            spellcheck: false
        }
    });
    win.once('ready-to-show', () => win.show());
    // The editor asks "leave this page?" when a project has unsaved changes. A web browser shows
    // that question by itself, but in an app it has to be shown here, or the close button does nothing.
    win.webContents.on('will-prevent-unload', event => {
        const choice = dialog.showMessageBoxSync(win, {
            type: 'question',
            buttons: ['Close without saving', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
            title: 'Stick Lab',
            message: 'Close Stick Lab?',
            detail: 'Your project has changes that are not saved. To keep them, click Cancel, then File > Save to your computer.'
        });
        if (choice === 0) event.preventDefault(); // preventDefault here means "let it close"
    });
    // Links (Stick Hubs site, forum, help) open in the normal web browser
    win.webContents.setWindowOpenHandler(({url}) => {
        if (url.startsWith(APP_ORIGIN)) {
            return {action: 'allow'};
        }
        if (/^https?:/.test(url)) shell.openExternal(url);
        return {action: 'deny'};
    });
    win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(APP_ORIGIN)) {
            event.preventDefault();
            if (/^https?:/.test(url)) shell.openExternal(url);
        }
    });
    win.loadURL(editorUrl(filePath));
    return win;
};

const openFiles = files => {
    if (!app.isReady()) {
        pendingFiles.push(...files);
        return;
    }
    for (const file of files) createWindow(file);
};

// macOS: double-clicking a .sl file
app.on('open-file', (event, filePath) => {
    event.preventDefault();
    openFiles([filePath]);
});

// Windows: opening a .sl file while Stick Lab is already running
app.on('second-instance', (event, argv) => {
    const files = collectFiles(argv.slice(1));
    if (files.length) {
        openFiles(files);
    } else {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        } else {
            createWindow();
        }
    }
});

app.whenReady().then(() => {
    // Serve the editor from inside the app; every other https request goes to the internet as usual.
    protocol.handle('https', request => {
        const url = new URL(request.url);
        if (url.host !== APP_HOST) {
            return net.fetch(request, {bypassCustomProtocolHandlers: true});
        }
        if (url.pathname.startsWith('/__open/')) {
            const filePath = url.searchParams.get('path');
            if (!filePath || !isProjectFile(filePath)) {
                return new Response('Not a project file', {status: 400});
            }
            return net.fetch(pathToFileURL(filePath).toString());
        }
        let rel = decodeURIComponent(url.pathname);
        if (rel === '/' || rel === '') rel = '/editor.html';
        const target = path.normalize(path.join(GUI_DIR, rel));
        if (!target.startsWith(GUI_DIR)) {
            return new Response('Forbidden', {status: 403});
        }
        return net.fetch(pathToFileURL(target).toString());
    });

    if (process.platform !== 'darwin') {
        Menu.setApplicationMenu(null);
    }

    const files = [...pendingFiles, ...collectFiles(process.argv.slice(1))];
    pendingFiles.length = 0;
    if (files.length) {
        for (const file of files) createWindow(file);
    } else {
        createWindow();
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
