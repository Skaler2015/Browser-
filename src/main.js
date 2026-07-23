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
  powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// ---------------------------------------------------------------------------
// Profiles: --profile=<id> keeps its own userData dir (separate logins/history)
// ---------------------------------------------------------------------------
const BASE_USERDATA = app.getPath('userData');
const PROFILE = (() => {
  const arg = process.argv.find((a) => a.startsWith('--profile='));
  return arg ? arg.split('=')[1].replace(/[^\w-]/g, '') : '';
})();
if (PROFILE) {
  app.setPath('userData', path.join(BASE_USERDATA, 'profiles', PROFILE));
}
const PROFILES_REGISTRY = path.join(BASE_USERDATA, 'profiles.json');

function profileRegistry() {
  try {
    return JSON.parse(fs.readFileSync(PROFILES_REGISTRY, 'utf8'));
  } catch {
    return [];
  }
}

function switchProfile(id) {
  const args = process.argv
    .slice(1)
    .filter((a) => !a.startsWith('--profile='))
    .concat(id ? ['--profile=' + id] : []);
  app.relaunch({ args });
  app.quit();
}

function createNewProfile() {
  const reg = profileRegistry();
  const id = 'p' + Date.now();
  reg.push({ id, name: 'प्रोफ़ाइल ' + (reg.length + 2) });
  try {
    fs.mkdirSync(BASE_USERDATA, { recursive: true });
    fs.writeFileSync(PROFILES_REGISTRY, JSON.stringify(reg));
  } catch (err) {
    console.warn('profile registry:', err.message);
    return;
  }
  switchProfile(id);
}

const store = require('./store');

// ---------------------------------------------------------------------------
// Settings (loaded before app.ready so startup flags can apply)
// ---------------------------------------------------------------------------
const settings = Object.assign(
  {
    adblockEnabled: true,
    dataSaver: false,
    forceDark: false,
    whitelist: [],
    searchEngine: 'duckduckgo',
    httpsOnly: true,
    tabSleep: true,
    askDownloadPath: false,
    downloadDir: '',
    theme: 'dark',
    customFilters: '',
    timeLimits: {}, // host -> minutes per day
    simpleMode: false, // बड़े-बुज़ुर्ग मोड
    scamProtection: true, // भारत-केंद्रित ठगी चेतावनी
    dataPackRate: 15, // ₹ per GB, for the money-saved meter
  },
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

const SEARCH_ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', search: 'https://duckduckgo.com/?q=', action: 'https://duckduckgo.com/' },
  google: { name: 'Google', search: 'https://www.google.com/search?q=', action: 'https://www.google.com/search' },
  bing: { name: 'Bing', search: 'https://www.bing.com/search?q=', action: 'https://www.bing.com/search' },
  brave: { name: 'Brave', search: 'https://search.brave.com/search?q=', action: 'https://search.brave.com/search' },
};
function engine() {
  return SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.duckduckgo;
}

const THEMES = ['dark', 'light', 'blue', 'green', 'purple'];
const THEME_NAMES = { dark: 'डार्क', light: 'लाइट', blue: 'नीला', green: 'हरा', purple: 'बैंगनी' };
const TAB_COLORS = { red: 'लाल', yellow: 'पीला', green: 'हरा', blue: 'नीला', purple: 'बैंगनी' };

// ---------------------------------------------------------------------------
// Constants & state
// ---------------------------------------------------------------------------
const DEFAULT_CHROME_HEIGHT = 84;
let chromeHeight = DEFAULT_CHROME_HEIGHT;
const PAGES_DIR = path.join(__dirname, 'ui', 'pages');
const PAGES_PREFIX = pathToFileURL(PAGES_DIR).href;
const START_PAGE = pathToFileURL(path.join(PAGES_DIR, 'start.html')).href;
const INTERNAL_PAGES = {
  bookmarks: 'bookmarks.html',
  history: 'history.html',
  downloads: 'downloads.html',
  reader: 'reader.html',
  stats: 'stats.html',
  analytics: 'analytics.html',
  timemachine: 'timemachine.html',
};
const INTERNAL_PRELOAD = path.join(__dirname, 'internal-preload.js');
const HISTORY_LIMIT = 5000;
const TAB_SLEEP_AFTER_MS = 30 * 60 * 1000; // background tabs sleep after 30 min

let win = null;
let blocker = null;
let privateSession = null;
let activeTabId = null;
let splitTabId = null; // tab shown in the right half of split view
let nextTabId = 1;
let nextIdentity = 1; // counter for double-account (isolated) tab partitions
const wiredPartitions = new Set(); // partitions already given preloads/downloads/adblock
const tabs = new Map(); // id -> tab object
let tabOrder = []; // tab ids in display order (pinned first)
const closedTabs = []; // urls of recently closed tabs (this run only)
const httpAllowed = new Set(); // hosts the user chose to open over plain http
const dangerAllowed = new Set(); // flagged hosts the user chose to open anyway
let dangerDomains = new Set(); // malware/phishing hosts (URLhaus feed)
let readerContent = null; // {title, url, html} for the reader page

const bookmarks = store.load('bookmarks', []); // [{url, title, ts}]
const history = store.load('history', []); // [{url, title, ts}] newest first
const zoomLevels = store.load('zoom', {}); // host -> zoom level
const stats = Object.assign({ total: 0, days: {} }, store.load('stats', {}));

// All analytics data stays on this machine only; private tabs are never recorded.
const analytics = Object.assign(
  {
    time: {}, // day -> { host: seconds actively viewed }
    hours: {}, // day -> { hour(0-23): seconds }
    data: {}, // day -> { host: bytes downloaded }
    trackers: {}, // blocked tracker host -> count
    siteBlocked: {}, // site host -> count of ads/trackers blocked there
    limitBlocked: { date: '', hosts: [] }, // sites the user blocked for today
    downloads: { count: 0, bytes: 0 },
  },
  store.load('analytics', {})
);

const downloads = []; // [{id, filename, savePath, url, state, received, total, ts}]
const downloadItems = new Map(); // id -> DownloadItem
let nextDownloadId = 1;

// Time-machine: hourly local snapshots of open (non-private) tabs
const timeMachine = store.load('timemachine', []); // [{ts, urls:[...]}]

// Upload sidebar (custom in-browser file picker) state
const SIDEBAR_W = 340;
let sidebarWidth = 0;
let uploadTargetId = null;
const favFolders = store.load('favfolders', []); // favourite folder paths
const recentFiles = store.load('recentfiles', []); // [{path, name, ts}] recently uploaded/downloaded
let lastBrowseDir = ''; // remember where the user browsed last

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
function internalURL(name) {
  return pathToFileURL(path.join(PAGES_DIR, INTERNAL_PAGES[name])).href;
}

function displayURL(url) {
  if (!url || url === START_PAGE || url === 'about:blank') return '';
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
    if (name === 'start' || name === 'newtab') return START_PAGE;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) return text;
  if (text === 'localhost' || text.startsWith('localhost:')) return 'http://' + text;
  if (!text.includes(' ') && text.includes('.')) return 'https://' + text;
  return engine().search + encodeURIComponent(text);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// The URL a tab "is on" — for sleeping tabs, the page it will wake up to.
function tabURL(tab) {
  if (tab.asleep) return tab.sleepURL;
  const wc = tab.view.webContents;
  return wc.isDestroyed() ? '' : wc.getURL();
}

function translateURL(u) {
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.replace(/-/g, '--').replace(/\./g, '-') + '.translate.goog';
    const sep = url.search ? '&' : '?';
    return 'https://' + host + url.pathname + url.search + sep + '_x_tr_sl=auto&_x_tr_tl=hi&_x_tr_hl=hi';
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Safe browsing: block known malware/phishing hosts (URLhaus feed, cached daily)
// ---------------------------------------------------------------------------
async function setupSafeBrowsing() {
  try {
    const fetch = require('cross-fetch');
    const cache = path.join(app.getPath('userData'), 'malware-domains.txt');
    let text = '';
    try {
      const st = fs.statSync(cache);
      if (Date.now() - st.mtimeMs < 24 * 3600 * 1000) text = fs.readFileSync(cache, 'utf8');
    } catch {}
    if (!text) {
      const res = await fetch('https://urlhaus.abuse.ch/downloads/hostfile/');
      text = await res.text();
      fs.writeFileSync(cache, text);
    }
    const set = new Set();
    for (const line of text.split('\n')) {
      const m = line.match(/^127\.0\.0\.1\s+(\S+)/);
      if (m) set.add(m[1].toLowerCase());
    }
    dangerDomains = set;
    console.log('Safe browsing list ready:', set.size, 'domains');
  } catch (err) {
    console.warn('Safe browsing list unavailable:', err.message);
  }
}

function maybeDangerous(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return dangerDomains.has(h) && !dangerAllowed.has(h) ? h : null;
  } catch {
    return null;
  }
}

// India-centric scam heuristics: look-alike bank/govt/KYC/lottery domains.
// Returns a { host, reason, real? } warning, or null.
const TRUSTED_BRANDS = [
  { key: 'sbi', real: 'onlinesbi.sbi', words: ['sbi', 'statebank'] },
  { key: 'hdfc', real: 'hdfcbank.com', words: ['hdfc'] },
  { key: 'icici', real: 'icicibank.com', words: ['icici'] },
  { key: 'axis', real: 'axisbank.com', words: ['axisbank'] },
  { key: 'pnb', real: 'pnbindia.in', words: ['pnb', 'punjabnational'] },
  { key: 'kotak', real: 'kotak.com', words: ['kotak'] },
  { key: 'paytm', real: 'paytm.com', words: ['paytm'] },
  { key: 'phonepe', real: 'phonepe.com', words: ['phonepe'] },
  { key: 'gpay', real: 'pay.google.com', words: ['googlepay', 'gpayindia'] },
  { key: 'aadhaar', real: 'uidai.gov.in', words: ['aadhaar', 'aadhar', 'uidai'] },
  { key: 'incometax', real: 'incometax.gov.in', words: ['incometax', 'itdepartment'] },
  { key: 'epfo', real: 'epfindia.gov.in', words: ['epfo', 'pfindia'] },
];
const SCAM_WORDS = ['kyc', 'lottery', 'lucky-draw', 'luckydraw', 'winner', 'prize', 'refund', 'reward', 'verify-account', 'account-blocked', 'update-pan'];

