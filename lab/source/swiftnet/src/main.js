// SwiftNet: a Chromium web browser from Stick Hubs (built with Electron).
const {app, BrowserWindow, WebContentsView, ipcMain, session, Menu, dialog, shell, protocol, net, clipboard} = require('electron');
const path = require('path');
const fs = require('fs');

const HOME_DEFAULT = 'https://stick-hubs.github.io/';
const UPDATE_URL = 'https://stick-hubs.github.io/downloads/swiftnet-latest.json';
const STORE_PAGE = 'https://stick-hubs.github.io/store.html#swiftnet';
const CLAUDE_URL = 'https://claude.ai/new';
const PARTITION = 'persist:swiftnet';
const IS_MAC = process.platform === 'darwin';
const SEARCH = {
    google: {name: 'Google', url: 'https://www.google.com/search?q=%s'},
    bing: {name: 'Bing', url: 'https://www.bing.com/search?q=%s'},
    duckduckgo: {name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s'}
};
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

app.setName('SwiftNet');
protocol.registerSchemesAsPrivileged([{scheme: 'swiftnet', privileges: {standard: true, secure: true, supportFetchAPI: true}}]);
if (!app.requestSingleInstanceLock()) app.quit();

// ------------------------------------------------------------ saved data
const dataDir = () => app.getPath('userData');
const readJson = (name, fallback) => {
    try {
        return JSON.parse(fs.readFileSync(path.join(dataDir(), name), 'utf8'));
    } catch (e) {
        return fallback;
    }
};
const saveTimers = {};
const writeJson = (name, value) => {
    clearTimeout(saveTimers[name]);
    saveTimers[name] = setTimeout(() => {
        try {
            fs.writeFileSync(path.join(dataDir(), name), JSON.stringify(value));
        } catch (e) {
            // disk full or read-only: nothing to do
        }
    }, 400);
};
const flushJson = () => {
    for (const name of Object.keys(saveTimers)) clearTimeout(saveTimers[name]);
    const all = {'settings.json': settings, 'bookmarks.json': bookmarks, 'history.json': history, 'session.json': sessionTabs()};
    for (const [name, value] of Object.entries(all)) {
        try {
            fs.writeFileSync(path.join(dataDir(), name), JSON.stringify(value));
        } catch (e) {
            // ignore
        }
    }
};

let settings;
let bookmarks;
let history;
const loadData = () => {
    settings = Object.assign({theme: 'aero', search: 'google', home: HOME_DEFAULT, startup: 'home', bookmarksBar: true, claudeWidth: 420},
        readJson('settings.json', {}));
    if (!SEARCH[settings.search]) settings.search = 'google';
    bookmarks = readJson('bookmarks.json', null) || [
        {title: 'Stick Hubs', url: 'https://stick-hubs.github.io/'},
        {title: 'Game Hub', url: 'https://stick-hubs.github.io/games.html'},
        {title: 'SmartLearning', url: 'https://stick-hubs.github.io/smartlearning.html'},
        {title: 'Web Store', url: 'https://stick-hubs.github.io/store.html'}
    ];
    history = readJson('history.json', []);
};
const saveSettings = () => {
    writeJson('settings.json', settings);
    for (const w of windows) w.sendState();
};
const saveBookmarks = () => {
    writeJson('bookmarks.json', bookmarks);
    for (const w of windows) w.sendState();
};

const addHistory = (url, title) => {
    if (!/^https?:/i.test(url)) return;
    const last = history[history.length - 1];
    if (last && last.url === url && Date.now() - last.time < 60000) {
        last.title = title || last.title;
    } else {
        history.push({url, title: title || url, time: Date.now()});
        if (history.length > 5000) history.splice(0, history.length - 5000);
    }
    writeJson('history.json', history);
};

// ------------------------------------------------------------ helpers
const isUrlish = text => {
    const t = text.trim();
    if (/^(https?|file|swiftnet|about|data):/i.test(t)) return true;
    if (/\s/.test(t)) return false;
    if (/^localhost(:\d+)?(\/|$)/i.test(t)) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(t)) return true;
    return /^[^/?#]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(t);
};
const toUrl = text => {
    const t = text.trim();
    if (!t) return settings.home;
    if (isUrlish(t)) return /^[a-z]+:/i.test(t) ? t : (/^(localhost|\d{1,3}(\.\d{1,3}){3})/i.test(t) ? 'http://' : 'https://') + t;
    return SEARCH[settings.search].url.replace('%s', encodeURIComponent(t));
};
const pagePath = name => path.join(__dirname, '..', 'pages', name);
const iconPath = () => path.join(__dirname, '..', 'build', 'icon.png');

// ------------------------------------------------------------ windows and tabs
const windows = new Set();
let nextTabId = 1;
const closedTabs = [];

class SwiftWindow {
    constructor (urls) {
        this.tabs = [];
        this.active = null;
        this.top = 80;
        this.bottom = 0;
        this.claude = null;
        this.claudeOpen = false;
        this.fullscreenTab = null;
        this.win = new BrowserWindow({
            width: 1280,
            height: 820,
            minWidth: 520,
            minHeight: 360,
            show: false,
            frame: IS_MAC,
            titleBarStyle: IS_MAC ? 'hiddenInset' : undefined,
            trafficLightPosition: IS_MAC ? {x: 12, y: 12} : undefined,
            backgroundColor: settings.theme === 'modern' ? '#f3f4f6' : '#9cc3e8',
            icon: iconPath(),
            title: 'SwiftNet',
            webPreferences: {
                preload: path.join(__dirname, 'preload-ui.js'),
                contextIsolation: true,
                sandbox: true
            }
        });
        windows.add(this);
        this.win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'), {query: {platform: process.platform}});
        this.win.once('ready-to-show', () => this.win.show());
        this.win.on('resize', () => this.layout());
        this.win.on('maximize', () => this.sendState());
        this.win.on('unmaximize', () => this.sendState());
        this.win.on('enter-full-screen', () => this.sendState());
        this.win.on('leave-full-screen', () => this.sendState());
        this.win.on('focus', () => this.sendState());
        this.win.on('blur', () => this.sendState());
        this.win.on('closed', () => {
            windows.delete(this);
            this.saveSession();
        });
        this.win.webContents.on('before-input-event', (e, input) => this.shortcut(e, input));
        this.win.webContents.once('did-finish-load', () => {
            (urls && urls.length ? urls : [settings.home]).forEach((u, i) => this.newTab(u, {foreground: i === 0}));
            this.sendState();
        });
    }

    get wc () {
        return this.win.webContents;
    }

    tab (id) {
        return this.tabs.find(t => t.id === id);
    }

    current () {
        return this.tab(this.active);
    }

    newTab (url, {foreground = true, after = null} = {}) {
        const view = new WebContentsView({
            webPreferences: {
                partition: PARTITION,
                preload: path.join(__dirname, 'preload-page.js'),
                contextIsolation: true,
                sandbox: true
            }
        });
        view.setBackgroundColor('#ffffff');
        const tab = {id: nextTabId++, view, title: 'New tab', url: url || settings.home, favicon: null, loading: true, error: null};
        const index = after ? this.tabs.indexOf(this.tab(after)) + 1 : this.tabs.length;
        this.tabs.splice(index > 0 ? index : this.tabs.length, 0, tab);
        this.win.contentView.addChildView(view);
        view.setVisible(false);
        this.wire(tab);
        view.webContents.loadURL(toUrl(tab.url)).catch(() => {});
        if (foreground || !this.active) this.activate(tab.id);
        else this.sendState();
        this.saveSession();
        return tab;
    }

    wire (tab) {
        const wc = tab.view.webContents;
        const update = () => {
            tab.url = wc.getURL() || tab.url;
            tab.canBack = wc.navigationHistory.canGoBack();
            tab.canForward = wc.navigationHistory.canGoForward();
            this.sendState();
        };
        wc.on('did-start-loading', () => {
            tab.loading = true;
            this.sendState();
        });
        wc.on('did-stop-loading', () => {
            tab.loading = false;
            update();
        });
        wc.on('page-title-updated', (e, title) => {
            tab.title = title;
            addHistory(wc.getURL(), title);
            this.sendState();
            if (tab.id === this.active) this.win.setTitle(`${title} - SwiftNet`);
        });
        wc.on('page-favicon-updated', (e, icons) => {
            tab.favicon = icons && icons[0];
            this.sendState();
        });
        wc.on('did-navigate', (e, url) => {
            tab.favicon = null;
            tab.error = null;
            addHistory(url, wc.getTitle());
            update();
            this.saveSession();
        });
        wc.on('did-navigate-in-page', update);
        wc.on('did-fail-load', (e, code, desc, url, isMain) => {
            if (!isMain || code === -3) return; // -3: the load was replaced by another one
            tab.error = {code, desc, url};
            wc.loadURL(`swiftnet://error/?code=${code}&desc=${encodeURIComponent(desc)}&url=${encodeURIComponent(url)}`).catch(() => {});
        });
        wc.on('render-process-gone', (e, details) => {
            if (details.reason === 'clean-exit') return;
            wc.loadURL(`swiftnet://error/?code=crashed&desc=${encodeURIComponent(details.reason)}&url=${encodeURIComponent(tab.url)}`).catch(() => {});
        });
        wc.on('found-in-page', (e, result) => {
            if (tab.id === this.active) this.wc.send('find:result', {match: result.activeMatchOrdinal, total: result.matches});
        });
        wc.on('enter-html-full-screen', () => {
            this.fullscreenTab = tab.id;
            this.win.setFullScreen(true);
            this.layout();
            this.sendState();
        });
        wc.on('leave-html-full-screen', () => {
            this.fullscreenTab = null;
            this.win.setFullScreen(false);
            this.layout();
            this.sendState();
        });
        wc.on('zoom-changed', (e, dir) => this.zoom(dir === 'in' ? 1 : -1));
        wc.on('before-input-event', (e, input) => this.shortcut(e, input));
        wc.on('context-menu', (e, params) => this.pageMenu(tab, params));
        wc.on('will-prevent-unload', e => {
            const choice = dialog.showMessageBoxSync(this.win, {
                type: 'question', buttons: ['Leave', 'Stay'], defaultId: 1, cancelId: 1, noLink: true,
                message: 'Leave this page?', detail: 'Changes you made may not be saved.'
            });
            if (choice === 0) e.preventDefault();
        });
        wc.setWindowOpenHandler(({url, disposition, features}) => {
            // real popups (like "Sign in with Google") stay popups so they can talk back to the page
            if (disposition === 'new-window' && /width|height|popup/.test(features || '')) {
                return {action: 'allow', overrideBrowserWindowOptions: {
                    autoHideMenuBar: true, icon: iconPath(),
                    webPreferences: {partition: PARTITION, sandbox: true, contextIsolation: true}
                }};
            }
            this.newTab(url, {foreground: disposition !== 'background-tab', after: tab.id});
            return {action: 'deny'};
        });
    }

    activate (id) {
        const tab = this.tab(id);
        if (!tab) return;
        this.active = id;
        for (const t of this.tabs) t.view.setVisible(t.id === id);
        this.layout();
        this.win.setTitle(`${tab.title} - SwiftNet`);
        this.sendState();
        this.wc.send('find:hide');
    }

    closeTab (id) {
        const tab = this.tab(id);
        if (!tab) return;
        const index = this.tabs.indexOf(tab);
        if (/^https?:/.test(tab.url)) closedTabs.push(tab.url);
        this.tabs.splice(index, 1);
        this.win.contentView.removeChildView(tab.view);
        tab.view.webContents.close();
        if (!this.tabs.length) {
            this.win.close();
            return;
        }
        if (this.active === id) this.activate(this.tabs[Math.min(index, this.tabs.length - 1)].id);
        else this.sendState();
        this.saveSession();
    }

    moveTab (id, toIndex) {
        const tab = this.tab(id);
        if (!tab) return;
        this.tabs.splice(this.tabs.indexOf(tab), 1);
        this.tabs.splice(Math.max(0, Math.min(this.tabs.length, toIndex)), 0, tab);
        this.sendState();
        this.saveSession();
    }

    layout () {
        if (this.win.isDestroyed()) return;
        const {width, height} = this.win.getContentBounds();
        const tab = this.current();
        if (this.fullscreenTab && tab && this.fullscreenTab === tab.id) {
            tab.view.setBounds({x: 0, y: 0, width, height});
            if (this.claude) this.claude.setVisible(false);
            return;
        }
        const side = this.claudeOpen ? Math.min(settings.claudeWidth, Math.max(280, width - 360)) : 0;
        const h = Math.max(0, height - this.top - this.bottom);
        if (tab) tab.view.setBounds({x: 0, y: this.top, width: width - side, height: h});
        if (this.claude) {
            this.claude.setVisible(this.claudeOpen);
            if (this.claudeOpen) this.claude.setBounds({x: width - side + 1, y: this.top, width: side - 1, height: h});
        }
    }

    toggleClaude () {
        this.claudeOpen = !this.claudeOpen;
        if (this.claudeOpen && !this.claude) {
            this.claude = new WebContentsView({webPreferences: {partition: PARTITION, contextIsolation: true, sandbox: true}});
            this.claude.setBackgroundColor('#ffffff');
            this.win.contentView.addChildView(this.claude);
            this.claude.webContents.setWindowOpenHandler(({url}) => {
                this.newTab(url);
                return {action: 'deny'};
            });
            this.claude.webContents.on('before-input-event', (e, input) => this.shortcut(e, input));
            this.claude.webContents.loadURL(CLAUDE_URL).catch(() => {});
        }
        this.layout();
        this.sendState();
    }

    zoom (step) {
        const tab = this.current();
        if (!tab) return;
        const wc = tab.view.webContents;
        if (step === 0) {
            wc.setZoomFactor(1);
        } else {
            const now = wc.getZoomFactor();
            const list = step > 0 ? ZOOMS.filter(z => z > now + 0.001) : ZOOMS.filter(z => z < now - 0.001).reverse();
            if (list.length) wc.setZoomFactor(list[0]);
        }
        setTimeout(() => this.sendState(), 30);
    }

    navigate (text) {
        const tab = this.current();
        if (!tab) return;
        tab.view.webContents.loadURL(toUrl(text)).catch(() => {});
        tab.view.webContents.focus();
    }

    command (cmd, arg) {
        const tab = this.current();
        const wc = tab && tab.view.webContents;
        switch (cmd) {
        case 'newTab': this.newTab(settings.home); this.wc.send('focus:address'); break;
        case 'newWindow': new SwiftWindow(); break;
        case 'closeTab': this.closeTab(arg || this.active); break;
        case 'reopenTab': if (closedTabs.length) this.newTab(closedTabs.pop()); break;
        case 'activate': this.activate(arg); break;
        case 'moveTab': if (arg) this.moveTab(arg.id, arg.index); break;
        case 'nextTab':
        case 'prevTab': {
            const i = this.tabs.indexOf(tab) + (cmd === 'nextTab' ? 1 : -1);
            this.activate(this.tabs[(i + this.tabs.length) % this.tabs.length].id);
            break;
        }
        case 'tabNumber': {
            const t = arg === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[arg - 1];
            if (t) this.activate(t.id);
            break;
        }
        case 'back': if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
        case 'forward': if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
        case 'reload': if (wc) (tab.loading ? wc.stop() : wc.reload()); break;
        case 'hardReload': if (wc) wc.reloadIgnoringCache(); break;
        case 'home': if (wc) wc.loadURL(settings.home).catch(() => {}); break;
        case 'navigate': this.navigate(arg); break;
        case 'zoomIn': this.zoom(1); break;
        case 'zoomOut': this.zoom(-1); break;
        case 'zoomReset': this.zoom(0); break;
        case 'find': this.wc.send('find:show'); this.wc.focus(); break;
        case 'print': if (wc) wc.print(); break;
        case 'devtools': if (wc) wc.toggleDevTools(); break;
        case 'claude': this.toggleClaude(); break;
        case 'bookmark': toggleBookmark(tab); break;
        case 'bookmarksBar': settings.bookmarksBar = !settings.bookmarksBar; saveSettings(); break;
        case 'open': this.newTab(arg); break;
        case 'page': this.openInternal(arg); break;
        case 'theme': settings.theme = arg; saveSettings(); break;
        case 'fullscreen': this.win.setFullScreen(!this.win.isFullScreen()); break;
        case 'min': this.win.minimize(); break;
        case 'max': (this.win.isMaximized() ? this.win.unmaximize() : this.win.maximize()); break;
        case 'close': this.win.close(); break;
        case 'menu': this.mainMenu(arg); break;
        case 'update': this.newTab(STORE_PAGE); break;
        default: break;
        }
    }

    openInternal (name) {
        const url = `swiftnet://${name}/`;
        const existing = this.tabs.find(t => t.url.startsWith(url));
        if (existing) this.activate(existing.id);
        else this.newTab(url);
    }

    shortcut (e, input) {
        if (input.type !== 'keyDown') return;
        const mod = IS_MAC ? input.meta : input.control;
        const k = input.key.toLowerCase();
        let cmd = null;
        let arg;
        if (mod && !input.shift && k === 't') cmd = 'newTab';
        else if (mod && input.shift && k === 't') cmd = 'reopenTab';
        else if (mod && !input.shift && k === 'n') cmd = 'newWindow';
        else if (mod && (k === 'w' || k === 'f4')) cmd = 'closeTab';
        else if ((input.control && k === 'tab' && !input.shift) || (mod && input.alt && k === 'arrowright')) cmd = 'nextTab';
        else if ((input.control && k === 'tab' && input.shift) || (mod && input.alt && k === 'arrowleft')) cmd = 'prevTab';
        else if (mod && /^[1-9]$/.test(k)) {
            cmd = 'tabNumber';
            arg = Number(k);
        } else if ((mod && k === 'l') || (input.alt && k === 'd') || k === 'f6') {
            this.wc.send('focus:address');
            this.wc.focus();
            e.preventDefault();
            return;
        } else if ((mod && k === 'r') || k === 'f5') cmd = input.shift || (input.control && k === 'f5') ? 'hardReload' : 'reload';
        else if ((input.alt && k === 'arrowleft') || (IS_MAC && input.meta && k === '[')) cmd = 'back';
        else if ((input.alt && k === 'arrowright') || (IS_MAC && input.meta && k === ']')) cmd = 'forward';
        else if (input.alt && k === 'home') cmd = 'home';
        else if (mod && (k === '=' || k === '+')) cmd = 'zoomIn';
        else if (mod && k === '-') cmd = 'zoomOut';
        else if (mod && k === '0') cmd = 'zoomReset';
        else if (mod && k === 'f') cmd = 'find';
        else if (mod && k === 'p') cmd = 'print';
        else if (mod && k === 'd') cmd = 'bookmark';
        else if (mod && input.shift && k === 'b') cmd = 'bookmarksBar';
        else if (mod && k === 'h') {
            cmd = 'page';
            arg = 'history';
        } else if (mod && k === 'j') {
            cmd = 'page';
            arg = 'downloads';
        } else if (k === 'f12' || (mod && input.shift && k === 'i')) cmd = 'devtools';
        else if (k === 'f11' || (IS_MAC && input.meta && input.control && k === 'f')) cmd = 'fullscreen';
        else if (k === 'escape' && this.fullscreenTab) {
            const t = this.current();
            if (t) t.view.webContents.executeJavaScript('document.fullscreenElement && document.exitFullscreen()').catch(() => {});
            return;
        }
        if (!cmd) return;
        e.preventDefault();
        this.command(cmd, arg);
    }

    pageMenu (tab, p) {
        const wc = tab.view.webContents;
        const items = [];
        if (p.linkURL) {
            items.push({label: 'Open link in new tab', click: () => this.newTab(p.linkURL, {foreground: false, after: tab.id})});
            items.push({label: 'Open link in new window', click: () => new SwiftWindow([p.linkURL])});
            items.push({label: 'Copy link address', click: () => clipboard.writeText(p.linkURL)});
            items.push({type: 'separator'});
        }
        if (p.mediaType === 'image' && p.srcURL) {
            items.push({label: 'Open image in new tab', click: () => this.newTab(p.srcURL, {after: tab.id})});
            items.push({label: 'Save image as...', click: () => wc.downloadURL(p.srcURL)});
            items.push({label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y)});
            items.push({label: 'Copy image address', click: () => clipboard.writeText(p.srcURL)});
            items.push({type: 'separator'});
        }
        if (p.isEditable) {
            if (p.misspelledWord && p.dictionarySuggestions.length) {
                for (const s of p.dictionarySuggestions.slice(0, 4)) items.push({label: s, click: () => wc.replaceMisspelling(s)});
                items.push({type: 'separator'});
            }
            items.push({label: 'Undo', role: 'undo', enabled: p.editFlags.canUndo}, {label: 'Redo', role: 'redo', enabled: p.editFlags.canRedo}, {type: 'separator'});
            items.push({label: 'Cut', role: 'cut', enabled: p.editFlags.canCut}, {label: 'Copy', role: 'copy', enabled: p.editFlags.canCopy},
                {label: 'Paste', role: 'paste', enabled: p.editFlags.canPaste}, {label: 'Select all', role: 'selectAll'});
            items.push({type: 'separator'});
        } else if (p.selectionText) {
            const short = p.selectionText.trim().slice(0, 30) + (p.selectionText.trim().length > 30 ? '...' : '');
            items.push({label: 'Copy', role: 'copy'});
            items.push({label: `Search ${SEARCH[settings.search].name} for "${short}"`, click: () => this.newTab(SEARCH[settings.search].url.replace('%s', encodeURIComponent(p.selectionText.trim())), {after: tab.id})});
            items.push({type: 'separator'});
        }
        if (!items.length || (!p.linkURL && !p.isEditable && p.mediaType === 'none')) {
            items.push({label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack()});
            items.push({label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward()});
            items.push({label: 'Reload', click: () => wc.reload()});
            items.push({type: 'separator'});
            items.push({label: 'Save page as...', click: () => savePage(this.win, wc)});
            items.push({label: 'Print...', click: () => wc.print()});
            items.push({type: 'separator'});
        }
        items.push({label: 'Inspect', click: () => wc.inspectElement(p.x, p.y)});
        Menu.buildFromTemplate(items).popup({window: this.win});
    }

    mainMenu (pos) {
        const tab = this.current();
        const zoom = tab ? Math.round(tab.view.webContents.getZoomFactor() * 100) : 100;
        const template = [
            {label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => this.command('newTab')},
            {label: 'New window', accelerator: 'CmdOrCtrl+N', click: () => this.command('newWindow')},
            {type: 'separator'},
            {label: 'History', accelerator: 'CmdOrCtrl+H', click: () => this.openInternal('history')},
            {label: 'Downloads', accelerator: 'CmdOrCtrl+J', click: () => this.openInternal('downloads')},
            {label: 'Bookmarks', click: () => this.openInternal('bookmarks')},
            {label: settings.bookmarksBar ? 'Hide bookmarks bar' : 'Show bookmarks bar', accelerator: 'CmdOrCtrl+Shift+B', click: () => this.command('bookmarksBar')},
            {type: 'separator'},
            {label: `Zoom (${zoom}%)`, submenu: [
                {label: 'Zoom in', accelerator: 'CmdOrCtrl+Plus', click: () => this.zoom(1)},
                {label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => this.zoom(-1)},
                {label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => this.zoom(0)}
            ]},
            {label: 'Find on page...', accelerator: 'CmdOrCtrl+F', click: () => this.command('find')},
            {label: 'Print...', accelerator: 'CmdOrCtrl+P', click: () => this.command('print')},
            {label: 'Full screen', accelerator: 'F11', click: () => this.command('fullscreen')},
            {type: 'separator'},
            {label: 'Theme', submenu: [
                {label: 'Windows 7 Aero', type: 'radio', checked: settings.theme !== 'modern', click: () => this.command('theme', 'aero')},
                {label: 'Modern', type: 'radio', checked: settings.theme === 'modern', click: () => this.command('theme', 'modern')}
            ]},
            {label: this.claudeOpen ? 'Close Claude panel' : 'Open Claude panel', click: () => this.toggleClaude()},
            {label: 'Settings', click: () => this.openInternal('settings')},
            {label: 'About SwiftNet', click: () => this.openInternal('settings')},
            {type: 'separator'},
            {label: 'Developer tools', accelerator: 'F12', click: () => this.command('devtools')},
            {type: 'separator'},
            {label: 'Exit', click: () => app.quit()}
        ];
        Menu.buildFromTemplate(template).popup({window: this.win, x: pos && pos.x, y: pos && pos.y});
    }

    state () {
        const tab = this.current();
        const url = tab ? tab.view.webContents.getURL() || tab.url : '';
        return {
            tabs: this.tabs.map(t => ({id: t.id, title: t.title, url: t.view.webContents.getURL() || t.url, favicon: t.favicon, loading: t.loading,
                audible: t.view.webContents.isCurrentlyAudible()})),
            active: this.active,
            url,
            canBack: tab ? tab.view.webContents.navigationHistory.canGoBack() : false,
            canForward: tab ? tab.view.webContents.navigationHistory.canGoForward() : false,
            loading: tab ? tab.loading : false,
            zoom: tab ? Math.round(tab.view.webContents.getZoomFactor() * 100) : 100,
            bookmarked: bookmarks.some(b => b.url === url),
            bookmarks: settings.bookmarksBar ? bookmarks : null,
            theme: settings.theme,
            maximized: this.win.isMaximized(),
            focused: this.win.isFocused(),
            fullscreen: this.win.isFullScreen(),
            htmlFullscreen: !!this.fullscreenTab,
            claudeOpen: this.claudeOpen,
            update: latestUpdate,
            downloads: downloadList().filter(d => d.state === 'progressing' || Date.now() - d.time < 60000).slice(-4),
            searchName: SEARCH[settings.search].name
        };
    }

    sendState () {
        if (this.win.isDestroyed() || this.wc.isLoading()) return;
        clearTimeout(this.stateTimer);
        this.stateTimer = setTimeout(() => {
            if (!this.win.isDestroyed()) this.wc.send('state', this.state());
        }, 16);
    }

    saveSession () {
        writeJson('session.json', sessionTabs());
    }
}

