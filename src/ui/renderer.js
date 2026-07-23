const tabstrip = document.getElementById('tabstrip');
const address = document.getElementById('address');
const suggestBox = document.getElementById('suggest');
const backBtn = document.getElementById('back');
const forwardBtn = document.getElementById('forward');
const reloadBtn = document.getElementById('reload');
const blockedEl = document.getElementById('blocked');
const keepAliveBtn = document.getElementById('keepalive');
const starBtn = document.getElementById('star');
const readerBtn = document.getElementById('reader');
const shieldBtn = document.getElementById('shield');
const downloadsBtn = document.getElementById('downloads');
const menuBtn = document.getElementById('menu');
const findbar = document.getElementById('findbar');
const findText = document.getElementById('findtext');
const findCount = document.getElementById('findcount');

const BASE_CHROME = 84;
const FIND_EXTRA = 34;
const SUG_ITEM = 30;

let currentState = { tabs: [], activeTabId: null };
let dragTabId = null;
let sugItems = [];
let sugSelected = -1;

function updateChromeHeight() {
  const findExtra = findbar.classList.contains('open') ? FIND_EXTRA : 0;
  const sugExtra = suggestBox.classList.contains('open') ? sugItems.length * SUG_ITEM + 10 : 0;
  window.browser.setChromeHeight(BASE_CHROME + findExtra + Math.max(0, sugExtra - 0));
}

// ---------------------------------------------------------------------------
// Tab strip
// ---------------------------------------------------------------------------
function render(state) {
  currentState = state;
  document.documentElement.dataset.theme = state.theme || 'dark';
  document.body.classList.toggle('simple', !!state.simpleMode);
  tabstrip.innerHTML = '';

  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className =
      'tab' +
      (tab.id === state.activeTabId ? ' active' : '') +
      (tab.isPrivate ? ' private' : '') +
      (tab.identity ? ' identity' : '') +
      (tab.pinned ? ' pinned' : '') +
      (tab.asleep ? ' asleep' : '') +
      (tab.id === state.splitTabId ? ' split' : '') +
      (tab.color ? ' c-' + tab.color : '');
    el.title = tab.title;
    el.draggable = true;
    el.addEventListener('click', () => window.browser.activateTab(tab.id));
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) window.browser.closeTab(tab.id); // middle click
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.browser.tabContextMenu(tab.id);
    });
    el.addEventListener('dragstart', () => {
      dragTabId = tab.id;
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('dragover');
    });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('dragover');
      if (dragTabId != null && dragTabId !== tab.id) {
        window.browser.reorderTab(dragTabId, tab.id);
      }
      dragTabId = null;
    });

    if (tab.loading) {
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      el.appendChild(spinner);
    } else if (tab.favicon) {
      const fav = document.createElement('img');
      fav.className = 'fav';
      fav.src = tab.favicon;
      fav.addEventListener('error', () => fav.remove());
      el.appendChild(fav);
    } else if (tab.pinned) {
      const dot = document.createElement('span');
      dot.textContent = tab.isPrivate ? '🕶' : tab.asleep ? '💤' : '📍';
      dot.style.fontSize = '13px';
      el.appendChild(dot);
    }

    if (!tab.pinned && tab.identity) {
      const badge = document.createElement('span');
      badge.className = 'idbadge';
      badge.textContent = '👥' + tab.identity;
      badge.title = 'अलग पहचान — इसका लॉगिन बाकी टैबों से अलग है';
      el.appendChild(badge);
    }

    if (!tab.pinned) {
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent =
        (tab.isPrivate ? '🕶 ' : '') + (tab.asleep ? '💤 ' : '') + tab.title;
      el.appendChild(title);
    }

    if (tab.audible || tab.muted) {
      const sound = document.createElement('span');
      sound.className = 'sound';
      sound.textContent = tab.muted ? '🔇' : '🔊';
      sound.title = tab.muted ? 'आवाज़ चालू करें' : 'टैब म्यूट करें';
      sound.addEventListener('click', (e) => {
        e.stopPropagation();
        window.browser.muteTab(tab.id);
      });
      el.appendChild(sound);
    }

    if (!tab.pinned) {
      const close = document.createElement('span');
      close.className = 'close';
      close.textContent = '×';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        window.browser.closeTab(tab.id);
      });
      el.appendChild(close);
    }

    tabstrip.appendChild(el);
  }

  const plus = document.createElement('button');
  plus.id = 'newtab';
  plus.textContent = '+';
  plus.title = 'नया टैब (Ctrl+T)';
  plus.addEventListener('click', () => window.browser.newTab());
  tabstrip.appendChild(plus);

  const active = state.tabs.find((t) => t.id === state.activeTabId);
  if (active) {
    if (document.activeElement !== address) address.value = active.url;
    backBtn.disabled = !active.canGoBack;
    forwardBtn.disabled = !active.canGoForward;
    reloadBtn.textContent = active.loading ? '×' : '↻';
    reloadBtn.title = active.loading ? 'रोकें' : 'रीलोड';
    blockedEl.textContent = active.blocked;
    keepAliveBtn.classList.toggle('active', !!active.keepAlive);
    keepAliveBtn.title = active.keepAlive
      ? 'लॉग-इन बनाए रखना चालू है (बंद करने के लिए क्लिक करें)'
      : 'ऑटो-लॉगआउट रोकें: इस साइट को लॉग-इन बनाए रखें';
    starBtn.classList.toggle('active', !!state.activeIsBookmarked);
    starBtn.textContent = state.activeIsBookmarked ? '★' : '☆';
    const shieldOff = !state.adblockEnabled || state.activeWhitelisted;
    shieldBtn.classList.toggle('off', shieldOff);
    shieldBtn.title = !state.adblockEnabled
      ? 'ऐड-ब्लॉकर बंद है (मेन्यू से चालू करें)'
      : state.activeWhitelisted
        ? 'इस साइट पर ऐड-ब्लॉकर बंद है — चालू करने के लिए क्लिक करें'
        : 'ऐड-ब्लॉकर चालू — इस साइट पर बंद करने के लिए क्लिक करें';
    document.title = active.title + ' — TezBrowser';
  }
  downloadsBtn.classList.toggle('busy', (state.downloadsActive || 0) > 0);
}