function scamCheck(url) {
  if (!settings.scamProtection) return null;
  let host, full;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    host = u.hostname.toLowerCase().replace(/^www\./, '');
    full = host + u.pathname.toLowerCase();
  } catch {
    return null;
  }
  if (dangerAllowed.has(host)) return null;

  // 1) look-alike of a trusted brand but NOT its real domain
  for (const b of TRUSTED_BRANDS) {
    if (b.words.some((w) => host.includes(w))) {
      const realHost = b.real;
      if (host === realHost || host.endsWith('.' + realHost)) return null; // genuine
      return {
        host,
        real: realHost,
        reason: 'यह ' + b.key.toUpperCase() + ' जैसी दिखती है पर इसकी असली साइट नहीं है।',
      };
    }
  }
  // 2) scam-word domains on suspicious TLDs / IP hosts
  const badTld = /\.(xyz|top|club|online|site|live|buzz|click|shop|fun|cyou|rest)$/.test(host);
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (SCAM_WORDS.some((w) => full.includes(w)) && (badTld || isIp)) {
    return { host, reason: 'इस पते में ठगी वाले शब्द और संदिग्ध पता है (KYC/लॉटरी/रिफ़ंड जैसी ठगी)।' };
  }
  return null;
}

async function confirmScam(info) {
  const detail =
    info.reason +
    (info.real ? '\n\nअसली और सुरक्षित साइट: ' + info.real : '') +
    '\n\nबैंक/सरकार कभी फ़ोन/लिंक पर OTP, PIN, या पासवर्ड नहीं माँगते। सोच-समझकर आगे बढ़ें।';
  const buttons = info.real
    ? ['🔙 वापस रहें', '✅ असली साइट (' + info.real + ') खोलें', 'फिर भी यही खोलें (जोखिम)']
    : ['🔙 वापस रहें (सुरक्षित)', 'फिर भी खोलें (जोखिम)'];
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons,
    defaultId: 0,
    cancelId: 0,
    message: '⚠️ सावधान — संभावित ठगी वाली साइट',
    detail,
  });
  if (info.real) {
    if (response === 1) return { action: 'real', url: 'https://' + info.real };
    if (response === 2) {
      dangerAllowed.add(info.host);
      return { action: 'proceed' };
    }
    return { action: 'back' };
  }
  if (response === 1) {
    dangerAllowed.add(info.host);
    return { action: 'proceed' };
  }
  return { action: 'back' };
}

async function confirmDanger(host) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'error',
    buttons: ['वापस रहें (सुरक्षित)', 'फिर भी खोलें (जोखिम)'],
    defaultId: 0,
    cancelId: 0,
    message: '⚠️ ख़तरनाक साइट: ' + host,
    detail:
      'यह साइट मैलवेयर/धोखाधड़ी की सूची (URLhaus) में दर्ज है। इसे खोलना आपके कंप्यूटर और डेटा के लिए ख़तरनाक हो सकता है।',
  });
  if (response === 1) {
    dangerAllowed.add(host);
    return true;
  }
  return false;
}

// Load a URL only after the screen-time, malware and scam checks pass.
function guardedLoad(wc, url) {
  if (isLimitBlocked(url)) {
    wc.loadURL(START_PAGE);
    return;
  }
  const host = maybeDangerous(url);
  if (host) {
    confirmDanger(host).then((ok) => {
      if (ok && !wc.isDestroyed()) wc.loadURL(url);
    });
    return;
  }
  const scam = scamCheck(url);
  if (scam) {
    confirmScam(scam).then((r) => {
      if (wc.isDestroyed()) return;
      if (r.action === 'proceed') wc.loadURL(url);
      else if (r.action === 'real') wc.loadURL(r.url);
    });
    return;
  }
  wc.loadURL(url);
}

// ---------------------------------------------------------------------------
// Ad / tracker blocking (per-site whitelist + user filters + stats)
// ---------------------------------------------------------------------------
function siteExceptionFilters(domain) {
  return ['@@*$domain=' + domain, '@@||' + domain + '^$elemhide,generichide'];
}

function filterLines(text) {
  return String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('!'));
}

