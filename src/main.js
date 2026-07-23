const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  Menu,
  powerSaveBlocker,
  dialog,
  shell,
  clipboard,
  nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const store = require('./store');

// ---------------------------------------------------------------------------
// Settings (loaded before app.ready so startup flags can apply)
// ---------------------------------------------------------------------------
const settings = Object.assign(
  { adblockEnabled: true, dataSaver: false, forceDark: false, whitelist: [] },
  store.load('settings', {})
);
const whitelist = new Set(settings.whitelist);

function saveSettings() {
  settings.whitelist = [...whitelist];
  store.save('settings', settings);
}

if (settings.forceDark) {
  app.commandLine.appendSwitch('enable-features', 'WebContentsForceDark');
  nativeTheme.themeSource = 'dark';
}

// ---------------------------------------------------------------------------
// Constants & state
// ---------------------------------------------------------------------------
const DEFAULT_CHROME_HEIGHT = 84;
let chromeHeight = DEFAULT_CHROME_HEIGHT;
const START_PAGE = pathToFileURL(path.join(__dirname, 'ui', 'start.html')).href;
const PAGES_DIR = path.join(__dirname, 'ui', 'pages');
const PAGES_PREFIX = pathToFileURL(PAGES_DIR).href;
const INTERNAL_PAGES = {
  bookmarks: 'bookmarks.html',
  history: 'history.html',
  downloads: 'downloads.html',
};
const INTERNAL_PRELOAD = path.join(__dirname, 'internal-preload.js');
const HISTORY_LIMIT = 5000;

let win = null;
let blocker = null;
let privateSession = null;
let activeTabId = null;
let nextTabId = 1;
const tabs = new Map(); // id -> { id, view, blocked, keepAlive, isPrivate, muted, audible }
const closedTabs = []; // urls of recently closed tabs (this run only)

const bookmarks = store.load('bookmarks', []); // [{url, title, ts}]
const history = store.load('history', []); // [{url, title, ts}] newest first

const downloads = []; // [{id, filename, savePath, url, state, received, total, ts}]
const downloadItems = new Map(); // id -> DownloadItem
let nextDownloadId = 1;

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
function internalURL(name) {
  return pathToFileURL(path.join(PAGES_DIR, INTERNAL_PAGES[name])).href;
}

function displayURL(url) {
  if (!url || url === START_PAGE) return '';
  for (const name of Object.keys(INTERNAL_PAGES)) {
    if (url === internalURL(name)) return 'tez://' + name;
  }
  return url.startsWith('file://') ? '' : url;
}

function toURL(input) {
  const text = input.trim();
  if (!text) return null;
  if (text.startsWith('tez://')) {
    const name = text.slice(6).replace(/\/+$/, '');
    if (INTERNAL_PAGES[name]) return internalURL(name);
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) return text;
  if (text === 'localhost' || text.startsWith('localhost:')) return 'http://' + text;
  if (!text.includes(' ') && text.includes('.')) return 'https://' + text;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(text);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Ad / tracker blocking (with per-site whitelist)
// ---------------------------------------------------------------------------
function siteExceptionFilters(domain) {
  return ['@@*$domain=' + domain, '@@||' + domain + '^$elemhide,generichide'];
}

async function setupAdBlocker() {
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const fetch = require('cross-fetch');
    const cachePath = path.join(app.getPath('userData'), 'adblock-engine.bin');

    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cachePath,
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });

    // Re-apply persisted per-site whitelist as exception filters.
    const added = [];
    for (const domain of whitelist) added.push(...siteExceptionFilters(domain));
    if (added.length) blocker.updateFromDiff({ added });

    if (settings.adblockEnabled) {
      blocker.enableBlockingInSession(session.defaultSession);
      if (privateSession) blocker.enableBlockingInSession(privateSession);
    }

    blocker.on('request-blocked', (request) => {
      for (const tab of tabs.values()) {
        if (tab.view.webContents.id === request.tabId) {
          tab.blocked += 1;
          break;
        }
      }
      sendStateThrottled();
    });

    console.log('Ad blocker ready (EasyList + EasyPrivacy)');
  } catch (err) {
    console.warn('Ad blocker could not be initialised:', err.message);
  }
}

