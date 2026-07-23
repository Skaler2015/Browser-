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
const sbCwd = document.getElementById('sb-cwd');
const sbUp = document.getElementById('sb-up');
const sbStar = document.getElementById('sb-star');
const sbList = document.getElementById('sb-list');
const sbFavRow = document.getElementById('sb-fav-row');
const sbQuickRow = document.getElementById('sb-quick-row');
const sbChoose = document.getElementById('sb-choose');
const sbCount = document.getElementById('sb-count');
const sbPreviewEl = document.getElementById('sb-preview');

let sbCurDir = '';
let sbParent = null;
let sbFavs = [];
let sbMultiple = false;
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
function sbExtIcon(name) {
  const e = (name.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(e)) return '🖼';
  if (['pdf'].includes(e)) return '📕';
  if (['doc', 'docx', 'odt', 'rtf'].includes(e)) return '📘';
  if (['xls', 'xlsx', 'csv'].includes(e)) return '📗';
  if (['ppt', 'pptx'].includes(e)) return '📙';
  if (['mp3', 'wav', 'm4a', 'ogg'].includes(e)) return '🎵';
  if (['mp4', 'mkv', 'mov', 'avi', 'webm'].includes(e)) return '🎬';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return '🗜';
  if (['txt', 'md'].includes(e)) return '📄';
  return '📄';
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
  if (token !== sbPreviewToken) return; // a newer click superseded this one
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

function positionSidebar() {
  const findH = findbar.classList.contains('open') ? findbar.offsetHeight : 0;
  sidebar.style.top = tabstrip.offsetHeight + document.getElementById('navbar').offsetHeight + findH + 'px';
  sidebar.style.bottom = '0';
}

async function sbLoad(dir) {
  const data = await window.browser.fsList(dir);
  if (!data) return;
  sbPreview(null); // moving folders clears any open preview
  sbCurDir = data.path;
  sbParent = data.parent;
  sbFavs = data.favorites || [];
  sbCwd.textContent = data.path;
  sbCwd.title = data.path;
  sbUp.disabled = !data.parent;
  sbStar.textContent = sbFavs.some((f) => f.path === data.path) ? '★' : '☆';
  sbSelected.clear();
  updateChooseBtn();

  // favorites
  sbFavRow.innerHTML = '';
  if (!sbFavs.length) sbFavRow.innerHTML = '<span style="font-size:11px;color:var(--dim)">कोई फ़ेवरेट नहीं — ऊपर ☆ से जोड़ें</span>';
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
      sbLoad(sbCurDir);
    });
    chip.append(label, x);
    sbFavRow.appendChild(chip);
  }

  // quick access
  sbQuickRow.innerHTML = '';
  for (const q of data.quick || []) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.textContent = q.name;
    chip.addEventListener('click', () => sbLoad(q.path));
    sbQuickRow.appendChild(chip);
  }

  // entries
  sbList.innerHTML = '';
  if (data.error) {
    sbList.innerHTML = '<div id="sb-empty">यह फ़ोल्डर नहीं खुल पाया</div>';
    return;
  }
  if (!data.entries.length) {
    sbList.innerHTML = '<div id="sb-empty">यह फ़ोल्डर खाली है</div>';
    return;
  }
  for (const item of data.entries) {
    const row = document.createElement('div');
    row.className = 'fitem';
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = item.isDir ? '📁' : sbExtIcon(item.name);
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = item.name;
    row.append(ic, nm);
    if (!item.isDir) {
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = sbFmtSize(item.size);
      row.appendChild(sz);
      row.addEventListener('click', () => {
        if (!sbMultiple) {
          sbSelected.clear();
          sbSelected.add(item.path);
        } else if (sbSelected.has(item.path)) {
          sbSelected.delete(item.path);
        } else {
          sbSelected.add(item.path);
        }
        [...sbList.children].forEach((c) => c.classList.remove('sel'));
        if (sbSelected.has(item.path)) row.classList.add('sel');
        else if (!sbMultiple) row.classList.remove('sel');
        if (sbMultiple) {
          // re-mark all selected
          [...sbList.children].forEach((c, i) => {
            if (data.entries[i] && sbSelected.has(data.entries[i].path)) c.classList.add('sel');
          });
        }
        updateChooseBtn();
        sbPreview(item.path);
      });
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

function updateChooseBtn() {
  const n = sbSelected.size;
  sbChoose.disabled = n === 0;
  sbChoose.textContent = n > 1 ? `${n} फ़ाइलें अपलोड करें` : 'अपलोड करें';
  sbCount.textContent = n ? n + ' चुनी गई' : '';
}

function doChoose() {
  if (!sbSelected.size) return;
  window.browser.uploadChoose([...sbSelected]);
}

sbUp.addEventListener('click', () => sbParent && sbLoad(sbParent));
sbStar.addEventListener('click', async () => {
  const isFav = sbFavs.some((f) => f.path === sbCurDir);
  sbFavs = await window.browser.fsFavorite(isFav ? 'remove' : 'add', sbCurDir);
  sbStar.textContent = sbFavs.some((f) => f.path === sbCurDir) ? '★' : '☆';
  sbLoad(sbCurDir);
});
sbChoose.addEventListener('click', doChoose);
document.getElementById('sb-cancel').addEventListener('click', () => window.browser.uploadCancel());

window.browser.onUploadOpen((d) => {
  sbMultiple = !!(d && d.multiple);
  document.getElementById('sb-hint').textContent = sbMultiple
    ? 'एक या कई फ़ाइलें चुनें, फिर "अपलोड करें" दबाएँ'
    : 'फ़ोल्डर खोलें, फ़ाइल चुनें, फिर "अपलोड करें" दबाएँ';
  sidebar.classList.add('open');
  positionSidebar();
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