window.browser.onState(render);

window.browser.onFocusAddress(() => {
  address.focus();
  address.select();
});

// ---------------------------------------------------------------------------
// Address bar + suggestions
// ---------------------------------------------------------------------------
function closeSuggest() {
  suggestBox.classList.remove('open');
  suggestBox.innerHTML = '';
  sugItems = [];
  sugSelected = -1;
  updateChromeHeight();
}

function renderSuggest() {
  suggestBox.innerHTML = '';
  sugItems.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'sug' + (i === sugSelected ? ' sel' : '');
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = s.type === 'bookmark' ? '⭐' : '🕘';
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = s.title;
    const su = document.createElement('span');
    su.className = 'su';
    su.textContent = s.url;
    row.append(ic, st, su);
    row.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus so blur doesn't cancel the click
      window.browser.navigate(s.url);
      closeSuggest();
      address.blur();
    });
    suggestBox.appendChild(row);
  });
  suggestBox.classList.toggle('open', sugItems.length > 0);
  updateChromeHeight();
}

let sugTimer = null;
address.addEventListener('input', () => {
  clearTimeout(sugTimer);
  const q = address.value.trim();
  if (!q) {
    closeSuggest();
    return;
  }
  sugTimer = setTimeout(async () => {
    sugItems = (await window.browser.suggest(q)) || [];
    sugSelected = -1;
    renderSuggest();
  }, 120);
});