function recordBlocked(request) {
  for (const tab of tabs.values()) {
    if (tab.view.webContents.id === request.tabId) {
      tab.blocked += 1;
      if (!tab.isPrivate) {
        const siteHost = hostOf(tabURL(tab));
        if (siteHost) {
          analytics.siteBlocked[siteHost] = (analytics.siteBlocked[siteHost] || 0) + 1;
        }
      }
      break;
    }
  }
  const trackerHost = (request.hostname || hostOf(request.url) || '').toLowerCase();
  if (trackerHost && Object.keys(analytics.trackers).length < 2000) {
    analytics.trackers[trackerHost] = (analytics.trackers[trackerHost] || 0) + 1;
  } else if (trackerHost && analytics.trackers[trackerHost] != null) {
    analytics.trackers[trackerHost] += 1;
  }
  store.saveDebounced('analytics', analytics, 5000);
  stats.total += 1;
  const day = new Date().toISOString().slice(0, 10);
  stats.days[day] = (stats.days[day] || 0) + 1;
  const keys = Object.keys(stats.days).sort();
  while (keys.length > 30) delete stats.days[keys.shift()];
  store.saveDebounced('stats', stats, 3000);
  sendStateThrottled();
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

    const added = [];
    for (const domain of whitelist) added.push(...siteExceptionFilters(domain));
    added.push(...filterLines(settings.customFilters));
    if (added.length) blocker.updateFromDiff({ added });

    if (settings.adblockEnabled) {
      blocker.enableBlockingInSession(session.defaultSession);
      if (privateSession) blocker.enableBlockingInSession(privateSession);
    }

    blocker.on('request-blocked', recordBlocked);

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
  const domain = hostOf(tabURL(tab));
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

function setCustomFilters(text) {
  const oldLines = filterLines(settings.customFilters);
  const newLines = filterLines(text);
  settings.customFilters = String(text || '');
  saveSettings();
  if (blocker) {
    try {
      blocker.updateFromDiff({ removed: oldLines, added: newLines });
    } catch (err) {
      console.warn('custom filters:', err.message);
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Sessions (default + private) — preloads and download handling
// ---------------------------------------------------------------------------
function wireSession(ses) {
  ses.setPreloads([...ses.getPreloads(), INTERNAL_PRELOAD]);
  ses.on('will-download', (_e, item) => {
    const id = nextDownloadId++;
    if (!settings.askDownloadPath) {
      const dir = settings.downloadDir || app.getPath('downloads');
      item.setSavePath(uniquePath(dir, item.getFilename()));
    }
    const entry = {
      id,
      filename: item.getFilename(),
      savePath: item.getSavePath(),
      url: item.getURL(),
      state: 'progressing',
      received: 0,
      total: item.getTotalBytes(),
      ts: Date.now(),
    };
    downloads.unshift(entry);
    downloadItems.set(id, item);

    item.on('updated', (_ev, state) => {
      entry.savePath = item.getSavePath();
      entry.filename = path.basename(entry.savePath || item.getFilename());
      entry.received = item.getReceivedBytes();
      entry.total = item.getTotalBytes();
      entry.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
      sendStateThrottled();
    });
    item.once('done', (_ev, state) => {
      entry.savePath = item.getSavePath();
      entry.received = item.getReceivedBytes();
      entry.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
      if (state === 'completed') {
        analytics.downloads.count += 1;
        analytics.downloads.bytes += entry.received;
        store.saveDebounced('analytics', analytics, 5000);
        addRecentFiles([entry.savePath]);
      }
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
    wireDataUsage(privateSession); // note: private data usage is dropped inside wireDataUsage
    if (blocker && settings.adblockEnabled) blocker.enableBlockingInSession(privateSession);
  }
  return privateSession;
}

// Double-account tabs: each identity keeps its own persistent cookies/logins,
// so two accounts of the same site can be open side by side.
function prepareIdentitySession(partition) {
  if (wiredPartitions.has(partition)) return;
  wiredPartitions.add(partition);
  const ses = session.fromPartition(partition); // persist: -> survives restarts
  wireSession(ses);
  wireDataUsage(ses);
  if (blocker && settings.adblockEnabled) blocker.enableBlockingInSession(ses);
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
    if (tab.keepAlive && !tab.asleep && !wc.isDestroyed() && !wc.isLoading()) {
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
// Memory saver: put long-inactive background tabs to sleep
// ---------------------------------------------------------------------------
setInterval(() => {
  if (!settings.tabSleep) return;
  const now = Date.now();
  for (const tab of tabs.values()) {
    if (
      tab.id === activeTabId ||
      tab.id === splitTabId ||
      tab.asleep ||
      tab.pinned ||
      tab.keepAlive ||
      tab.audible ||
      now - tab.lastActive < TAB_SLEEP_AFTER_MS
    ) {
      continue;
    }
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) continue;
    const url = wc.getURL();
    if (!/^https?:\/\//.test(url)) continue; // only sleep real web pages
    tab.sleepURL = url;
    tab.sleepTitle = wc.getTitle() || url;
    tab.asleep = true;
    wc.loadURL('about:blank');
  }
  sendStateThrottled();
}, 60 * 1000);

function wakeTab(tab) {
  if (!tab.asleep) return;
  tab.asleep = false;
  tab.lastActive = Date.now();
  tab.view.webContents.loadURL(tab.sleepURL);
}

// ---------------------------------------------------------------------------
// Browsing analytics (local only): active time per site, hourly pattern,
// data usage, tracker breakdown, screen-time limits
// ---------------------------------------------------------------------------
const ANALYTICS_KEEP_DAYS = 60;
const TIME_TICK_S = 15;
const limitWarned = new Set(); // "host|day" already warned

function localDayKey(d = new Date()) {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function pruneAnalytics() {
  for (const section of ['time', 'hours', 'data']) {
    const keys = Object.keys(analytics[section]).sort();
    while (keys.length > ANALYTICS_KEEP_DAYS) delete analytics[section][keys.shift()];
  }
}

function limitKeyFor(host) {
  for (const k of Object.keys(settings.timeLimits || {})) {
    if (host === k || host.endsWith('.' + k)) return k;
  }
  return null;
}

function usageTodayFor(limitKey) {
  const day = analytics.time[localDayKey()] || {};
  let sec = 0;
  for (const [host, s] of Object.entries(day)) {
    if (host === limitKey || host.endsWith('.' + limitKey)) sec += s;
  }
  return sec;
}

function blockForToday(host) {
  const today = localDayKey();
  if (analytics.limitBlocked.date !== today) {
    analytics.limitBlocked = { date: today, hosts: [] };
  }
  if (!analytics.limitBlocked.hosts.includes(host)) analytics.limitBlocked.hosts.push(host);
  store.save('analytics', analytics);
}

function isLimitBlocked(url) {
  if (analytics.limitBlocked.date !== localDayKey()) return false;
  const host = hostOf(url);
  return !!host && analytics.limitBlocked.hosts.some((b) => host === b || host.endsWith('.' + b));
}

function checkTimeLimit(tab, host) {
  const key = limitKeyFor(host);
  if (!key) return;
  const limitMin = settings.timeLimits[key];
  if (!limitMin || usageTodayFor(key) < limitMin * 60) return;
  const warnKey = key + '|' + localDayKey();
  if (limitWarned.has(warnKey)) return;
  limitWarned.add(warnKey);
  dialog
    .showMessageBox(win, {
      type: 'info',
      buttons: ['ठीक है', 'आज के लिए यह साइट ब्लॉक करें'],
      defaultId: 0,
      cancelId: 0,
      message: '⏰ ' + key + ' पर आज की लिमिट पूरी हुई',
      detail: 'आपने इस साइट के लिए रोज़ ' + limitMin + ' मिनट की लिमिट रखी है, जो आज पूरी हो गई है।',
    })
    .then(({ response }) => {
      if (response !== 1) return;
      blockForToday(key);
      for (const t of tabs.values()) {
        const h = hostOf(tabURL(t));
        if (h && (h === key || h.endsWith('.' + key))) t.view.webContents.loadURL(START_PAGE);
      }
    });
}

// Count active time: window focused, user not idle, real website in front.
setInterval(() => {
  try {
    if (!win || win.isDestroyed() || !win.isFocused()) return;
    if (powerMonitor.getSystemIdleTime() > 60) return;
    const tab = activeTab();
    if (!tab || tab.isPrivate || tab.asleep) return;
    const url = tabURL(tab);
    if (!/^https?:\/\//.test(url)) return;
    const host = hostOf(url);
    if (!host) return;
    const day = localDayKey();
    const hour = String(new Date().getHours());
    (analytics.time[day] = analytics.time[day] || {})[host] =
      (analytics.time[day][host] || 0) + TIME_TICK_S;
    (analytics.hours[day] = analytics.hours[day] || {})[hour] =
      (analytics.hours[day][hour] || 0) + TIME_TICK_S;
    pruneAnalytics();
    store.saveDebounced('analytics', analytics, 5000);
    checkTimeLimit(tab, host);
  } catch {}
}, TIME_TICK_S * 1000);

// Rough per-site data usage from Content-Length of completed responses.
function wireDataUsage(ses) {
  ses.webRequest.onCompleted((details) => {
    try {
      const h =
        details.responseHeaders &&
        (details.responseHeaders['Content-Length'] || details.responseHeaders['content-length']);
      const bytes = parseInt(Array.isArray(h) ? h[0] : h, 10) || 0;
      if (!bytes) return;
      let host = '';
      for (const t of tabs.values()) {
        if (t.view.webContents.id === details.webContentsId) {
          if (t.isPrivate) return; // private tabs are never recorded
          host = hostOf(tabURL(t));
          break;
        }
      }
      if (!host && details.initiator) host = hostOf(details.initiator);
      if (!host) return;
      const day = localDayKey();
      (analytics.data[day] = analytics.data[day] || {})[host] =
        (analytics.data[day][host] || 0) + bytes;
      store.saveDebounced('analytics', analytics, 5000);
    } catch {}
  });
}

const TRACKER_COMPANIES = [
  ['doubleclick', 'Google'],
  ['google-analytics', 'Google'],
  ['googletagmanager', 'Google'],
  ['googlesyndication', 'Google'],
  ['googleadservices', 'Google'],
  ['facebook', 'Meta'],
  ['fbcdn', 'Meta'],
  ['instagram', 'Meta'],
  ['amazon-adsystem', 'Amazon'],
  ['criteo', 'Criteo'],
  ['taboola', 'Taboola'],
  ['outbrain', 'Outbrain'],
  ['hotjar', 'Hotjar'],
  ['yandex', 'Yandex'],
  ['demdex', 'Adobe'],
  ['omtrdc', 'Adobe'],
  ['scorecardresearch', 'Comscore'],
  ['quantserve', 'Quantcast'],
  ['tiktok', 'TikTok'],
  ['ads-twitter', 'X (Twitter)'],
  ['linkedin', 'LinkedIn'],
  ['clarity.ms', 'Microsoft'],
  ['bing', 'Microsoft'],
  ['adnxs', 'Xandr'],
  ['pubmatic', 'PubMatic'],
  ['rubiconproject', 'Magnite'],
  ['openx', 'OpenX'],
];

function trackerCompany(host) {
  for (const [pat, name] of TRACKER_COMPANIES) {
    if (host.includes(pat)) return name;
  }
  return 'अन्य';
}

const SITE_CATEGORIES = {
  'सोशल मीडिया': ['facebook.', 'instagram.', 'twitter.', 'x.com', 'reddit.', 'linkedin.', 'snapchat.', 'threads.', 'web.whatsapp'],
  'वीडियो': ['youtube.', 'netflix.', 'hotstar.', 'primevideo.', 'twitch.', 'jiocinema.', 'sonyliv.'],
  'ख़बरें': ['news.google', 'ndtv.', 'aajtak.', 'bbc.', 'cnn.', 'indiatoday.', 'timesofindia.', 'bhaskar.', 'jagran.', 'amarujala.'],
  'शॉपिंग': ['amazon.', 'flipkart.', 'myntra.', 'meesho.', 'snapdeal.', 'ajio.'],
  'काम/पढ़ाई': ['github.', 'stackoverflow.', 'gitlab.', 'docs.google', 'mail.google', 'notion.', 'slack.', 'office.', 'teams.', 'wikipedia.'],
};

function siteCategory(host) {
  for (const [cat, pats] of Object.entries(SITE_CATEGORIES)) {
    if (pats.some((p) => host.includes(p))) return cat;
  }
  return 'बाकी';
}

function analyticsSummary() {
  const today = localDayKey();
  const dayKeys = [];
  for (let i = 0; i < 30; i++) {
    dayKeys.push(localDayKey(new Date(Date.now() - i * 24 * 3600 * 1000)));
  }
  const sum = (obj) => Object.values(obj || {}).reduce((a, b) => a + b, 0);

  const days30 = dayKeys.map((d) => ({ day: d, sec: sum(analytics.time[d]) })).reverse();
  const todaySec = sum(analytics.time[today]);
  let weekSec = 0;
  let lastWeekSec = 0;
  dayKeys.slice(0, 7).forEach((d) => (weekSec += sum(analytics.time[d])));
  dayKeys.slice(7, 14).forEach((d) => (lastWeekSec += sum(analytics.time[d])));

  const siteAgg = (keys) => {
    const m = {};
    for (const d of keys) {
      for (const [host, s] of Object.entries(analytics.time[d] || {})) m[host] = (m[host] || 0) + s;
    }
    return Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([host, sec]) => ({ host, sec }));
  };

  const categories = {};
  for (const d of dayKeys.slice(0, 7)) {
    for (const [host, s] of Object.entries(analytics.time[d] || {})) {
      const cat = siteCategory(host);
      categories[cat] = (categories[cat] || 0) + s;
    }
  }

  // weekday(0-6) x hour(0-23) heatmap over the last 28 days
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (let i = 0; i < 28; i++) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000);
    const key = localDayKey(d);
    const wd = d.getDay();
    for (const [hour, s] of Object.entries(analytics.hours[key] || {})) {
      heatmap[wd][Number(hour)] += s;
    }
  }

  const companies = {};
  for (const [host, n] of Object.entries(analytics.trackers)) {
    const c = trackerCompany(host);
    companies[c] = (companies[c] || 0) + n;
  }

  const dataAgg = (keys) => {
    const m = {};
    for (const d of keys) {
      for (const [host, b] of Object.entries(analytics.data[d] || {})) m[host] = (m[host] || 0) + b;
    }
    return m;
  };
  const dataToday = Object.entries(dataAgg([today]))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([host, bytes]) => ({ host, bytes }));
  const dataWeekTotal = sum(dataAgg(dayKeys.slice(0, 7)));

  const limits = Object.entries(settings.timeLimits || {}).map(([host, minutes]) => ({
    host,
    minutes,
    usedSec: usageTodayFor(host),
  }));

  return {
    todaySec,
    weekSec,
    lastWeekSec,
    days30,
    topToday: siteAgg([today]),
    topWeek: siteAgg(dayKeys.slice(0, 7)),
    categories,
    heatmap,
    trackers: Object.entries(analytics.trackers)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([host, count]) => ({ host, count, company: trackerCompany(host) })),
    companies: Object.entries(companies)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count })),
    dirtySites: Object.entries(analytics.siteBlocked)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([host, count]) => ({ host, count })),
    dataToday,
    dataWeekTotal,
    limits,
    blockedToday: analytics.limitBlocked.date === today ? analytics.limitBlocked.hosts : [],
    downloads: analytics.downloads,
  };
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
  const url = tabURL(tab);
  if (!/^https?:\/\//.test(url)) return;
  const idx = bookmarks.findIndex((b) => b.url === url);
  if (idx >= 0) bookmarks.splice(idx, 1);
  else {
    bookmarks.unshift({
      url,
      title: (tab.asleep ? tab.sleepTitle : tab.view.webContents.getTitle()) || url,
      ts: Date.now(),
    });
  }
  store.save('bookmarks', bookmarks);
  sendState();
}

function topSites() {
  const counts = new Map();
  for (const h of history) {
    try {
      const u = new URL(h.url);
      if (!/^https?:$/.test(u.protocol)) continue;
      const c = counts.get(u.origin) || { count: 0, host: u.hostname.replace(/^www\./, '') };
      c.count++;
      counts.set(u.origin, c);
    } catch {}
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8)
    .map(([origin, c]) => ({ url: origin, host: c.host }));
}

// ---------------------------------------------------------------------------
// Bookmark import / export
// ---------------------------------------------------------------------------
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function importBookmarks() {
  const home = app.getPath('home');
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const candidates = [
    path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks'),
    path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks'),
    path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Bookmarks'),
    path.join(home, '.config', 'google-chrome', 'Default', 'Bookmarks'),
    path.join(home, '.config', 'microsoft-edge', 'Default', 'Bookmarks'),
    path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Bookmarks'),
  ];
  let file = candidates.find((p) => fs.existsSync(p));
  if (!file) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Chrome/Edge की Bookmarks फ़ाइल या एक्सपोर्ट की गई .html फ़ाइल चुनें',
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return;
    file = r.filePaths[0];
  }
  let items = [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim().startsWith('{')) {
      // Chrome/Edge/Brave "Bookmarks" JSON
      const walk = (node) => {
        if (!node) return;
        if (node.type === 'url' && /^https?:/.test(node.url || '')) {
          items.push({ url: node.url, title: node.name || node.url });
        }
        (node.children || []).forEach(walk);
      };
      Object.values(JSON.parse(raw).roots || {}).forEach(walk);
    } else {
      // Netscape bookmark HTML export
      const re = /<A[^>]*HREF="(https?:[^"]+)"[^>]*>([^<]*)<\/A>/gi;
      let m;
      while ((m = re.exec(raw))) items.push({ url: decodeEntities(m[1]), title: decodeEntities(m[2]) || m[1] });
    }
  } catch (err) {
    dialog.showErrorBox('इम्पोर्ट नहीं हो पाया', String(err.message || err));
    return;
  }
  let added = 0;
  for (const it of items) {
    if (!bookmarks.some((b) => b.url === it.url)) {
      bookmarks.push({ url: it.url, title: it.title, ts: Date.now() });
      added++;
    }
  }
  store.save('bookmarks', bookmarks);
  sendState();
  dialog.showMessageBox(win, {
    message: added + ' नए बुकमार्क इम्पोर्ट हुए',
    detail: 'फ़ाइल: ' + file + '\nकुल बुकमार्क: ' + bookmarks.length,
  });
}