const sessionTabs = () => {
    const out = [];
    for (const w of windows) out.push(w.tabs.map(t => t.view.webContents.getURL() || t.url).filter(u => /^https?:/.test(u)));
    return out.filter(list => list.length);
};

const toggleBookmark = tab => {
    if (!tab) return;
    const url = tab.view.webContents.getURL();
    if (!/^https?:/.test(url)) return;
    const i = bookmarks.findIndex(b => b.url === url);
    if (i >= 0) bookmarks.splice(i, 1);
    else bookmarks.push({title: tab.title || url, url});
    saveBookmarks();
};

const savePage = async (win, wc) => {
    const {canceled, filePath} = await dialog.showSaveDialog(win, {
        defaultPath: path.join(app.getPath('downloads'), `${(wc.getTitle() || 'page').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}.html`),
        filters: [{name: 'Web page, complete', extensions: ['html']}]
    });
    if (!canceled && filePath) wc.savePage(filePath, 'HTMLComplete').catch(() => {});
};

// ------------------------------------------------------------ downloads
const downloads = new Map();
let nextDownload = 1;
const downloadList = () => [...downloads.values()].map(d => ({
    id: d.id, name: d.name, path: d.path, url: d.url, received: d.received, total: d.total, state: d.state, paused: d.paused, time: d.time
}));
const uniquePath = (dir, name) => {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    let candidate = path.join(dir, name);
    for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`);
    return candidate;
};
const broadcast = () => {
    for (const w of windows) w.sendState();
    for (const wc of require('electron').webContents.getAllWebContents()) {
        if (!wc.isDestroyed() && wc.getURL().startsWith('swiftnet://downloads')) wc.send('sn:changed', 'downloads');
    }
};

// ------------------------------------------------------------ updates
let latestUpdate = null;
const newer = (a, b) => {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    }
    return false;
};
const checkUpdate = async () => {
    try {
        const r = await net.fetch(`${UPDATE_URL}?t=${Date.now()}`, {cache: 'no-store'});
        const j = await r.json();
        latestUpdate = j && j.version && newer(j.version, app.getVersion()) ? {version: j.version, notes: j.notes || ''} : null;
    } catch (e) {
        latestUpdate = null;
    }
    for (const w of windows) w.sendState();
    return latestUpdate;
};

// ------------------------------------------------------------ the browsing session
const setupSession = () => {
    const ses = session.fromPartition(PARTITION);
    // look like normal Chrome so sites don't treat SwiftNet as an unknown app
    ses.setUserAgent(ses.getUserAgent().replace(/ (SwiftNet|swiftnet|Electron)\/\S+/g, ''));
    app.userAgentFallback = ses.getUserAgent();

    const allowed = new Map();
    const ask = {media: 'use your camera and microphone', geolocation: 'know your location', notifications: 'show notifications',
        'clipboard-read': 'see text and images you copied', midi: 'use MIDI devices', 'display-capture': 'see your screen'};
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
        if (['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'window-management'].includes(permission)) return callback(true);
        if (!ask[permission]) return callback(false);
        let origin = '';
        try {
            origin = new URL(details.requestingUrl || wc.getURL()).origin;
        } catch (e) {
            return callback(false);
        }
        const key = `${origin}|${permission}`;
        if (allowed.has(key)) return callback(allowed.get(key));
        const win = BrowserWindow.fromWebContents(wc) || [...windows].map(w => w.win).find(w => w.isFocused()) || null;
        dialog.showMessageBox(win, {type: 'question', buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1, noLink: true,
            message: `${new URL(origin).host} wants to ${ask[permission]}.`}).then(({response}) => {
            allowed.set(key, response === 0);
            callback(response === 0);
        });
    });
    ses.setPermissionCheckHandler((wc, permission, origin) => {
        if (['fullscreen', 'clipboard-sanitized-write'].includes(permission)) return true;
        return allowed.get(`${origin}|${permission}`) === true;
    });

    ses.on('will-download', (event, item) => {
        const id = nextDownload++;
        const savePath = uniquePath(app.getPath('downloads'), item.getFilename());
        item.setSavePath(savePath);
        const d = {id, item, name: path.basename(savePath), path: savePath, url: item.getURL(), received: 0, total: item.getTotalBytes(),
            state: 'progressing', paused: false, time: Date.now()};
        downloads.set(id, d);
        item.on('updated', (e, state) => {
            d.state = state === 'interrupted' ? 'interrupted' : 'progressing';
            d.received = item.getReceivedBytes();
            d.total = item.getTotalBytes();
            d.paused = item.isPaused();
            broadcast();
        });
        item.once('done', (e, state) => {
            d.state = state; // completed, cancelled or interrupted
            d.received = item.getReceivedBytes();
            d.time = Date.now();
            broadcast();
        });
        broadcast();
    });

    // swiftnet:// pages (settings, history, downloads, bookmarks, error)
    ses.protocol.handle('swiftnet', req => {
        const u = new URL(req.url);
        const name = u.host.replace(/[^a-z]/g, '');
        const file = u.pathname && u.pathname !== '/' ? path.basename(u.pathname) : `${name}.html`;
        const full = pagePath(file);
        if (!full.startsWith(pagePath('')) || !fs.existsSync(full)) return new Response('Not found', {status: 404});
        const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.png') ? 'image/png' : 'text/html';
        return new Response(fs.readFileSync(full), {headers: {'content-type': `${type}; charset=utf-8`}});
    });
};

// ------------------------------------------------------------ messages from the browser UI and swiftnet:// pages
const fromInternalPage = e => {
    try {
        return new URL(e.senderFrame.url).protocol === 'swiftnet:';
    } catch (err) {
        return false;
    }
};
const windowOf = e => [...windows].find(w => w.wc === e.sender) ||
    [...windows].find(w => w.tabs.some(t => t.view.webContents === e.sender));

ipcMain.on('ui:command', (e, cmd, arg) => {
    const w = [...windows].find(x => x.wc === e.sender);
    if (w) w.command(cmd, arg);
});
ipcMain.on('ui:layout', (e, top, bottom) => {
    const w = [...windows].find(x => x.wc === e.sender);
    if (!w) return;
    w.top = Math.max(0, Math.round(top));
    w.bottom = Math.max(0, Math.round(bottom));
    w.layout();
});
ipcMain.on('ui:ready', e => {
    const w = [...windows].find(x => x.wc === e.sender);
    if (w) w.sendState();
});
ipcMain.on('ui:find', (e, text, opts) => {
    const w = [...windows].find(x => x.wc === e.sender);
    const tab = w && w.current();
    if (!tab) return;
    if (text) tab.view.webContents.findInPage(text, opts || {});
    else tab.view.webContents.stopFindInPage('clearSelection');
});
ipcMain.on('ui:download', (e, action, id) => {
    const d = downloads.get(id);
    if (!d) return;
    if (action === 'open') shell.openPath(d.path);
    else if (action === 'show') shell.showItemInFolder(d.path);
    else if (action === 'cancel' && d.state === 'progressing') d.item.cancel();
    else if (action === 'pause' && d.state === 'progressing') (d.item.isPaused() ? d.item.resume() : d.item.pause());
    else if (action === 'remove') downloads.delete(id);
    broadcast();
});
ipcMain.on('ui:bookmarkMenu', (e, index) => {
    const w = [...windows].find(x => x.wc === e.sender);
    const b = bookmarks[index];
    if (!w || !b) return;
    Menu.buildFromTemplate([
        {label: 'Open in new tab', click: () => w.newTab(b.url, {foreground: false})},
        {label: 'Copy address', click: () => clipboard.writeText(b.url)},
        {type: 'separator'},
        {label: 'Remove', click: () => {
            bookmarks.splice(index, 1);
            saveBookmarks();
        }}
    ]).popup({window: w.win});
});

ipcMain.handle('sn:get', async (e, what, arg) => {
    if (!fromInternalPage(e)) return null;
    if (what === 'settings') return {settings, search: Object.fromEntries(Object.entries(SEARCH).map(([k, v]) => [k, v.name])), version: app.getVersion(),
        chrome: process.versions.chrome, electron: process.versions.electron, platform: process.platform, home: HOME_DEFAULT};
    if (what === 'history') {
        const q = String(arg || '').toLowerCase();
        return history.filter(h => !q || h.title.toLowerCase().includes(q) || h.url.toLowerCase().includes(q)).slice(-1500).reverse();
    }
    if (what === 'bookmarks') return bookmarks;
    if (what === 'downloads') return downloadList().reverse();
    if (what === 'update') return checkUpdate().then(u => ({update: u, version: app.getVersion()}));
    return null;
});
ipcMain.handle('sn:set', async (e, what, value) => {
    if (!fromInternalPage(e)) return false;
    if (what === 'setting' && value && typeof value.key === 'string') {
        const ok = {theme: ['aero', 'modern'], search: Object.keys(SEARCH), startup: ['home', 'restore']};
        if (ok[value.key] && !ok[value.key].includes(value.value)) return false;
        if (value.key === 'home') {
            const v = String(value.value || '').trim();
            settings.home = v ? toUrl(v) : HOME_DEFAULT;
        } else if (value.key === 'bookmarksBar') {
            settings.bookmarksBar = !!value.value;
        } else if (ok[value.key]) {
            settings[value.key] = value.value;
        } else {
            return false;
        }
        saveSettings();
        return true;
    }
    if (what === 'clearHistory') {
        history = [];
        writeJson('history.json', history);
        return true;
    }
    if (what === 'removeHistory') {
        history = history.filter(h => !(h.url === value.url && h.time === value.time));
        writeJson('history.json', history);
        return true;
    }
    if (what === 'clearData') {
        const ses = session.fromPartition(PARTITION);
        if (value && value.cache) await ses.clearCache();
        if (value && value.cookies) await ses.clearStorageData();
        if (value && value.history) {
            history = [];
            writeJson('history.json', history);
        }
        return true;
    }
    if (what === 'bookmarks' && Array.isArray(value)) {
        bookmarks = value.filter(b => b && typeof b.url === 'string' && /^https?:/.test(b.url)).slice(0, 500)
            .map(b => ({title: String(b.title || b.url).slice(0, 200), url: b.url}));
        saveBookmarks();
        return true;
    }
    if (what === 'download') {
        const d = downloads.get(value.id);
        if (d && value.action === 'open') shell.openPath(d.path);
        if (d && value.action === 'show') shell.showItemInFolder(d.path);
        if (d && value.action === 'cancel' && d.state === 'progressing') d.item.cancel();
        if (value.action === 'clear') for (const [id, x] of downloads) if (x.state !== 'progressing') downloads.delete(id);
        broadcast();
        return true;
    }
    if (what === 'open') {
        const w = windowOf(e);
        if (w && typeof value === 'string') w.newTab(value);
        return true;
    }
    return false;
});

// ------------------------------------------------------------ app start
const urlsFromArgs = argv => argv.slice(1).filter(a => /^(https?:\/\/|file:)/i.test(a));

app.on('second-instance', (e, argv) => {
    const urls = urlsFromArgs(argv);
    const w = [...windows].find(x => x.win.isFocused()) || [...windows][0];
    if (w && urls.length) urls.forEach(u => w.newTab(u));
    else if (!w) new SwiftWindow(urls);
    if (w) {
        if (w.win.isMinimized()) w.win.restore();
        w.win.focus();
    }
});
app.on('open-url', (e, url) => {
    e.preventDefault();
    const w = [...windows][0];
    if (w) w.newTab(url);
    else app.whenReady().then(() => new SwiftWindow([url]));
});

app.whenReady().then(() => {
    loadData();
    setupSession();
    if (IS_MAC) {
        Menu.setApplicationMenu(Menu.buildFromTemplate([
            {role: 'appMenu'},
            {label: 'File', submenu: [
                {label: 'New Tab', accelerator: 'Cmd+T', click: () => (BrowserWindow.getFocusedWindow() ? [...windows].find(w => w.win === BrowserWindow.getFocusedWindow()).command('newTab') : new SwiftWindow())},
                {label: 'New Window', accelerator: 'Cmd+N', click: () => new SwiftWindow()},
                {role: 'close'}
            ]},
            {role: 'editMenu'},
            {role: 'windowMenu'}
        ]));
    } else {
        Menu.setApplicationMenu(null);
    }
    const args = urlsFromArgs(process.argv);
    const saved = readJson('session.json', []);
    if (args.length) new SwiftWindow(args);
    else if (settings.startup === 'restore' && saved.length) saved.forEach(list => new SwiftWindow(list));
    else new SwiftWindow();
    setTimeout(checkUpdate, 4000);
    setInterval(checkUpdate, 6 * 60 * 60 * 1000);
    // test hook: SWIFTNET_TEST=<script path> runs a test script with access to the app
    if (process.env.SWIFTNET_TEST) setTimeout(() => require(process.env.SWIFTNET_TEST)({app, windows, settings, SwiftWindow, bookmarks: () => bookmarks, history: () => history}), 1500);
});

app.on('before-quit', flushJson);
app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit();
});
app.on('activate', () => {
    if (!windows.size) new SwiftWindow();
});