function setAdblockEnabled(on) {
  settings.adblockEnabled = on;
  saveSettings();
  if (!blocker) return;
  for (const ses of [session.defaultSession, privateSession]) {
    if (!ses) continue;
    try {
      if (on) blocker.enableBlockingInSession(ses);
      else blocker.disableBlockingInSession(ses);
    } catch {}
  }
  sendState();
}

function toggleSiteWhitelist() {
  const tab = activeTab();
  if (!tab) return;
  const domain = hostOf(tab.view.webContents.getURL());
  if (!domain) return;
  if (whitelist.has(domain)) {
    whitelist.delete(domain);
    if (blocker) blocker.updateFromDiff({ removed: siteExceptionFilters(domain) });
  } else {
    whitelist.add(domain);
    if (blocker) blocker.updateFromDiff({ added: siteExceptionFilters(domain) });
  }
  saveSettings();
  tab.view.webContents.reload();
  sendState();
}

// ---------------------------------------------------------------------------
// Sessions (default + private) — preloads and download handling
// ---------------------------------------------------------------------------
function wireSession(ses) {
  ses.setPreloads([...ses.getPreloads(), INTERNAL_PRELOAD]);
  ses.on('will-download', (_e, item) => {
    const id = nextDownloadId++;
    const savePath = uniquePath(app.getPath('downloads'), item.getFilename());
    item.setSavePath(savePath);
    const entry = {
      id,
      filename: path.basename(savePath),
      savePath,
      url: item.getURL(),
      state: 'progressing',
      received: 0,
      total: item.getTotalBytes(),
      ts: Date.now(),
    };
    downloads.unshift(entry);
    downloadItems.set(id, item);

    item.on('updated', (_ev, state) => {
      entry.received = item.getReceivedBytes();
      entry.total = item.getTotalBytes();
      entry.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
      sendStateThrottled();
    });
    item.once('done', (_ev, state) => {
      entry.received = item.getReceivedBytes();
      entry.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
      downloadItems.delete(id);
      sendStateThrottled();
    });
    sendStateThrottled();
  });
}

function uniquePath(dir, name) {
  let p = path.join(dir, name);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 1; ; i++) {
    p = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
}

function getPrivateSession() {
  if (!privateSession) {
    privateSession = session.fromPartition('tez-private'); // in-memory, wiped on exit
    wireSession(privateSession);
    if (blocker && settings.adblockEnabled) blocker.enableBlockingInSession(privateSession);
  }
  return privateSession;
}

// ---------------------------------------------------------------------------
// Keep-alive: prevent inactivity auto-logout on sites where the user enables it
// ---------------------------------------------------------------------------
const KEEP_ALIVE_INTERVAL_MS = 60 * 1000;
let powerBlockerId = null;

// Simulated user activity: fires the events idle-timers listen for
// (mousemove / scroll / keydown). It does not type into fields or click.
const KEEP_ALIVE_SNIPPET = `(() => {
  try {
    const x = Math.floor(Math.random() * window.innerWidth);
    const y = Math.floor(Math.random() * window.innerHeight);
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    document.dispatchEvent(new MouseEvent('mousemove', opts));
    window.dispatchEvent(new Event('scroll', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Shift' }));
    document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }));
  } catch (e) {}
})();`;

setInterval(() => {
  for (const tab of tabs.values()) {
    const wc = tab.view.webContents;
    if (tab.keepAlive && !wc.isDestroyed() && !wc.isLoading()) {
      wc.executeJavaScript(KEEP_ALIVE_SNIPPET, true).catch(() => {});
    }
  }
}, KEEP_ALIVE_INTERVAL_MS);