async function exportBookmarks() {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: 'tezbrowser-bookmarks.html',
    filters: [{ name: 'HTML', extensions: ['html'] }],
  });
  if (canceled || !filePath) return;
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const body = bookmarks.map((b) => `<DT><A HREF="${esc(b.url)}">${esc(b.title)}</A>`).join('\n');
  fs.writeFileSync(
    filePath,
    `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${body}\n</DL><p>\n`
  );
}

// ---------------------------------------------------------------------------
// Reader mode
// ---------------------------------------------------------------------------
const READER_EXTRACT_SNIPPET = `(() => {
  const pick = document.querySelector('article') || document.querySelector('main') || document.body;
  if (!pick) return null;
  const clone = pick.cloneNode(true);
  clone.querySelectorAll(
    'script,style,noscript,iframe,nav,header,footer,aside,form,button,svg,video,audio,ins,[role="navigation"],[role="banner"],[aria-hidden="true"]'
  ).forEach((n) => n.remove());
  return { title: document.title, url: location.href, html: clone.innerHTML.slice(0, 900000) };
})();`;

function sanitizeHTML(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');
}

async function openReader() {
  const tab = activeTab();
  if (!tab || tab.asleep) return;
  const wc = tab.view.webContents;
  if (!/^https?:\/\//.test(wc.getURL())) return;
  try {
    const res = await wc.executeJavaScript(READER_EXTRACT_SNIPPET, true);
    if (!res || !res.html) return;
    readerContent = { title: res.title || '', url: res.url || wc.getURL(), html: sanitizeHTML(res.html) };
    createTab(internalURL('reader'));
  } catch (err) {
    console.warn('reader extraction failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Picture-in-picture & read-aloud (TTS)
// ---------------------------------------------------------------------------
const PIP_SNIPPET = `(() => {
  try {
    if (document.pictureInPictureElement) { document.exitPictureInPicture(); return 'exit'; }
    const vids = [...document.querySelectorAll('video')].filter((v) => v.readyState > 0);
    if (!vids.length) return 'none';
    const v = vids.find((x) => !x.paused) || vids[0];
    v.requestPictureInPicture();
    return 'ok';
  } catch (e) { return 'err'; }
})();`;

const TTS_SNIPPET = `(() => {
  try {
    const synth = window.speechSynthesis;
    if (synth.speaking) { synth.cancel(); return 'stopped'; }
    const sel = window.getSelection().toString().trim();
    const el = document.querySelector('article') || document.querySelector('main') || document.body;
    const text = (sel || (el && el.innerText) || '').slice(0, 20000);
    if (!text.trim()) return 'empty';
    const u = new SpeechSynthesisUtterance(text);
    u.lang = document.documentElement.lang || 'hi-IN';
    synth.speak(u);
    return 'speaking';
  } catch (e) { return 'err'; }
})();`;

function runInActiveTab(snippet) {
  const tab = activeTab();
  if (!tab || tab.asleep) return;
  tab.view.webContents.executeJavaScript(snippet, true).catch(() => {});
}

function translateActivePage() {
  const tab = activeTab();
  if (!tab) return;
  const url = translateURL(tabURL(tab));
  if (url) createTab(url);
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

function pinnedCount() {
  let n = 0;
  for (const id of tabOrder) {
    const t = tabs.get(id);
    if (t && t.pinned) n++;
  }
  return n;
}

function createTab(url = START_PAGE, opts = {}) {
  const { activate = true, isPrivate = false, pinned = false, color = null, identity = null } = opts;
  if (isPrivate) getPrivateSession();
  let partition;
  if (isPrivate) partition = 'tez-private';
  else if (identity) {
    partition = 'persist:tez-id-' + identity;
    prepareIdentitySession(partition);
  }
  const id = nextTabId++;
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // background tabs keep running -> sessions stay alive
      images: !settings.dataSaver, // data saver: skip images in tabs opened while on
      partition,
      preload: adblockerPreload(), // cosmetic filtering (hides leftover ad frames)
    },
  });

  const tab = {
    id,
    view,
    blocked: 0,
    keepAlive: false,
    isPrivate,
    identity,
    pinned,
    color,
    muted: false,
    audible: false,
    asleep: false,
    sleepURL: '',
    sleepTitle: '',
    favicon: '',
    htmlFullscreen: false,
    dbg: false,
    fileChooser: null,
    lastActive: Date.now(),
  };
  tabs.set(id, tab);
  if (pinned) tabOrder.splice(pinnedCount(), 0, id);
  else tabOrder.push(id);
  win.contentView.addChildView(view);

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url: target }) => {
    if (maybeDangerous(target) || scamCheck(target)) {
      const t = createTab(START_PAGE, { isPrivate, identity });
      guardedLoad(t.view.webContents, target);
    } else {
      createTab(target, { isPrivate, identity }); // popups open as tabs, keep the identity
    }
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
    if (!isPrivate && !tab.asleep) recordHistory(navUrl, wc.getTitle());
    // per-site zoom memory
    const host = hostOf(navUrl);
    wc.setZoomLevel(host && zoomLevels[host] ? zoomLevels[host] : 0);
    saveSessionDebounced();
  });
  wc.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) tab.favicon = '';
  });
  wc.on('page-favicon-updated', (_e, favicons) => {
    tab.favicon = (favicons && favicons[0]) || '';
    sendStateThrottled();
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

  // Video/page fullscreen: let the page cover the whole window
  wc.on('enter-html-full-screen', () => {
    tab.htmlFullscreen = true;
    layout();
  });
  wc.on('leave-html-full-screen', () => {
    tab.htmlFullscreen = false;
    layout();
  });

  // Upload sidebar: intercept file pickers via the debugger, yielding to DevTools
  wc.on('dom-ready', () => ensureUploadIntercept(tab));
  wc.on('devtools-opened', () => {
    if (tab.dbg) {
      try {
        wc.debugger.detach();
      } catch {}
    }
  });
  wc.on('devtools-closed', () => setTimeout(() => ensureUploadIntercept(tab), 300));

  // Malware check + HTTPS-only upgrade for page-initiated navigation
  wc.on('will-navigate', (e, target) => {
    if (isLimitBlocked(target)) {
      e.preventDefault();
      return;
    }
    const dangerHost = maybeDangerous(target);
    if (dangerHost) {
      e.preventDefault();
      confirmDanger(dangerHost).then((ok) => {
        if (ok && !wc.isDestroyed()) wc.loadURL(target);
      });
      return;
    }
    const scam = scamCheck(target);
    if (scam) {
      e.preventDefault();
      confirmScam(scam).then((r) => {
        if (wc.isDestroyed()) return;
        if (r.action === 'proceed') wc.loadURL(target);
        else if (r.action === 'real') wc.loadURL(r.url);
      });
      return;
    }
    if (!settings.httpsOnly) return;
    if (!target.startsWith('http://')) return;
    const host = hostOf(target);
    if (!host || host === 'localhost' || httpAllowed.has(host)) return;
    e.preventDefault();
    tab.httpsUpgradedFrom = target;
    wc.loadURL('https://' + target.slice('http://'.length));
  });
  wc.on('did-fail-load', async (_e, errorCode, _desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 /* aborted */) return;
    const original = tab.httpsUpgradedFrom;
    tab.httpsUpgradedFrom = null;
    if (!original || !validatedURL.startsWith('https://')) return;
    const host = hostOf(original);
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['असुरक्षित (http) खोलें', 'रहने दें'],
      defaultId: 1,
      cancelId: 1,
      message: host + ' सुरक्षित (https) रूप में नहीं खुल रहा',
      detail: 'यह साइट बिना एन्क्रिप्शन के है। खोलने पर आपका डेटा रास्ते में पढ़ा जा सकता है।',
    });
    if (response === 0) {
      httpAllowed.add(host);
      wc.loadURL(original);
    }
  });

  guardedLoad(wc, url);
  if (activate) activateTab(id);
  else sendState();
  return tab;
}

