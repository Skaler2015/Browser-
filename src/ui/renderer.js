const tabstrip = document.getElementById('tabstrip');
const address = document.getElementById('address');
const backBtn = document.getElementById('back');
const forwardBtn = document.getElementById('forward');
const reloadBtn = document.getElementById('reload');
const blockedEl = document.getElementById('blocked');
const keepAliveBtn = document.getElementById('keepalive');
const starBtn = document.getElementById('star');
const shieldBtn = document.getElementById('shield');
const downloadsBtn = document.getElementById('downloads');
const menuBtn = document.getElementById('menu');
const findbar = document.getElementById('findbar');
const findText = document.getElementById('findtext');
const findCount = document.getElementById('findcount');

const BASE_CHROME = 84;
const FIND_CHROME = 118;

let currentState = { tabs: [], activeTabId: null };

function render(state) {
  currentState = state;
  tabstrip.innerHTML = '';

  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className =
      'tab' + (tab.id === state.activeTabId ? ' active' : '') + (tab.isPrivate ? ' private' : '');
    el.title = tab.title;
    el.addEventListener('click', () => window.browser.activateTab(tab.id));
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) window.browser.closeTab(tab.id); // middle click
    });

    if (tab.loading) {
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      el.appendChild(spinner);
    }

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = (tab.isPrivate ? '🕶 ' : '') + tab.title;
    el.appendChild(title);

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

    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      window.browser.closeTab(tab.id);
    });
    el.appendChild(close);

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

address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && address.value.trim()) {
    window.browser.navigate(address.value);
    address.blur();
  }
});

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
shieldBtn.addEventListener('click', () => window.browser.toggleShield());
downloadsBtn.addEventListener('click', () => window.browser.openInternal('downloads'));
menuBtn.addEventListener('click', () => {
  const r = menuBtn.getBoundingClientRect();
  window.browser.openMenu(Math.round(r.left), Math.round(r.bottom + 4));
});

// ---- find in page ----
function openFind() {
  findbar.classList.add('open');
  window.browser.setChromeHeight(FIND_CHROME);
  findText.focus();
  findText.select();
}
function closeFind() {
  findbar.classList.remove('open');
  findCount.textContent = '';
  window.browser.findStop();
  window.browser.setChromeHeight(BASE_CHROME);
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