// While any tab has keep-alive on, stop the OS from suspending the app.
function updatePowerBlocker() {
  const anyKeepAlive = [...tabs.values()].some((t) => t.keepAlive);
  if (anyKeepAlive && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!anyKeepAlive && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
}

// ---------------------------------------------------------------------------
// History & bookmarks
// ---------------------------------------------------------------------------
function recordHistory(url, title) {
  if (!/^https?:\/\//.test(url)) return;
  if (history[0] && history[0].url === url) return;
  history.unshift({ url, title: title || url, ts: Date.now() });
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  store.saveDebounced('history', history);
}

function updateHistoryTitle(url, title) {
  for (let i = 0; i < Math.min(history.length, 25); i++) {
    if (history[i].url === url) {
      history[i].title = title;
      store.saveDebounced('history', history);
      return;
    }
  }
}

function isBookmarked(url) {
  return bookmarks.some((b) => b.url === url);
}

function toggleBookmark() {
  const tab = activeTab();
  if (!tab) return;
  const wc = tab.view.webContents;
  const url = wc.getURL();
  if (!/^https?:\/\//.test(url)) return;
  const idx = bookmarks.findIndex((b) => b.url === url);
  if (idx >= 0) bookmarks.splice(idx, 1);
  else bookmarks.unshift({ url, title: wc.getTitle() || url, ts: Date.now() });
  store.save('bookmarks', bookmarks);
  sendState();
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function adblockerPreload() {
  try {
    return require.resolve('@ghostery/adblocker-electron-preload');
  } catch {
    return undefined;
  }
}

function createTab(url = START_PAGE, opts = {}) {
  const { activate = true, isPrivate = false } = opts;
  const id = nextTabId++;
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // background tabs keep running -> sessions stay alive
      images: !settings.dataSaver, // data saver: skip images in tabs opened while on
      partition: isPrivate ? 'tez-private' : undefined,
      preload: adblockerPreload(), // cosmetic filtering (hides leftover ad frames)
    },
  });
  if (isPrivate) getPrivateSession();

  const tab = { id, view, blocked: 0, keepAlive: false, isPrivate, muted: false, audible: false };
  tabs.set(id, tab);
  win.contentView.addChildView(view);

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url: target }) => {
    createTab(target, { isPrivate }); // popups open as tabs, never as popup windows
    return { action: 'deny' };
  });
  for (const ev of [
    'page-title-updated',
    'did-start-loading',
    'did-stop-loading',
    'did-navigate',
    'did-navigate-in-page',
  ]) {
    wc.on(ev, sendStateThrottled);
  }
  wc.on('did-navigate', (_e, navUrl) => {
    if (!isPrivate) recordHistory(navUrl, wc.getTitle());
    saveSessionDebounced();
  });
  wc.on('page-title-updated', (_e, title) => {
    if (!isPrivate) updateHistoryTitle(wc.getURL(), title);
  });
  wc.on('audio-state-changed', () => {
    tab.audible = !wc.isDestroyed() && wc.isCurrentlyAudible();
    sendStateThrottled();
  });
  wc.on('found-in-page', (_e, result) => {
    if (tab.id === activeTabId && win) {
      win.webContents.send('find:result', {
        active: result.activeMatchOrdinal,
        matches: result.matches,
      });
    }
  });
  wc.on('context-menu', (_e, params) => showContextMenu(wc, params));

  wc.loadURL(url);
  if (activate) activateTab(id);
  else sendState();
  return tab;
}

function activateTab(id) {
  if (!tabs.has(id)) return;
  activeTabId = id;
  for (const tab of tabs.values()) {
    tab.view.setVisible(tab.id === id);
  }
  layout();
  sendState();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  const url = tab.view.webContents.getURL();
  if (!tab.isPrivate && /^https?:\/\//.test(url)) {
    closedTabs.push(url);
    if (closedTabs.length > 50) closedTabs.shift();
  }
  win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  tabs.delete(id);
  updatePowerBlocker();

  if (tabs.size === 0) {
    createTab();
    return;
  }
  if (activeTabId === id) {
    const remaining = [...tabs.keys()];
    activateTab(remaining[remaining.length - 1]);
  } else {
    sendState();
  }
}

