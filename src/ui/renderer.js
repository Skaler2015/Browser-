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
  tabstrip.innerHTML = '';

  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className =
      'tab' +
      (tab.id === state.activeTabId ? ' active' : '') +
      (tab.isPrivate ? ' private' : '') +
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