address.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && sugItems.length) {
    e.preventDefault();
    sugSelected = (sugSelected + 1) % sugItems.length;
    renderSuggest();
    return;
  }
  if (e.key === 'ArrowUp' && sugItems.length) {
    e.preventDefault();
    sugSelected = (sugSelected - 1 + sugItems.length) % sugItems.length;
    renderSuggest();
    return;
  }
  if (e.key === 'Escape') {
    closeSuggest();
    return;
  }
  if (e.key === 'Enter') {
    const chosen = sugSelected >= 0 ? sugItems[sugSelected].url : address.value;
    if (chosen && chosen.trim()) {
      window.browser.navigate(chosen);
      closeSuggest();
      address.blur();
    }
  }
});

address.addEventListener('blur', () => setTimeout(closeSuggest, 150));

// ---------------------------------------------------------------------------
// Toolbar buttons
// ---------------------------------------------------------------------------
backBtn.addEventListener('click', () => window.browser.back());
forwardBtn.addEventListener('click', () => window.browser.forward());
reloadBtn.addEventListener('click', () => {
  const active = currentState.tabs.find((t) => t.id === currentState.activeTabId);
  if (active && active.loading) window.browser.stop();
  else window.browser.reload();
});

keepAliveBtn.addEventListener('click', () => {
  if (currentState.activeTabId != null) {
    window.browser.toggleKeepAlive(currentState.activeTabId);
  }
});
starBtn.addEventListener('click', () => window.browser.toggleBookmark());
readerBtn.addEventListener('click', () => window.browser.openReader());
document.getElementById('pip').addEventListener('click', () => window.browser.togglePiP());
shieldBtn.addEventListener('click', () => window.browser.toggleShield());
downloadsBtn.addEventListener('click', () => window.browser.openInternal('downloads'));
menuBtn.addEventListener('click', () => {
  const r = menuBtn.getBoundingClientRect();
  window.browser.openMenu(Math.round(r.left), Math.round(r.bottom + 4));
});

// ---------------------------------------------------------------------------
// Find in page
// ---------------------------------------------------------------------------
function openFind() {
  findbar.classList.add('open');
  updateChromeHeight();
  findText.focus();
  findText.select();
}
function closeFind() {
  findbar.classList.remove('open');
  findCount.textContent = '';
  window.browser.findStop();
  updateChromeHeight();
}

window.browser.onFindOpen(openFind);
window.browser.onFindResult(({ active, matches }) => {
  findCount.textContent = matches ? `${active}/${matches}` : 'कोई नतीजा नहीं';
});

findText.addEventListener('input', () => {
  const t = findText.value.trim();
  if (t) window.browser.findStart(t);
  else {
    findCount.textContent = '';
    window.browser.findStop();
  }
});
findText.addEventListener('keydown', (e) => {
  const t = findText.value.trim();
  if (e.key === 'Enter' && t) window.browser.findNext(t, !e.shiftKey);
  if (e.key === 'Escape') closeFind();
});
document.getElementById('findnext').addEventListener('click', () => {
  const t = findText.value.trim();
  if (t) window.browser.findNext(t, true);
});
document.getElementById('findprev').addEventListener('click', () => {
  const t = findText.value.trim();
  if (t) window.browser.findNext(t, false);
});
document.getElementById('findclose').addEventListener('click', closeFind);

// ---------------------------------------------------------------------------
// Upload sidebar (custom file picker)
// ---------------------------------------------------------------------------
const sidebar = document.getElementById('sidebar');
const sbPathInput = document.getElementById('sb-pathinput');
const sbUp = document.getElementById('sb-up');
const sbBack = document.getElementById('sb-back');
const sbFwd = document.getElementById('sb-fwd');
const sbStar = document.getElementById('sb-star');
const sbList = document.getElementById('sb-list');
const sbFavRow = document.getElementById('sb-fav-row');
const sbQuickRow = document.getElementById('sb-quick-row');
const sbSearch = document.getElementById('sb-search');
const sbSort = document.getElementById('sb-sort');
const sbViewBtn = document.getElementById('sb-view');
const sbAcceptBar = document.getElementById('sb-accept');
const sbChoose = document.getElementById('sb-choose');
const sbCount = document.getElementById('sb-count');
const sbPreviewEl = document.getElementById('sb-preview');