function updateVisibility() {
  const split = splitTabId != null && splitTabId !== activeTabId && tabs.has(splitTabId);
  for (const t of tabs.values()) {
    t.view.setVisible(t.id === activeTabId || (split && t.id === splitTabId));
  }
}

function activateTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  const prev = activeTab();
  if (prev) prev.lastActive = Date.now();
  activeTabId = id;
  tab.lastActive = Date.now();
  if (tab.asleep) wakeTab(tab);
  updateVisibility();
  layout();
  sendState();
}

function setSplitTab(id) {
  if (splitTabId === id) splitTabId = null;
  else {
    const tab = tabs.get(id);
    if (!tab) return;
    if (tab.asleep) wakeTab(tab);
    splitTabId = id;
  }
  updateVisibility();
  layout();
  sendState();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  const url = tabURL(tab);
  if (!tab.isPrivate && /^https?:\/\//.test(url)) {
    closedTabs.push(url);
    if (closedTabs.length > 50) closedTabs.shift();
  }
  if (splitTabId === id) splitTabId = null;
  if (uploadTargetId === id) closeUploadSidebar();
  const orderIdx = tabOrder.indexOf(id);
  win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  tabs.delete(id);
  tabOrder = tabOrder.filter((x) => x !== id);
  updatePowerBlocker();

  if (tabs.size === 0) {
    createTab();
    return;
  }
  if (activeTabId === id) {
    const next = tabOrder[Math.min(orderIdx, tabOrder.length - 1)];
    activateTab(next);
  } else {
    updateVisibility();
    layout();
    sendState();
  }
}

function closeOtherTabs(id) {
  for (const otherId of [...tabOrder]) {
    const t = tabs.get(otherId);
    if (otherId !== id && t && !t.pinned) closeTab(otherId);
  }
  activateTab(id);
}

function reopenClosedTab() {
  const url = closedTabs.pop();
  if (url) createTab(url);
}

function activeTab() {
  return tabs.get(activeTabId) || null;
}

function cycleTab(dir) {
  if (tabOrder.length < 2) return;
  const idx = tabOrder.indexOf(activeTabId);
  const next = tabOrder[(idx + dir + tabOrder.length) % tabOrder.length];
  activateTab(next);
}

function togglePin(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.pinned = !tab.pinned;
  tabOrder = tabOrder.filter((x) => x !== id);
  tabOrder.splice(pinnedCount(), 0, id); // end of pinned zone either way
  saveSessionDebounced();
  sendState();
}

function reorderTab(id, targetId) {
  const tab = tabs.get(id);
  if (!tab) return;
  tabOrder = tabOrder.filter((x) => x !== id);
  let idx = targetId != null ? tabOrder.indexOf(targetId) : -1;
  if (idx < 0) idx = tabOrder.length;
  // keep pinned tabs in the pinned zone and normal tabs out of it
  const zone = pinnedCount();
  idx = tab.pinned ? Math.min(idx, zone) : Math.max(idx, zone);
  tabOrder.splice(idx, 0, id);
  sendState();
}

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  const tab = activeTab();
  if (!tab) return;
  if (tab.htmlFullscreen) {
    tab.view.setBounds({ x: 0, y: 0, width: w, height: h });
    return;
  }
  const availW = Math.max(0, w - sidebarWidth); // reserve the right strip for the sidebar
  const split = splitTabId != null && splitTabId !== activeTabId ? tabs.get(splitTabId) : null;
  const contentH = Math.max(0, h - chromeHeight);
  if (split) {
    const half = Math.floor(availW / 2);
    tab.view.setBounds({ x: 0, y: chromeHeight, width: half, height: contentH });
    split.view.setBounds({ x: half, y: chromeHeight, width: availW - half, height: contentH });
  } else {
    tab.view.setBounds({ x: 0, y: chromeHeight, width: availW, height: contentH });
  }
}

// ---------------------------------------------------------------------------
// Session restore
// ---------------------------------------------------------------------------
function saveSession() {
  const list = tabOrder
    .map((id) => tabs.get(id))
    .filter((t) => t && !t.isPrivate && !t.view.webContents.isDestroyed());
  if (list.length === 0) return;
  const entries = list
    .map((t) => ({ url: tabURL(t), pinned: !!t.pinned, color: t.color || null, identity: t.identity || null }))
    .filter(
      (e) => /^https?:\/\//.test(e.url) || e.url === START_PAGE || e.url.startsWith(PAGES_PREFIX)
    );
  const activeIdx = list.findIndex((t) => t.id === activeTabId);
  store.save('session', { entries, active: activeIdx });
}

function saveSessionDebounced() {
  clearTimeout(saveSessionDebounced._t);
  saveSessionDebounced._t = setTimeout(saveSession, 1000);
}

function restoreSession() {
  const saved = store.load('session', null);
  // accept both the current format {entries} and the older {urls}
  const entries =
    saved && Array.isArray(saved.entries)
      ? saved.entries
      : saved && Array.isArray(saved.urls)
        ? saved.urls.map((u) => ({ url: u, pinned: false }))
        : [];
  if (!entries.length) {
    createTab();
    return;
  }
  let activeTabRef = null;
  let maxId = 0;
  entries.forEach((entry, i) => {
    if (entry.identity) maxId = Math.max(maxId, Number(entry.identity) || 0);
    const tab = createTab(entry.url, {
      activate: false,
      pinned: !!entry.pinned,
      color: entry.color || null,
      identity: entry.identity || null,
    });
    if (i === saved.active) activeTabRef = tab;
  });
  if (maxId >= nextIdentity) nextIdentity = maxId + 1;
  activateTab((activeTabRef || tabs.get(tabOrder[0])).id);
}

