const tabstrip = document.getElementById('tabstrip');
const address = document.getElementById('address');
const backBtn = document.getElementById('back');
const forwardBtn = document.getElementById('forward');
const reloadBtn = document.getElementById('reload');
const blockedEl = document.getElementById('blocked');

let currentState = { tabs: [], activeTabId: null };

function render(state) {
  currentState = state;
  tabstrip.innerHTML = '';

  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === state.activeTabId ? ' active' : '');
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
    title.textContent = tab.title;
    el.appendChild(title);

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
    document.title = active.title + ' — TezBrowser';
  }
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