const SB_IMG = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);
const SB_VID = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'ogv']);
const SB_AUD = new Set(['mp3', 'wav', 'm4a', 'ogg', 'oga', 'flac', 'aac']);
const SB_MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf',
  'text/plain': 'txt', 'text/csv': 'csv', 'application/json': 'json',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

let sbCurDir = '';
let sbParent = null;
let sbFavs = [];
let sbMultiple = false;
let sbEntries = []; // raw entries of the current view
let sbMode = 'dir'; // 'dir' | 'recent'
let sbGrid = false;
let sbAccept = null; // { match(name), label } or null
let sbAcceptOff = false; // user chose "show all"
let sbHistory = [];
let sbHistPtr = -1;
const sbSelected = new Set();

function sbFmtSize(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}
function sbExt(name) {
  return (name.split('.').pop() || '').toLowerCase();
}
function sbExtIcon(name) {
  const e = sbExt(name);
  if (SB_IMG.has(e)) return '🖼';
  if (e === 'pdf') return '📕';
  if (['doc', 'docx', 'odt', 'rtf'].includes(e)) return '📘';
  if (['xls', 'xlsx', 'csv'].includes(e)) return '📗';
  if (['ppt', 'pptx'].includes(e)) return '📙';
  if (SB_AUD.has(e)) return '🎵';
  if (SB_VID.has(e)) return '🎬';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return '🗜';
  return '📄';
}

// Turn an <input accept="..."> value into a matcher + a friendly Hindi label.
function buildAcceptFilter(accept) {
  if (!accept || !accept.trim()) return null;
  const toks = accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const exts = new Set();
  const cats = new Set();
  let any = false;
  for (const t of toks) {
    if (t === '*/*' || t === '*') any = true;
    else if (t.endsWith('/*')) cats.add(t.slice(0, t.indexOf('/')));
    else if (t.startsWith('.')) exts.add(t.slice(1));
    else if (SB_MIME_EXT[t]) exts.add(SB_MIME_EXT[t]);
    else if (t.includes('/')) cats.add(t.split('/')[0]);
  }
  if (any || (!exts.size && !cats.size)) return null;
  const catSets = { image: SB_IMG, video: SB_VID, audio: SB_AUD };
  const catName = { image: 'फ़ोटो', video: 'वीडियो', audio: 'ऑडियो', text: 'टेक्स्ट', application: 'दस्तावेज़' };
  const labels = [];
  cats.forEach((c) => labels.push(catName[c] || c));
  exts.forEach((e) => labels.push('.' + e));
  return {
    label: labels.join(', '),
    match(name) {
      const e = sbExt(name);
      if (exts.has(e)) return true;
      for (const c of cats) {
        if (catSets[c] && catSets[c].has(e)) return true;
        if (!catSets[c]) return true; // unknown category -> don't hide
      }
      return false;
    },
  };
}

function positionSidebar() {
  const findH = findbar.classList.contains('open') ? findbar.offsetHeight : 0;
  sidebar.style.top = tabstrip.offsetHeight + document.getElementById('navbar').offsetHeight + findH + 'px';
  sidebar.style.bottom = '0';
}