// ---------------------------------------------------------------------------
// UI state sync
// ---------------------------------------------------------------------------
function sendState() {
  if (!win || win.isDestroyed()) return;
  const active = activeTab();
  const activeURL = active ? tabURL(active) : '';
  const state = {
    activeTabId,
    splitTabId,
    theme: settings.theme,
    simpleMode: settings.simpleMode,
    adblockEnabled: settings.adblockEnabled,
    activeWhitelisted: whitelist.has(hostOf(activeURL)),
    activeIsBookmarked: isBookmarked(activeURL),
    downloadsActive: downloads.filter((d) => d.state === 'progressing').length,
    tabs: tabOrder
      .map((id) => tabs.get(id))
      .filter(Boolean)
      .map((t) => {
        const wc = t.view.webContents;
        return {
          id: t.id,
          title: t.asleep ? t.sleepTitle : wc.getTitle() || 'नया टैब',
          url: displayURL(tabURL(t)),
          loading: !t.asleep && wc.isLoading(),
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
          blocked: t.blocked,
          keepAlive: t.keepAlive,
          isPrivate: t.isPrivate,
          identity: t.identity,
          pinned: t.pinned,
          color: t.color,
          audible: t.audible,
          muted: t.muted,
          asleep: t.asleep,
          favicon: t.favicon,
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
  if (!tab) return;
  if (tab.asleep) wakeTab(tab);
  else tab.view.webContents.reload();
}
function zoomActive(delta) {
  const tab = activeTab();
  if (!tab) return;
  const wc = tab.view.webContents;
  const level = delta === 0 ? 0 : wc.getZoomLevel() + delta;
  wc.setZoomLevel(level);
  const host = hostOf(tabURL(tab));
  if (host) {
    if (level) zoomLevels[host] = level;
    else delete zoomLevels[host];
    store.saveDebounced('zoom', zoomLevels);
  }
}

// ---------------------------------------------------------------------------
// Address bar suggestions
// ---------------------------------------------------------------------------
function suggestions(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  const seen = new Set();
  const push = (type, title, url) => {
    if (seen.has(url) || out.length >= 7) return;
    seen.add(url);
    out.push({ type, title: title || url, url });
  };
  for (const b of bookmarks) {
    if (out.length >= 3) break;
    if (b.url.toLowerCase().includes(q) || (b.title || '').toLowerCase().includes(q)) {
      push('bookmark', b.title, b.url);
    }
  }
  for (const h of history) {
    if (out.length >= 7) break;
    if (h.url.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q)) {
      push('history', h.title, h.url);
    }
  }
  return out;
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
  const owned = !tab.dbg; // reuse the upload-intercept debugger if it's attached
  try {
    if (owned) wc.debugger.attach('1.3');
    const { data } = await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    if (owned) wc.debugger.detach();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: (wc.getTitle() || 'screenshot').replace(/[\\/:*?"<>|]/g, '_') + '.png',
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (!canceled && filePath) fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
  } catch (err) {
    if (owned) {
      try {
        wc.debugger.detach();
      } catch {}
    }
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

async function chooseDownloadDir() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    defaultPath: settings.downloadDir || app.getPath('downloads'),
  });
  if (!canceled && filePaths[0]) {
    settings.downloadDir = filePaths[0];
    saveSettings();
  }
}

// ---------------------------------------------------------------------------
// Context menus
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
        click: () => createTab(engine().search + encodeURIComponent(text)),
      },
      { label: '🗣 चुना हुआ पढ़कर सुनाएँ', click: () => runInActiveTab(TTS_SNIPPET) },
      { type: 'separator' }
    );
  }
  if (params.isEditable) {
    items.push({ role: 'cut', label: 'कट' }, { role: 'paste', label: 'पेस्ट' }, { type: 'separator' });
  }
  items.push({ label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) });

  Menu.buildFromTemplate(items).popup({ window: win });
}

function showTabContextMenu(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  Menu.buildFromTemplate([
    { label: tab.pinned ? '📍 अनपिन करें' : '📍 पिन करें', click: () => togglePin(id) },
    {
      label: tab.muted ? '🔊 आवाज़ चालू करें' : '🔇 म्यूट करें',
      click: () => toggleMute(id),
    },
    {
      label: '🎨 टैब का रंग (ग्रुप)',
      submenu: [
        ...Object.entries(TAB_COLORS).map(([key, name]) => ({
          label: name,
          type: 'radio',
          checked: tab.color === key,
          click: () => {
            tab.color = key;
            saveSessionDebounced();
            sendState();
          },
        })),
        { type: 'separator' },
        {
          label: 'रंग हटाएँ',
          type: 'radio',
          checked: !tab.color,
          click: () => {
            tab.color = null;
            saveSessionDebounced();
            sendState();
          },
        },
      ],
    },
    {
      label: splitTabId === id ? '⿲ स्प्लिट से हटाएँ' : '⿲ स्प्लिट में दाईं तरफ़ दिखाएँ',
      enabled: splitTabId === id || id !== activeTabId,
      click: () => setSplitTab(id),
    },
    { label: '↻ रीलोड', click: () => tabs.has(id) && tabs.get(id).view.webContents.reload() },
    { label: '⧉ डुप्लिकेट', click: () => createTab(tabURL(tab), { isPrivate: tab.isPrivate, identity: tab.identity }) },
    { type: 'separator' },
    {
      label: '👥 इसी साइट को अलग पहचान से खोलें (दूसरा अकाउंट)',
      click: () => createTab(tabURL(tab), { identity: nextIdentity++ }),
    },
    { label: '➕ नई पहचान वाला खाली टैब', click: () => createTab(START_PAGE, { identity: nextIdentity++ }) },
    { type: 'separator' },
    { label: 'बाकी सब टैब बंद करें', click: () => closeOtherTabs(id) },
    { label: 'टैब बंद करें', click: () => closeTab(id) },
  ]).popup({ window: win });
}

function toggleMute(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.muted = !tab.muted;
  tab.view.webContents.setAudioMuted(tab.muted);
  sendState();
}

// ---------------------------------------------------------------------------
// Upload sidebar: intercept a page's file-picker and show our own folder view.
// Uses CDP: Page.setInterceptFileChooserDialog + DOM.setFileInputFiles.
// ---------------------------------------------------------------------------
function ensureUploadIntercept(tab) {
  const wc = tab.view.webContents;
  if (tab.dbg || wc.isDestroyed() || wc.isDevToolsOpened()) return;
  try {
    wc.debugger.attach('1.3');
  } catch {
    return;
  }
  tab.dbg = true;
  wc.debugger.on('detach', () => {
    tab.dbg = false;
  });
  wc.debugger.on('message', (_e, method, params) => {
    if (method === 'Page.fileChooserOpened') onFileChooser(tab, params);
  });
  Promise.allSettled([
    wc.debugger.sendCommand('Page.enable'),
    wc.debugger.sendCommand('DOM.enable'),
    wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }),
  ]);
}

async function onFileChooser(tab, params) {
  if (params.backendNodeId == null) {
    // Can't inject without a node handle — let the page try again natively.
    return;
  }
  // Read the input's `accept` attribute so the sidebar can filter file types.
  let accept = '';
  try {
    const wc = tab.view.webContents;
    const r = await wc.debugger.sendCommand('DOM.resolveNode', { backendNodeId: params.backendNodeId });
    if (r && r.object && r.object.objectId) {
      const res = await wc.debugger.sendCommand('Runtime.callFunctionOn', {
        objectId: r.object.objectId,
        functionDeclaration: 'function(){return this.accept||""}',
        returnByValue: true,
      });
      accept = (res && res.result && res.result.value) || '';
      wc.debugger.sendCommand('Runtime.releaseObject', { objectId: r.object.objectId }).catch(() => {});
    }
  } catch {}
  tab.fileChooser = {
    backendNodeId: params.backendNodeId,
    multiple: params.mode === 'selectMultiple',
    accept,
  };
  if (tab.id !== activeTabId) activateTab(tab.id);
  openUploadSidebar(tab);
}

function openUploadSidebar(tab) {
  uploadTargetId = tab.id;
  sidebarWidth = SIDEBAR_W;
  layout();
  if (win) {
    win.webContents.send('upload:open', {
      multiple: !!(tab.fileChooser && tab.fileChooser.multiple),
      accept: (tab.fileChooser && tab.fileChooser.accept) || '',
    });
  }
}

function closeUploadSidebar() {
  sidebarWidth = 0;
  uploadTargetId = null;
  layout();
  if (win) win.webContents.send('upload:close');
}

function chooseUploadFiles(paths) {
  const tab = tabs.get(uploadTargetId);
  if (!tab || !tab.fileChooser) {
    closeUploadSidebar();
    return;
  }
  const files = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [];
  const send = tab.fileChooser.multiple ? files : files.slice(0, 1);
  tab.view.webContents.debugger
    .sendCommand('DOM.setFileInputFiles', { files: send, backendNodeId: tab.fileChooser.backendNodeId })
    .catch((err) => console.warn('setFileInputFiles:', err.message));
  addRecentFiles(send);
  tab.fileChooser = null;
  closeUploadSidebar();
}

function addRecentFiles(paths) {
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const i = recentFiles.findIndex((r) => r.path === p);
    if (i >= 0) recentFiles.splice(i, 1);
    recentFiles.unshift({ path: p, name: path.basename(p), ts: Date.now() });
  }
  while (recentFiles.length > 40) recentFiles.pop();
  store.save('recentfiles', recentFiles);
}

function cancelUpload() {
  const tab = tabs.get(uploadTargetId);
  if (tab && tab.fileChooser) {
    tab.view.webContents.debugger
      .sendCommand('DOM.setFileInputFiles', { files: [], backendNodeId: tab.fileChooser.backendNodeId })
      .catch(() => {});
    tab.fileChooser = null;
  }
  closeUploadSidebar();
}

function quickAccess() {
  const names = { home: '🏠 होम', desktop: '🖥 डेस्कटॉप', documents: '📄 दस्तावेज़', downloads: '⬇ डाउनलोड', pictures: '🖼 तस्वीरें' };
  const out = [];
  for (const key of Object.keys(names)) {
    try {
      const p = app.getPath(key);
      if (p && fs.existsSync(p)) out.push({ name: names[key], path: p });
    } catch {}
  }
  return out;
}

function listDir(dir) {
  let target = dir && fs.existsSync(dir) ? dir : lastBrowseDir && fs.existsSync(lastBrowseDir) ? lastBrowseDir : app.getPath('home');
  let entries = [];
  let error = null;
  try {
    entries = fs
      .readdirSync(target, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.'))
      .map((d) => {
        const full = path.join(target, d.name);
        let isDir = d.isDirectory();
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          size = st.size;
          mtime = st.mtimeMs;
        } catch {}
        const ext = (path.extname(d.name).slice(1) || '').toLowerCase();
        const e = { name: d.name, isDir, size, mtime, path: full };
        if (!isDir && PV_IMG.has(ext)) e.url = pathToFileURL(full).href; // grid thumbnail
        return e;
      })
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, 'hi')));
  } catch (err) {
    error = err.message;
  }
  lastBrowseDir = target;
  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent !== target ? parent : null,
    entries,
    error,
    favorites: favFolders.map((p) => ({ path: p, name: path.basename(p) || p })),
    quick: quickAccess(),
  };
}

