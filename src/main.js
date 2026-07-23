const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');

const CHROME_HEIGHT = 84; // tab strip + navigation bar height in px
const START_PAGE = 'file://' + path.join(__dirname, 'ui', 'start.html');

let win = null;
let blocker = null;
let activeTabId = null;
let nextTabId = 1;
const tabs = new Map(); // id -> { id, view, blocked }

// ---------------------------------------------------------------------------
// Ad / tracker blocking
// ---------------------------------------------------------------------------
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
    blocker.enableBlockingInSession(session.defaultSession);

    blocker.on('request-blocked', (request) => {
      for (const tab of tabs.values()) {
        if (tab.view.webContents.id === request.tabId) {
          tab.blocked += 1;
          break;
        }
      }
      sendStateThrottled();
    });

    console.log('Ad blocker enabled (EasyList + EasyPrivacy)');
  } catch (err) {
    // Offline or list download failed — browser still works, just without blocking.
    console.warn('Ad blocker could not be initialised:', err.message);
  }
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
// Tabs
// ---------------------------------------------------------------------------
function adblockerPreload() {
  try {
    return require.resolve('@ghostery/adblocker-electron-preload');
  } catch {
    return undefined;
  }
}

function createTab(url = START_PAGE, activate = true) {
  const id = nextTabId++;
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // background tabs keep running -> sessions stay alive
      preload: adblockerPreload(), // cosmetic filtering (hides leftover ad frames)
    },
  });

  const tab = { id, view, blocked: 0, keepAlive: false };
  tabs.set(id, tab);
  win.contentView.addChildView(view);

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url: target }) => {
    createTab(target); // popups open as tabs, never as popup windows
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
      y: CHROME_HEIGHT,
      width: w,
      height: Math.max(0, h - CHROME_HEIGHT),
    });
  }
}

// ---------------------------------------------------------------------------
// UI state sync
// ---------------------------------------------------------------------------
function sendState() {
  if (!win || win.isDestroyed()) return;
  const state = {
    activeTabId,
    tabs: [...tabs.values()].map((t) => {
      const wc = t.view.webContents;
      const url = wc.getURL();
      return {
        id: t.id,
        title: wc.getTitle() || 'नया टैब',
        url: url.startsWith('file://') ? '' : url,
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        blocked: t.blocked,
        keepAlive: t.keepAlive,
      };
    }),
  };
  win.webContents.send('state', state);
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
// Navigation
// ---------------------------------------------------------------------------
function toURL(input) {
  const text = input.trim();
  if (!text) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) return text;
  if (text === 'localhost' || text.startsWith('localhost:')) return 'http://' + text;
  // looks like a domain (has a dot, no spaces) -> treat as URL, otherwise search
  if (!text.includes(' ') && text.includes('.')) return 'https://' + text;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(text);
}

ipcMain.on('tab:new', () => createTab());
ipcMain.on('tab:close', (_e, id) => closeTab(id));
ipcMain.on('tab:activate', (_e, id) => activateTab(id));
ipcMain.on('nav:go', (_e, input) => {
  const url = toURL(input);
  const tab = activeTab();
  if (url && tab) tab.view.webContents.loadURL(url);
});
ipcMain.on('nav:back', () => {
  const tab = activeTab();
  if (tab && tab.view.webContents.navigationHistory.canGoBack()) {
    tab.view.webContents.navigationHistory.goBack();
  }
});
ipcMain.on('nav:forward', () => {
  const tab = activeTab();
  if (tab && tab.view.webContents.navigationHistory.canGoForward()) {
    tab.view.webContents.navigationHistory.goForward();
  }
});
ipcMain.on('nav:reload', () => {
  const tab = activeTab();
  if (tab) tab.view.webContents.reload();
});
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

// ---------------------------------------------------------------------------
// Window & menu
// ---------------------------------------------------------------------------
function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab() },
          {
            label: 'Close Tab',
            accelerator: 'CmdOrCtrl+W',
            click: () => closeTab(activeTabId),
          },
          { type: 'separator' },
          { role: 'quit' },
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
          {
            label: 'Reload Page',
            accelerator: 'CmdOrCtrl+R',
            click: () => {
              const tab = activeTab();
              if (tab) tab.view.webContents.reload();
            },
          },
          {
            label: 'Focus Address Bar',
            accelerator: 'CmdOrCtrl+L',
            click: () => win && win.webContents.send('focus-address'),
          },
          { type: 'separator' },
          {
            label: 'Toggle DevTools (page)',
            accelerator: 'CmdOrCtrl+Shift+I',
            click: () => {
              const tab = activeTab();
              if (tab) tab.view.webContents.toggleDevTools();
            },
          },
        ],
      },
    ])
  );
}

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
  win.webContents.on('did-finish-load', () => {
    if (tabs.size === 0) createTab();
    else sendState();
  });
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  buildMenu();
  await setupAdBlocker(); // block from the very first request
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