let sbPreviewToken = 0;
async function sbPreview(pth) {
  const token = ++sbPreviewToken;
  if (!pth) {
    sbPreviewEl.classList.remove('show');
    sbPreviewEl.innerHTML = '';
    return;
  }
  sbPreviewEl.classList.add('show');
  sbPreviewEl.innerHTML = '<div class="pvinfo">प्रीव्यू लोड हो रहा…</div>';
  const info = await window.browser.fsPreview(pth);
  if (token !== sbPreviewToken) return;
  sbPreviewEl.innerHTML = '';
  if (!info || info.kind === 'none') {
    sbPreviewEl.classList.remove('show');
    return;
  }
  if (info.name) {
    const nm = document.createElement('div');
    nm.className = 'pvname';
    nm.textContent = info.name + (info.size ? ' · ' + sbFmtSize(info.size) : '');
    sbPreviewEl.appendChild(nm);
  }
  if (info.kind === 'image') {
    const img = new Image();
    img.src = info.url;
    img.onerror = () => (sbPreviewEl.innerHTML = '<div class="pvinfo">इमेज नहीं दिखा पाए</div>');
    sbPreviewEl.appendChild(img);
  } else if (info.kind === 'video') {
    const v = document.createElement('video');
    v.src = info.url;
    v.controls = true;
    sbPreviewEl.appendChild(v);
  } else if (info.kind === 'audio') {
    const a = document.createElement('audio');
    a.src = info.url;
    a.controls = true;
    sbPreviewEl.appendChild(a);
  } else if (info.kind === 'pdf') {
    const f = document.createElement('iframe');
    f.src = info.url;
    sbPreviewEl.appendChild(f);
  } else if (info.kind === 'text') {
    const pre = document.createElement('pre');
    pre.textContent = info.text;
    sbPreviewEl.appendChild(pre);
  } else {
    const d = document.createElement('div');
    d.className = 'pvinfo';
    d.textContent = 'इस तरह की फ़ाइल का प्रीव्यू उपलब्ध नहीं है।';
    sbPreviewEl.appendChild(d);
  }
}

function renderChips() {
  sbFavRow.innerHTML = '';
  if (!sbFavs.length) {
    sbFavRow.innerHTML = '<span style="font-size:11px;color:var(--dim)">कोई फ़ेवरेट नहीं — ऊपर ☆ से जोड़ें</span>';
  }
  for (const f of sbFavs) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    const label = document.createElement('span');
    label.textContent = '⭐ ' + f.name;
    label.addEventListener('click', () => sbLoad(f.path));
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '✕';
    x.title = 'फ़ेवरेट से हटाएँ';
    x.addEventListener('click', async (e) => {
      e.stopPropagation();
      sbFavs = await window.browser.fsFavorite('remove', f.path);
      renderChips();
      updateStar();
    });
    chip.append(label, x);
    sbFavRow.appendChild(chip);
  }
}

function updateStar() {
  sbStar.textContent = sbFavs.some((f) => f.path === sbCurDir) ? '★' : '☆';
  sbStar.style.display = sbMode === 'dir' ? '' : 'none';
}

function updateNavButtons() {
  sbBack.disabled = sbHistPtr <= 0;
  sbFwd.disabled = sbHistPtr >= sbHistory.length - 1;
  sbUp.disabled = sbMode !== 'dir' || !sbParent;
}

// Filter + sort the raw entries and paint them.
function applyView() {
  const q = sbSearch.value.trim().toLowerCase();
  let items = sbEntries.slice();

  if (q) items = items.filter((it) => it.name.toLowerCase().includes(q));
  if (sbAccept && !sbAcceptOff) items = items.filter((it) => it.isDir || sbAccept.match(it.name));

  const dirs = items.filter((it) => it.isDir);
  const files = items.filter((it) => !it.isDir);
  const mode = sbSort.value;
  const byName = (a, b) => a.name.localeCompare(b.name, 'hi');
  const byDate = (a, b) => (b.mtime || 0) - (a.mtime || 0);
  const bySize = (a, b) => (b.size || 0) - (a.size || 0);
  const cmp = mode === 'date' ? byDate : mode === 'size' ? bySize : byName;
  dirs.sort(mode === 'name' ? byName : cmp);
  files.sort(cmp);
  const ordered = sbMode === 'recent' ? files : dirs.concat(files);

  sbList.classList.toggle('grid', sbGrid);
  sbList.innerHTML = '';
  if (!ordered.length) {
    sbList.innerHTML = '<div id="sb-empty">' + (q ? 'कुछ नहीं मिला' : 'यहाँ दिखाने को कुछ नहीं') + '</div>';
    return;
  }
  for (const item of ordered) {
    const row = document.createElement('div');
    row.className = 'fitem' + (sbSelected.has(item.path) ? ' sel' : '');

    if (sbGrid && item.url) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = item.url;
      img.onerror = () => {
        img.replaceWith(Object.assign(document.createElement('span'), { className: 'ic', textContent: item.isDir ? '📁' : sbExtIcon(item.name) }));
      };
      row.appendChild(img);
    } else if (!sbGrid && item.url) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = item.url;
      img.onerror = () => {
        img.replaceWith(Object.assign(document.createElement('span'), { className: 'ic', textContent: sbExtIcon(item.name) }));
      };
      row.appendChild(img);
    } else {
      const ic = document.createElement('span');
      ic.className = 'ic';
      ic.textContent = item.isDir ? '📁' : sbExtIcon(item.name);
      row.appendChild(ic);
    }

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = item.name;
    row.appendChild(nm);

    if (!item.isDir) {
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = sbFmtSize(item.size);
      row.appendChild(sz);
      row.addEventListener('click', () => selectFile(item, row));
      row.addEventListener('dblclick', () => {
        sbSelected.clear();
        sbSelected.add(item.path);
        doChoose();
      });
    } else {
      row.addEventListener('click', () => sbLoad(item.path));
    }
    sbList.appendChild(row);
  }
}