const PV_IMG = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);
const PV_VID = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'ogv']);
const PV_AUD = new Set(['mp3', 'wav', 'm4a', 'ogg', 'oga', 'flac', 'aac']);
const PV_TEXT = new Set([
  'txt', 'md', 'csv', 'log', 'json', 'xml', 'js', 'ts', 'css', 'html', 'htm',
  'py', 'java', 'c', 'cpp', 'h', 'sh', 'yml', 'yaml', 'ini', 'conf', 'rtf',
]);

// Return a preview descriptor for a file the user clicked in the upload sidebar.
ipcMain.handle('fs:preview', (_e, p) => {
  try {
    if (typeof p !== 'string') return { kind: 'none' };
    const st = fs.statSync(p);
    if (!st.isFile()) return { kind: 'none' };
    const ext = (path.extname(p).slice(1) || '').toLowerCase();
    const base = { name: path.basename(p), size: st.size, ext };
    if (PV_IMG.has(ext)) return { ...base, kind: 'image', url: pathToFileURL(p).href };
    if (PV_VID.has(ext)) return { ...base, kind: 'video', url: pathToFileURL(p).href };
    if (PV_AUD.has(ext)) return { ...base, kind: 'audio', url: pathToFileURL(p).href };
    if (ext === 'pdf') return { ...base, kind: 'pdf', url: pathToFileURL(p).href };
    if (PV_TEXT.has(ext) || (st.size > 0 && st.size < 200000)) {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(Math.min(st.size, 65536));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const slice = buf.subarray(0, n);
      if (!slice.includes(0)) return { ...base, kind: 'text', text: slice.toString('utf8') };
    }
    return { ...base, kind: 'info' };
  } catch {
    return { kind: 'none' };
  }
});

ipcMain.handle('fs:list', (_e, dir) => listDir(dir));
ipcMain.handle('fs:recent', () => {
  const out = [];
  for (const r of recentFiles) {
    try {
      const st = fs.statSync(r.path);
      if (!st.isFile()) continue;
      const ext = (path.extname(r.path).slice(1) || '').toLowerCase();
      const e = { name: r.name, isDir: false, size: st.size, mtime: st.mtimeMs, path: r.path };
      if (PV_IMG.has(ext)) e.url = pathToFileURL(r.path).href;
      out.push(e);
    } catch {}
  }
  return out.slice(0, 40);
});
ipcMain.handle('fs:favorite', (_e, { action, path: p }) => {
  const i = favFolders.indexOf(p);
  if (action === 'add' && i < 0 && p) favFolders.push(p);
  else if (action === 'remove' && i >= 0) favFolders.splice(i, 1);
  store.save('favfolders', favFolders);
  return favFolders.map((x) => ({ path: x, name: path.basename(x) || x }));
});
ipcMain.on('upload:choose', (_e, paths) => chooseUploadFiles(paths));
ipcMain.on('upload:cancel', cancelUpload);

// ---------------------------------------------------------------------------
// IPC: toolbar
// ---------------------------------------------------------------------------
ipcMain.on('tab:new', () => createTab());
ipcMain.on('tab:new-private', () => createTab(START_PAGE, { isPrivate: true }));
ipcMain.on('tab:close', (_e, id) => closeTab(id));
ipcMain.on('tab:activate', (_e, id) => activateTab(id));
ipcMain.on('tab:mute', (_e, id) => toggleMute(id));
ipcMain.on('tab:context', (_e, id) => showTabContextMenu(id));
ipcMain.on('tab:reorder', (_e, { id, targetId }) => reorderTab(id, targetId));
// Hindi (and English) natural-language commands typed or spoken into the bar.
// Returns true if handled as a command, false if it should be treated as a URL/search.
const SITE_WORDS = {
  'यूट्यूब': 'https://www.youtube.com',
  'youtube': 'https://www.youtube.com',
  'यूट्युब': 'https://www.youtube.com',
  'गूगल': 'https://www.google.com',
  'google': 'https://www.google.com',
  'फेसबुक': 'https://www.facebook.com',
  'facebook': 'https://www.facebook.com',
  'व्हाट्सएप': 'https://web.whatsapp.com',
  'whatsapp': 'https://web.whatsapp.com',
  'व्हाट्सऐप': 'https://web.whatsapp.com',
  'जीमेल': 'https://mail.google.com',
  'gmail': 'https://mail.google.com',
  'इंस्टाग्राम': 'https://www.instagram.com',
  'instagram': 'https://www.instagram.com',
  'विकिपीडिया': 'https://www.wikipedia.org',
  'wikipedia': 'https://www.wikipedia.org',
  'अमेज़न': 'https://www.amazon.in',
  'amazon': 'https://www.amazon.in',
  'फ्लिपकार्ट': 'https://www.flipkart.com',
  'flipkart': 'https://www.flipkart.com',
};

function handleCommand(raw) {
  const text = raw.trim();
  const t = text.toLowerCase();
  const has = (...w) => w.some((x) => t.includes(x));

  // actions on the current page / browser
  if (has('पढ़कर सुनाओ', 'पढ़कर सुना', 'सुनाओ', 'read aloud')) return runInActiveTab(TTS_SNIPPET), true;
  if (has('अनुवाद', 'हिंदी में करो', 'translate')) return translateActivePage(), true;
  if (has('रीडर', 'reader')) return openReader(), true;
  if (has('पीडीएफ', 'pdf बना', 'pdf banao')) return savePageAsPDF(), true;
  if (has('स्क्रीनशॉट', 'screenshot')) return fullPageScreenshot(), true;
  if (has('सारे टैब बंद', 'सब टैब बंद', 'close all tab')) {
    for (const tid of [...tabOrder]) {
      const tt = tabs.get(tid);
      if (tt && !tt.pinned && tid !== activeTabId) closeTab(tid);
    }
    return true;
  }
  if (has('यह टैब बंद', 'टैब बंद करो', 'close tab')) return closeTab(activeTabId), true;
  if (has('नया टैब', 'new tab')) return createTab(), true;
  if (has('प्राइवेट', 'private', 'incognito', 'गुप्त')) return createTab(START_PAGE, { isPrivate: true }), true;
  if (has('बुकमार्क', 'bookmark')) return toggleBookmark(), true;
  if (has('इतिहास', 'हिस्ट्री', 'history')) return createTab(internalURL('history')), true;
  if (has('डाउनलोड', 'download')) return createTab(internalURL('downloads')), true;
  if (has('रिफ्रेश', 'रीलोड', 'reload', 'refresh')) return navReload(), true;
  if (has('पीछे', 'back', 'वापस जाओ')) return navBack(), true;
  if (has('आगे', 'forward')) return navForward(), true;

  // "X खोलो / X दिखाओ / open X"
  const openMatch = t.match(/^(?:(.+?)\s*(?:खोलो|खोल दो|दिखाओ|चलाओ|open)|open\s+(.+))$/);
  if (openMatch) {
    const namePart = (openMatch[1] || openMatch[2] || '').trim();
    for (const [word, url] of Object.entries(SITE_WORDS)) {
      if (namePart.includes(word)) {
        const tab = activeTab();
        if (tab) {
          tab.asleep = false;
          guardedLoad(tab.view.webContents, url);
        }
        return true;
      }
    }
    // "<कुछ> खोलो" जहाँ <कुछ> कोई साइट/डोमेन है
    const asUrl = toURL(namePart);
    if (namePart && !namePart.includes(' ')) {
      const tab = activeTab();
      if (tab && asUrl) {
        tab.asleep = false;
        guardedLoad(tab.view.webContents, asUrl);
      }
      return true;
    }
    // वरना उसे सर्च कर दो
    const tab = activeTab();
    if (tab) {
      tab.asleep = false;
      guardedLoad(tab.view.webContents, engine().search + encodeURIComponent(namePart));
    }
    return true;
  }

  // bare site word ("यूट्यूब")
  for (const [word, url] of Object.entries(SITE_WORDS)) {
    if (t === word) {
      const tab = activeTab();
      if (tab) {
        tab.asleep = false;
        guardedLoad(tab.view.webContents, url);
      }
      return true;
    }
  }
  return false;
}

ipcMain.on('nav:go', (_e, input) => {
  const tab = activeTab();
  if (!tab) return;
  // Multi-word input that isn't an obvious URL -> try a command first.
  const looksLikeUrl = /^[a-z]+:\/\//i.test(input.trim()) || (!input.includes(' ') && input.includes('.'));
  if (!looksLikeUrl && handleCommand(input)) return;
  const url = toURL(input);
  if (url) {
    tab.asleep = false;
    guardedLoad(tab.view.webContents, url);
  }
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
  if (tab.keepAlive && tab.asleep) wakeTab(tab);
  updatePowerBlocker();
  sendState();
});
ipcMain.on('bookmark:toggle', toggleBookmark);
ipcMain.on('shield:toggle', toggleSiteWhitelist);
ipcMain.on('reader:open', openReader);
ipcMain.on('pip:toggle', () => runInActiveTab(PIP_SNIPPET));
ipcMain.on('internal:open', (_e, name) => {
  if (INTERNAL_PAGES[name]) createTab(internalURL(name));
});
ipcMain.on('ui:chrome-height', (_e, h) => {
  chromeHeight = Math.max(DEFAULT_CHROME_HEIGHT, Math.min(400, Number(h) || DEFAULT_CHROME_HEIGHT));
  layout();
});
ipcMain.on('ui:menu', (_e, pos) => {
  Menu.buildFromTemplate(menuTemplate()).popup({
    window: win,
    x: Math.round(pos.x),
    y: Math.round(pos.y),
  });
});
ipcMain.handle('suggest', (_e, q) => suggestions(q));
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
// IPC: internal pages (bookmarks / history / downloads / reader / start / stats)
// Only frames actually loaded from src/ui/pages/ may use these.
// ---------------------------------------------------------------------------
function isInternalSender(event) {
  const frame = event.senderFrame;
  return !!frame && frame.url.startsWith(PAGES_PREFIX);
}