function reopenClosedTab() {
  const url = closedTabs.pop();
  if (url) createTab(url);
}

function activeTab() {
  return tabs.get(activeTabId) || null;
}

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  const tab = activeTab();
  if (tab) {
    tab.view.setBounds({
      x: 0,
      y: chromeHeight,
      width: w,
      height: Math.max(0, h - chromeHeight),
    });
  }
}

// ---------------------------------------------------------------------------
// Session restore
// ---------------------------------------------------------------------------
function saveSession() {
  const list = [...tabs.values()].filter(
    (t) => !t.isPrivate && !t.view.webContents.isDestroyed()
  );
  if (list.length === 0) return;
  const urls = list
    .map((t) => t.view.webContents.getURL())
    .filter((u) => /^https?:\/\//.test(u) || u === START_PAGE || u.startsWith(PAGES_PREFIX));
  const activeIdx = list.findIndex((t) => t.id === activeTabId);
  store.save('session', { urls, active: activeIdx });
}

function saveSessionDebounced() {
  clearTimeout(saveSessionDebounced._t);
  saveSessionDebounced._t = setTimeout(saveSession, 1000);
}

function restoreSession() {
  const saved = store.load('session', null);
  if (!saved || !Array.isArray(saved.urls) || saved.urls.length === 0) {
    createTab();
    return;
  }
  let activeTabRef = null;
  saved.urls.forEach((u, i) => {
    const tab = createTab(u, { activate: false });
    if (i === saved.active) activeTabRef = tab;
  });
  activateTab((activeTabRef || [...tabs.values()][0]).id);
}

// ---------------------------------------------------------------------------
// UI state sync
// ---------------------------------------------------------------------------
function sendState() {
  if (!win || win.isDestroyed()) return;
  const active = activeTab();
  const activeURL = active ? active.view.webContents.getURL() : '';
  const state = {
    activeTabId,
    adblockEnabled: settings.adblockEnabled,
    activeWhitelisted: whitelist.has(hostOf(activeURL)),
    activeIsBookmarked: isBookmarked(activeURL),
    downloadsActive: downloads.filter((d) => d.state === 'progressing').length,
    tabs: [...tabs.values()].map((t) => {
      const wc = t.view.webContents;
      return {
        id: t.id,
        title: wc.getTitle() || 'नया टैब',
        url: displayURL(wc.getURL()),
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        blocked: t.blocked,
        keepAlive: t.keepAlive,
        isPrivate: t.isPrivate,
        audible: t.audible,
        muted: t.muted,
      };
    }),
  };
  win.webContents.send('state', state);
  saveSessionDebounced();
}

let stateTimer = null;
function sendStateThrottled() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    sendState();
  }, 100);
}

// ---------------------------------------------------------------------------
// Navigation actions
// ---------------------------------------------------------------------------
function navBack() {
  const tab = activeTab();
  if (tab && tab.view.webContents.navigationHistory.canGoBack()) {
    tab.view.webContents.navigationHistory.goBack();
  }
}
function navForward() {
  const tab = activeTab();
  if (tab && tab.view.webContents.navigationHistory.canGoForward()) {
    tab.view.webContents.navigationHistory.goForward();
  }
}
function navReload() {
  const tab = activeTab();
  if (tab) tab.view.webContents.reload();
}
function zoomActive(delta) {
  const tab = activeTab();
  if (!tab) return;
  const wc = tab.view.webContents;
  wc.setZoomLevel(delta === 0 ? 0 : wc.getZoomLevel() + delta);
}