function selectFile(item, row) {
  if (!sbMultiple) {
    sbSelected.clear();
    sbSelected.add(item.path);
    [...sbList.children].forEach((c) => c.classList.remove('sel'));
    row.classList.add('sel');
  } else if (sbSelected.has(item.path)) {
    sbSelected.delete(item.path);
    row.classList.remove('sel');
  } else {
    sbSelected.add(item.path);
    row.classList.add('sel');
  }
  updateChooseBtn();
  sbPreview(item.path);
}

function setEntries(entries) {
  sbEntries = entries || [];
  sbSelected.clear();
  updateChooseBtn();
  applyView();
}

async function sbLoad(dir, record = true) {
  const data = await window.browser.fsList(dir);
  if (!data) return;
  sbPreview(null);
  sbMode = 'dir';
  sbCurDir = data.path;
  sbParent = data.parent;
  sbFavs = data.favorites || [];
  sbPathInput.value = data.path;
  if (record) {
    sbHistory = sbHistory.slice(0, sbHistPtr + 1);
    if (sbHistory[sbHistPtr] !== data.path) {
      sbHistory.push(data.path);
      sbHistPtr = sbHistory.length - 1;
    }
  }
  renderChips();
  updateStar();
  updateNavButtons();
  renderQuick(data.quick || []);
  setEntries(data.entries);
}

async function loadRecent() {
  sbPreview(null);
  sbMode = 'recent';
  sbCurDir = '';
  sbParent = null;
  sbPathInput.value = '';
  updateStar();
  updateNavButtons();
  const items = (await window.browser.fsRecent()) || [];
  setEntries(items);
}

function renderQuick(quick) {
  sbQuickRow.innerHTML = '';
  const recentChip = document.createElement('div');
  recentChip.className = 'chip';
  recentChip.textContent = '🕘 हाल की फ़ाइलें';
  recentChip.addEventListener('click', loadRecent);
  sbQuickRow.appendChild(recentChip);
  for (const q of quick) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.textContent = q.name;
    chip.addEventListener('click', () => sbLoad(q.path));
    sbQuickRow.appendChild(chip);
  }
}

function updateChooseBtn() {
  const n = sbSelected.size;
  sbChoose.disabled = n === 0;
  sbChoose.textContent = n > 1 ? n + ' फ़ाइलें अपलोड करें' : 'अपलोड करें';
  sbCount.textContent = n ? n + ' चुनी गई' : '';
}

function doChoose() {
  if (!sbSelected.size) return;
  window.browser.uploadChoose([...sbSelected]);
}