function statsSummary() {
  const today = new Date().toISOString().slice(0, 10);
  let week = 0;
  const now = Date.now();
  for (const [day, n] of Object.entries(stats.days)) {
    if (now - new Date(day + 'T00:00:00Z').getTime() < 7 * 24 * 3600 * 1000) week += n;
  }
  const savedMB = Math.round((stats.total * 50) / 1024);
  return {
    total: stats.total,
    today: stats.days[today] || 0,
    week,
    days: stats.days,
    // rough estimate: an average blocked request weighs ~50 KB
    savedMB,
    // money saved: data cost + a small time value (~0.4s per blocked ad)
    savedRupees: Math.round((savedMB / 1024) * (settings.dataPackRate || 15)),
    savedMinutes: Math.round((stats.total * 0.4) / 60),
    dataPackRate: settings.dataPackRate || 15,
    customFilters: settings.customFilters,
  };
}

// ---------------------------------------------------------------------------
// Time-machine: snapshot open tabs hourly, restore a past session by time
// ---------------------------------------------------------------------------
function snapshotTabs() {
  const urls = tabOrder
    .map((id) => tabs.get(id))
    .filter((t) => t && !t.isPrivate)
    .map((t) => tabURL(t))
    .filter((u) => /^https?:\/\//.test(u));
  if (!urls.length) return;
  const last = timeMachine[timeMachine.length - 1];
  // skip if identical to the previous snapshot
  if (last && last.urls.join('\n') === urls.join('\n')) return;
  timeMachine.push({ ts: Date.now(), urls });
  // keep ~14 days of hourly snapshots
  while (timeMachine.length > 24 * 14) timeMachine.shift();
  store.save('timemachine', timeMachine);
}

function restoreSnapshot(ts) {
  const snap = timeMachine.find((s) => s.ts === ts);
  if (!snap) return;
  for (const url of snap.urls) createTab(url, { activate: false });
  sendState();
}

setInterval(snapshotTabs, 60 * 60 * 1000); // hourly

ipcMain.handle('tez:list', (event, kind) => {
  if (!isInternalSender(event)) return null;
  if (kind === 'bookmarks') return bookmarks;
  if (kind === 'history') return history.slice(0, 1000);
  if (kind === 'downloads') return downloads;
  if (kind === 'topsites') return topSites();
  if (kind === 'search') return { action: engine().action, name: engine().name };
  if (kind === 'reader') return readerContent;
  if (kind === 'stats') return statsSummary();
  if (kind === 'analytics') return analyticsSummary();
  if (kind === 'timemachine') {
    return timeMachine
      .slice()
      .reverse()
      .map((s) => ({ ts: s.ts, count: s.urls.length, urls: s.urls.slice(0, 12) }));
  }
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
  if (kind === 'stats') {
    if (action === 'setFilters') return setCustomFilters(payload);
  }
  if (kind === 'timemachine') {
    if (action === 'restore') {
      restoreSnapshot(payload);
      return true;
    }
    if (action === 'openOne' && /^https?:\/\//.test(payload)) {
      createTab(payload);
      return true;
    }
  }
  if (kind === 'analytics') {
    if (action === 'setLimit' && payload && payload.host) {
      const h = String(payload.host).trim().toLowerCase().replace(/^www\./, '').replace(/^https?:\/\//, '').split('/')[0];
      const m = Math.max(1, parseInt(payload.minutes, 10) || 0);
      if (!h) return false;
      settings.timeLimits[h] = m;
      saveSettings();
      return true;
    }
    if (action === 'removeLimit') {
      delete settings.timeLimits[payload];
      saveSettings();
      return true;
    }
    if (action === 'unblock') {
      analytics.limitBlocked.hosts = analytics.limitBlocked.hosts.filter((h) => h !== payload);
      store.save('analytics', analytics);
      return true;
    }
    if (action === 'clearAll') {
      analytics.time = {};
      analytics.hours = {};
      analytics.data = {};
      analytics.trackers = {};
      analytics.siteBlocked = {};
      analytics.downloads = { count: 0, bytes: 0 };
      store.save('analytics', analytics);
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
          label: 'प्रोफ़ाइल',
          submenu: [
            {
              label: 'मुख्य प्रोफ़ाइल',
              type: 'radio',
              checked: !PROFILE,
              click: () => PROFILE && switchProfile(''),
            },
            ...profileRegistry().map((p) => ({
              label: p.name,
              type: 'radio',
              checked: PROFILE === p.id,
              click: () => PROFILE !== p.id && switchProfile(p.id),
            })),
            { type: 'separator' },
            { label: '+ नई प्रोफ़ाइल बनाएँ (रीस्टार्ट होगा)', click: createNewProfile },
          ],
        },
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
        { label: '📖 रीडर मोड', click: openReader },
        { label: '🎦 पिक्चर-इन-पिक्चर (वीडियो)', click: () => runInActiveTab(PIP_SNIPPET) },
        { label: '🗣 पेज पढ़कर सुनाएँ / रोकें', click: () => runInActiveTab(TTS_SNIPPET) },
        { label: '🌍 इस पेज का हिंदी अनुवाद', click: translateActivePage },
        {
          label: '⿲ स्प्लिट व्यू बंद करें',
          enabled: splitTabId != null,
          click: () => setSplitTab(splitTabId),
        },
        { type: 'separator' },
        { label: 'अगला टैब', accelerator: 'Control+Tab', click: () => cycleTab(1) },
        { label: 'पिछला टैब', accelerator: 'Control+Shift+Tab', click: () => cycleTab(-1) },
        { type: 'separator' },
        { label: 'ज़ूम बढ़ाएँ', accelerator: 'CmdOrCtrl+=', click: () => zoomActive(0.5) },
        { label: 'ज़ूम घटाएँ', accelerator: 'CmdOrCtrl+-', click: () => zoomActive(-0.5) },
        { label: 'ज़ूम रीसेट', accelerator: 'CmdOrCtrl+0', click: () => zoomActive(0) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'फ़ुल-स्क्रीन' },
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
        { label: '📊 ऐड-ब्लॉक आँकड़े', click: () => createTab(internalURL('stats')) },
        { label: '📈 मेरी ब्राउज़िंग analytics', click: () => createTab(internalURL('analytics')) },
        { label: '⏮ टाइम-मशीन (पुराने टैब वापस)', click: () => createTab(internalURL('timemachine')) },
        { type: 'separator' },
        { label: '📥 Chrome/Edge से बुकमार्क इम्पोर्ट…', click: importBookmarks },
        { label: '📤 बुकमार्क एक्सपोर्ट (HTML)…', click: exportBookmarks },
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
          label: 'HTTPS-only (असुरक्षित साइटों पर चेतावनी)',
          type: 'checkbox',
          checked: settings.httpsOnly,
          click: (item) => {
            settings.httpsOnly = item.checked;
            saveSettings();
          },
        },
        {
          label: '🛡 भारत-केंद्रित ठगी सुरक्षा (नक़ली बैंक/KYC/लॉटरी)',
          type: 'checkbox',
          checked: settings.scamProtection,
          click: (item) => {
            settings.scamProtection = item.checked;
            saveSettings();
          },
        },
        {
          label: '👵 सरल मोड (बड़े बटन/अक्षर, ज़्यादा सुरक्षा)',
          type: 'checkbox',
          checked: settings.simpleMode,
          click: (item) => {
            settings.simpleMode = item.checked;
            saveSettings();
            sendState();
          },
        },
        {
          label: 'मेमोरी सेवर (पुराने टैब सुला दें)',
          type: 'checkbox',
          checked: settings.tabSleep,
          click: (item) => {
            settings.tabSleep = item.checked;
            saveSettings();
          },
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
        {
          label: '🎨 थीम',
          submenu: THEMES.map((t) => ({
            label: THEME_NAMES[t],
            type: 'radio',
            checked: settings.theme === t,
            click: () => {
              settings.theme = t;
              saveSettings();
              sendState();
            },
          })),
        },
        {
          label: 'सर्च इंजन',
          submenu: Object.entries(SEARCH_ENGINES).map(([key, e]) => ({
            label: e.name,
            type: 'radio',
            checked: settings.searchEngine === key,
            click: () => {
              settings.searchEngine = key;
              saveSettings();
            },
          })),
        },
        {
          label: 'डाउनलोड',
          submenu: [
            {
              label: 'हर बार पूछें कहाँ सेव करना है',
              type: 'checkbox',
              checked: settings.askDownloadPath,
              click: (item) => {
                settings.askDownloadPath = item.checked;
                saveSettings();
              },
            },
            { label: 'डाउनलोड फ़ोल्डर बदलें…', click: chooseDownloadDir },
          ],
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
    title: 'TezBrowser' + (PROFILE ? ' — ' + PROFILE : ''),
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
  wireDataUsage(session.defaultSession); // private session stays unrecorded
  setupSafeBrowsing(); // runs in the background; browsing works meanwhile
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