// ---------------------------------------------------------------------------
// Page utilities: print, PDF, screenshot, clear data
// ---------------------------------------------------------------------------
async function savePageAsPDF() {
  const tab = activeTab();
  if (!tab) return;
  const wc = tab.view.webContents;
  try {
    const data = await wc.printToPDF({});
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: (wc.getTitle() || 'page').replace(/[\\/:*?"<>|]/g, '_') + '.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!canceled && filePath) fs.writeFileSync(filePath, data);
  } catch (err) {
    dialog.showErrorBox('PDF सेव नहीं हो पाया', String(err.message || err));
  }
}

async function fullPageScreenshot() {
  const tab = activeTab();
  if (!tab) return;
  const wc = tab.view.webContents;
  try {
    wc.debugger.attach('1.3');
    const { data } = await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    wc.debugger.detach();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: (wc.getTitle() || 'screenshot').replace(/[\\/:*?"<>|]/g, '_') + '.png',
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (!canceled && filePath) fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
  } catch (err) {
    try {
      wc.debugger.detach();
    } catch {}
    dialog.showErrorBox('स्क्रीनशॉट नहीं बन पाया', String(err.message || err));
  }
}

async function clearBrowsingData() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['हाँ, सब साफ़ करें', 'रहने दें'],
    defaultId: 1,
    cancelId: 1,
    message: 'ब्राउज़िंग डेटा साफ़ करें?',
    detail: 'कुकीज़, कैश और साइट डेटा मिट जाएगा — सभी साइटों से लॉगआउट हो जाएँगे। हिस्ट्री भी मिटेगी।',
  });
  if (response !== 0) return;
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearCache();
  history.length = 0;
  store.save('history', history);
  sendState();
}

// ---------------------------------------------------------------------------
// Context menu (right click on pages)
// ---------------------------------------------------------------------------
function showContextMenu(wc, params) {
  const items = [];
  const tab = [...tabs.values()].find((t) => t.view.webContents === wc);

  items.push(
    { label: 'पीछे', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'आगे', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: 'रीलोड', click: () => wc.reload() },
    { type: 'separator' }
  );

  if (params.linkURL) {
    items.push(
      { label: 'लिंक नई टैब में खोलें', click: () => createTab(params.linkURL, { isPrivate: tab ? tab.isPrivate : false }) },
      { label: 'लिंक कॉपी करें', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' }
    );
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push(
      { label: 'इमेज सेव करें', click: () => wc.downloadURL(params.srcURL) },
      { label: 'इमेज कॉपी करें', click: () => wc.copyImageAt(params.x, params.y) },
      { type: 'separator' }
    );
  }
  if (params.selectionText && params.selectionText.trim()) {
    const text = params.selectionText.trim();
    const short = text.length > 30 ? text.slice(0, 30) + '…' : text;
    items.push(
      { label: 'कॉपी', role: 'copy' },
      {
        label: `"${short}" सर्च करें`,
        click: () => createTab('https://duckduckgo.com/?q=' + encodeURIComponent(text)),
      },
      { type: 'separator' }
    );
  }
  if (params.isEditable) {
    items.push({ role: 'cut', label: 'कट' }, { role: 'paste', label: 'पेस्ट' }, { type: 'separator' });
  }
  items.push({ label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) });

  Menu.buildFromTemplate(items).popup({ window: win });
}

// ---------------------------------------------------------------------------
// IPC: toolbar
// ---------------------------------------------------------------------------
ipcMain.on('tab:new', () => createTab());
ipcMain.on('tab:new-private', () => createTab(START_PAGE, { isPrivate: true }));
ipcMain.on('tab:close', (_e, id) => closeTab(id));
ipcMain.on('tab:activate', (_e, id) => activateTab(id));
ipcMain.on('tab:mute', (_e, id) => {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.muted = !tab.muted;
  tab.view.webContents.setAudioMuted(tab.muted);
  sendState();
});
ipcMain.on('nav:go', (_e, input) => {
  const url = toURL(input);
  const tab = activeTab();
  if (url && tab) tab.view.webContents.loadURL(url);
});
ipcMain.on('nav:back', navBack);
ipcMain.on('nav:forward', navForward);
ipcMain.on('nav:reload', navReload);
ipcMain.on('nav:stop', () => {
  const tab = activeTab();
  if (tab) tab.view.webContents.stop();
});
ipcMain.on('keepalive:toggle', (_e, id) => {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.keepAlive = !tab.keepAlive;
  updatePowerBlocker();
  sendState();
});
ipcMain.on('bookmark:toggle', toggleBookmark);
ipcMain.on('shield:toggle', toggleSiteWhitelist);
ipcMain.on('internal:open', (_e, name) => {
  if (INTERNAL_PAGES[name]) createTab(internalURL(name));
});
ipcMain.on('ui:chrome-height', (_e, h) => {
  chromeHeight = Math.max(DEFAULT_CHROME_HEIGHT, Math.min(200, Number(h) || DEFAULT_CHROME_HEIGHT));
  layout();
});
ipcMain.on('ui:menu', (_e, pos) => {
  Menu.buildFromTemplate(menuTemplate()).popup({
    window: win,
    x: Math.round(pos.x),
    y: Math.round(pos.y),
  });
});
ipcMain.on('find:start', (_e, text) => {
  const tab = activeTab();
  if (tab && text) tab.view.webContents.findInPage(text);
});
ipcMain.on('find:next', (_e, { text, forward }) => {
  const tab = activeTab();
  if (tab && text) tab.view.webContents.findInPage(text, { forward, findNext: true });
});
ipcMain.on('find:stop', () => {
  const tab = activeTab();
  if (tab) tab.view.webContents.stopFindInPage('clearSelection');
});

// ---------------------------------------------------------------------------
// IPC: internal pages (bookmarks / history / downloads)
// Only frames actually loaded from src/ui/pages/ may use these.
// ---------------------------------------------------------------------------
function isInternalSender(event) {
  const frame = event.senderFrame;
  return !!frame && frame.url.startsWith(PAGES_PREFIX);
}

ipcMain.handle('tez:list', (event, kind) => {
  if (!isInternalSender(event)) return null;
  if (kind === 'bookmarks') return bookmarks;
  if (kind === 'history') return history.slice(0, 1000);
  if (kind === 'downloads') return downloads;
  return null;
});

ipcMain.handle('tez:action', (event, { kind, action, payload }) => {
  if (!isInternalSender(event)) return false;

  if (kind === 'open' && typeof payload === 'string' && /^https?:\/\//.test(payload)) {
    createTab(payload);
    return true;
  }
  if (kind === 'bookmarks') {
    if (action === 'remove') {
      const idx = bookmarks.findIndex((b) => b.url === payload);
      if (idx >= 0) bookmarks.splice(idx, 1);
      store.save('bookmarks', bookmarks);
      sendState();
      return true;
    }
  }
  if (kind === 'history') {
    if (action === 'remove') {
      const idx = history.findIndex((h) => h.url === payload.url && h.ts === payload.ts);
      if (idx >= 0) history.splice(idx, 1);
      store.save('history', history);
      return true;
    }
    if (action === 'clear') {
      history.length = 0;
      store.save('history', history);
      return true;
    }
  }
  if (kind === 'downloads') {
    const entry = downloads.find((d) => d.id === payload);
    const item = downloadItems.get(payload);
    if (action === 'pause' && item) return item.pause(), true;
    if (action === 'resume' && item && item.canResume()) return item.resume(), true;
    if (action === 'cancel' && item) return item.cancel(), true;
    if (action === 'open' && entry && entry.state === 'completed') {
      shell.openPath(entry.savePath);
      return true;
    }
    if (action === 'show' && entry) {
      shell.showItemInFolder(entry.savePath);
      return true;
    }
    if (action === 'clear') {
      for (let i = downloads.length - 1; i >= 0; i--) {
        if (downloads[i].state !== 'progressing' && downloads[i].state !== 'paused') downloads.splice(i, 1);
      }
      sendState();
      return true;
    }
  }
  return false;
});

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------
function menuTemplate() {
  return [
    {
      label: 'File',
      submenu: [
        { label: 'नया टैब', accelerator: 'CmdOrCtrl+T', click: () => createTab() },
        {
          label: 'नया प्राइवेट टैब 🕶',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createTab(START_PAGE, { isPrivate: true }),
        },
        { label: 'बंद टैब वापस खोलें', accelerator: 'CmdOrCtrl+Shift+T', click: reopenClosedTab },
        { label: 'टैब बंद करें', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabId) },
        { type: 'separator' },
        {
          label: 'प्रिंट…',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            const tab = activeTab();
            if (tab) tab.view.webContents.print();
          },
        },
        { label: 'पेज को PDF में सेव करें…', click: savePageAsPDF },
        { label: 'पूरे पेज का स्क्रीनशॉट…', click: fullPageScreenshot },
        { type: 'separator' },
        { role: 'quit', label: 'बंद करें' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'रीलोड', accelerator: 'CmdOrCtrl+R', click: navReload },
        { label: 'एड्रेस बार', accelerator: 'CmdOrCtrl+L', click: () => win && win.webContents.send('focus-address') },
        { label: 'पेज में खोजें…', accelerator: 'CmdOrCtrl+F', click: () => win && win.webContents.send('find:open') },
        { type: 'separator' },
        { label: 'ज़ूम बढ़ाएँ', accelerator: 'CmdOrCtrl+=', click: () => zoomActive(0.5) },
        { label: 'ज़ूम घटाएँ', accelerator: 'CmdOrCtrl+-', click: () => zoomActive(-0.5) },
        { label: 'ज़ूम रीसेट', accelerator: 'CmdOrCtrl+0', click: () => zoomActive(0) },
        { type: 'separator' },
        {
          label: 'DevTools (page)',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => {
            const tab = activeTab();
            if (tab) tab.view.webContents.toggleDevTools();
          },
        },
      ],
    },
    {
      label: 'Library',
      submenu: [
        { label: '⭐ बुकमार्क जोड़ें/हटाएँ', accelerator: 'CmdOrCtrl+D', click: toggleBookmark },
        { label: 'बुकमार्क देखें', accelerator: 'CmdOrCtrl+B', click: () => createTab(internalURL('bookmarks')) },
        { label: 'हिस्ट्री', accelerator: 'CmdOrCtrl+H', click: () => createTab(internalURL('history')) },
        { label: 'डाउनलोड', accelerator: 'CmdOrCtrl+J', click: () => createTab(internalURL('downloads')) },
      ],
    },
    {
      label: 'Settings',
      submenu: [
        {
          label: 'ऐड-ब्लॉकर',
          type: 'checkbox',
          checked: settings.adblockEnabled,
          click: (item) => setAdblockEnabled(item.checked),
        },
        {
          label: 'डेटा सेवर (नई टैबों में इमेज बंद)',
          type: 'checkbox',
          checked: settings.dataSaver,
          click: (item) => {
            settings.dataSaver = item.checked;
            saveSettings();
          },
        },
        {
          label: 'डार्क मोड (हर साइट पर) — रीस्टार्ट ज़रूरी',
          type: 'checkbox',
          checked: settings.forceDark,
          click: (item) => {
            settings.forceDark = item.checked;
            saveSettings();
            dialog.showMessageBox(win, {
              message: 'डार्क मोड ' + (item.checked ? 'चालू' : 'बंद') + ' होगा',
              detail: 'यह बदलाव ब्राउज़र दोबारा खोलने पर लागू होगा।',
            });
          },
        },
        { type: 'separator' },
        { label: '🧹 ब्राउज़िंग डेटा साफ़ करें…', click: clearBrowsingData },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#1b1d23',
    title: 'TezBrowser',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('resize', layout);
  win.on('close', saveSession);
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') navBack();
    else if (cmd === 'browser-forward') navForward();
  });
  win.webContents.on('did-finish-load', () => {
    if (tabs.size === 0) restoreSession();
    else sendState();
  });
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
  wireSession(session.defaultSession);
  await setupAdBlocker(); // block from the very first request
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', saveSession);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