sbUp.addEventListener('click', () => sbParent && sbLoad(sbParent));
sbBack.addEventListener('click', () => {
  if (sbHistPtr > 0) {
    sbHistPtr--;
    sbLoad(sbHistory[sbHistPtr], false);
  }
});
sbFwd.addEventListener('click', () => {
  if (sbHistPtr < sbHistory.length - 1) {
    sbHistPtr++;
    sbLoad(sbHistory[sbHistPtr], false);
  }
});
sbPathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && sbPathInput.value.trim()) sbLoad(sbPathInput.value.trim());
});
sbStar.addEventListener('click', async () => {
  if (sbMode !== 'dir') return;
  const isFav = sbFavs.some((f) => f.path === sbCurDir);
  sbFavs = await window.browser.fsFavorite(isFav ? 'remove' : 'add', sbCurDir);
  renderChips();
  updateStar();
});
sbSearch.addEventListener('input', applyView);
sbSort.addEventListener('change', applyView);
sbViewBtn.addEventListener('click', () => {
  sbGrid = !sbGrid;
  sbViewBtn.classList.toggle('grid', sbGrid);
  applyView();
});
sbChoose.addEventListener('click', doChoose);
document.getElementById('sb-cancel').addEventListener('click', () => window.browser.uploadCancel());

function showAcceptBar() {
  if (sbAccept) {
    sbAcceptBar.classList.add('show');
    sbAcceptBar.innerHTML = '';
    const txt = document.createElement('span');
    txt.textContent = 'इस साइट को चाहिए: ' + sbAccept.label;
    const link = document.createElement('a');
    link.textContent = sbAcceptOff ? 'सिर्फ़ ज़रूरी दिखाएँ' : 'सब दिखाएँ';
    link.addEventListener('click', () => {
      sbAcceptOff = !sbAcceptOff;
      link.textContent = sbAcceptOff ? 'सिर्फ़ ज़रूरी दिखाएँ' : 'सब दिखाएँ';
      applyView();
    });
    sbAcceptBar.append(txt, link);
  } else {
    sbAcceptBar.classList.remove('show');
    sbAcceptBar.innerHTML = '';
  }
}

window.browser.onUploadOpen((d) => {
  sbMultiple = !!(d && d.multiple);
  sbAccept = buildAcceptFilter(d && d.accept);
  sbAcceptOff = false;
  document.getElementById('sb-hint').textContent = sbMultiple
    ? 'एक या कई फ़ाइलें चुनें, फिर "अपलोड करें" दबाएँ'
    : 'फ़ोल्डर खोलें, फ़ाइल चुनें, फिर "अपलोड करें" दबाएँ';
  showAcceptBar();
  sidebar.classList.add('open');
  positionSidebar();
  sbHistory = [];
  sbHistPtr = -1;
  sbSearch.value = '';
  sbLoad('');
});
window.browser.onUploadClose(() => {
  sidebar.classList.remove('open');
  sbSelected.clear();
  sbPreview(null);
});

// ---------------------------------------------------------------------------
// Voice: speak a command like "यूट्यूब खोलो" — routed through nav:go (which
// parses commands). Uses the browser's built-in speech recognition.
// ---------------------------------------------------------------------------
const micBtn = document.getElementById('mic');
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) {
  micBtn.style.display = 'none';
} else {
  let rec = null;
  let listening = false;
  micBtn.addEventListener('click', () => {
    if (listening) {
      if (rec) rec.stop();
      return;
    }
    rec = new SR();
    rec.lang = 'hi-IN';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      listening = true;
      micBtn.classList.add('listening');
      address.placeholder = '🎤 सुन रहा हूँ… बोलिए';
    };
    rec.onerror = () => {};
    rec.onend = () => {
      listening = false;
      micBtn.classList.remove('listening');
      address.placeholder = 'सर्च करें, पता लिखें, या हिंदी में कहें — जैसे: यूट्यूब खोलो';
    };
    rec.onresult = (e) => {
      const said = e.results[0][0].transcript;
      if (said && said.trim()) window.browser.navigate(said.trim());
    };
    try {
      rec.start();
    } catch (err) {
      listening = false;
      micBtn.classList.remove('listening');
    }
  });
}
