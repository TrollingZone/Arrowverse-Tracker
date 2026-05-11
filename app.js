// Arrowverse Tracker
//
// Data flow:
//   - Server is source of truth for `watched` + `history` (data/progress.json).
//   - On load we hydrate from the server. localStorage holds the last known
//     snapshot so the PWA can still render when offline.
//   - Every mutation optimistically updates the UI, then calls the API.
//   - If the API call fails (offline), the change is queued and flushed when
//     we come back online or next focus.
//   - Background refresh happens on visibility change / focus / an interval
//     so a change made on the phone shows up on the laptop without reload.

const CACHE_KEY = 'arrowverse-tracker/cache/v2';
const PREFS_KEY = 'arrowverse-tracker/prefs/v2';
const QUEUE_KEY = 'arrowverse-tracker/queue/v1';
const DEVICE_KEY = 'arrowverse-tracker/device/v1';
const THEME_KEY = 'arrowverse-tracker/theme/v1';

const THEMES = [
  { id: 'multiverse',         name: 'Multiverse',          tag: 'Default',        accent: '#4fd1ff', accent2: '#8a5bff', bg0: '#05070d', bg1: '#151d37', haloA: 'rgba(138,91,255,0.45)',  haloB: 'rgba(79,209,255,0.45)' },
  { id: 'arrow',              name: 'Arrow',               tag: 'Emerald',        accent: '#3bd37a', accent2: '#0a9b59', bg0: '#050d08', bg1: '#123322', haloA: 'rgba(10,155,89,0.55)',   haloB: 'rgba(59,211,122,0.5)' },
  { id: 'flash',              name: 'The Flash',           tag: 'Speed Force',    accent: '#ff3b3b', accent2: '#ffb800', bg0: '#0b0406', bg1: '#301017', haloA: 'rgba(255,59,59,0.55)',   haloB: 'rgba(255,184,0,0.45)' },
  { id: 'supergirl',          name: 'Supergirl',           tag: 'Kryptonian',     accent: '#6aa9ff', accent2: '#ff4c4c', bg0: '#04080f', bg1: '#132a54', haloA: 'rgba(106,169,255,0.55)', haloB: 'rgba(255,76,76,0.4)' },
  { id: 'legends',            name: 'Legends of Tomorrow', tag: 'Temporal',       accent: '#b478ff', accent2: '#49e3d6', bg0: '#070512', bg1: '#271654', haloA: 'rgba(180,120,255,0.55)', haloB: 'rgba(73,227,214,0.45)' },
  { id: 'batwoman',           name: 'Batwoman',            tag: 'Gotham',         accent: '#ff4b8d', accent2: '#c21d4a', bg0: '#0a0407', bg1: '#300e1e', haloA: 'rgba(194,29,74,0.55)',   haloB: 'rgba(255,75,141,0.5)' },
  { id: 'black-lightning',    name: 'Black Lightning',     tag: 'Storm',          accent: '#f2b93c', accent2: '#6aa9ff', bg0: '#0a0602', bg1: '#341d09', haloA: 'rgba(242,185,60,0.55)',  haloB: 'rgba(106,169,255,0.35)' },
  { id: 'superman-and-lois',  name: 'Superman & Lois',     tag: 'Smallville',     accent: '#4bb9ff', accent2: '#ff3838', bg0: '#030812', bg1: '#0f2d64', haloA: 'rgba(75,185,255,0.6)',   haloB: 'rgba(255,56,56,0.4)' },
  { id: 'constantine',        name: 'Constantine',         tag: 'Occult',         accent: '#f5d76e', accent2: '#d16b2e', bg0: '#0a0703', bg1: '#2e220e', haloA: 'rgba(209,107,46,0.55)',  haloB: 'rgba(245,215,110,0.45)' },
  { id: 'vixen',              name: 'Vixen',               tag: 'Totem',          accent: '#ff9a3b', accent2: '#b94b14', bg0: '#0a0604', bg1: '#341e10', haloA: 'rgba(185,75,20,0.55)',   haloB: 'rgba(255,154,59,0.45)' },
  { id: 'stargirl',           name: 'Stargirl',            tag: 'Cosmic',         accent: '#ffd84d', accent2: '#8a5bff', bg0: '#080617', bg1: '#231a5d', haloA: 'rgba(138,91,255,0.5)',   haloB: 'rgba(255,216,77,0.5)' },
  { id: 'freedom-fighters',   name: 'Freedom Fighters',    tag: 'Pulp',           accent: '#ff7a5c', accent2: '#c23c1d', bg0: '#0a0504', bg1: '#331410', haloA: 'rgba(194,60,29,0.55)',   haloB: 'rgba(255,122,92,0.45)' },
  { id: 'crisis',             name: 'Crisis',              tag: 'Antimatter',     accent: '#ff4081', accent2: '#8a2be2', bg0: '#08010c', bg1: '#2c0a3e', haloA: 'rgba(138,43,226,0.6)',   haloB: 'rgba(255,64,129,0.55)' },
];
const DEFAULT_THEME = 'multiverse';

const SHOW_COLOR = {
  arrow: 'var(--c-arrow)',
  batwoman: 'var(--c-batwoman)',
  'black-lightning': 'var(--c-black-lightning)',
  constantine: 'var(--c-constantine)',
  flash: 'var(--c-flash)',
  'freedom-fighters': 'var(--c-freedom-fighters)',
  legends: 'var(--c-legends)',
  stargirl: 'var(--c-stargirl)',
  supergirl: 'var(--c-supergirl)',
  'superman-and-lois': 'var(--c-superman-and-lois)',
  vixen: 'var(--c-vixen)',
};

const state = {
  data: null,
  watched: new Set(),
  history: [],
  serverVersion: 0,
  // UI prefs (stay local, per-device):
  hiddenShows: new Set(),
  query: '',
  hideWatched: false,
  // Sync status:
  online: navigator.onLine,
  syncing: false,
  lastError: null,
  pendingQueue: [],
};

// ---------- Theme system ------------------------------------------------

function getStoredTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t && THEMES.some((x) => x.id === t)) return t;
  } catch {}
  return DEFAULT_THEME;
}

function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) || THEMES[0];
  document.documentElement.setAttribute('data-theme', theme.id);
  // Keep the mobile browser chrome in sync with the theme bg.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.bg0);
  try { localStorage.setItem(THEME_KEY, theme.id); } catch {}
  // Update any active-state visuals in the modal if it's open.
  const grid = document.getElementById('theme-grid');
  if (grid) {
    grid.querySelectorAll('.theme-card').forEach((card) => {
      card.classList.toggle('active', card.dataset.theme === theme.id);
      card.setAttribute('aria-checked', card.dataset.theme === theme.id ? 'true' : 'false');
    });
  }
}

function renderThemeGrid() {
  const grid = document.getElementById('theme-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const current = getStoredTheme();
  for (const t of THEMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-card' + (t.id === current ? ' active' : '');
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', t.id === current ? 'true' : 'false');
    btn.dataset.theme = t.id;
    btn.style.setProperty('--tc-accent', t.accent);
    btn.style.setProperty('--tc-accent-2', t.accent2);
    btn.style.setProperty('--tc-bg-0', t.bg0);
    btn.style.setProperty('--tc-bg-1', t.bg1);
    btn.style.setProperty('--tc-halo-a', t.haloA);
    btn.style.setProperty('--tc-halo-b', t.haloB);
    btn.innerHTML = `
      <span class="theme-swatch" aria-hidden="true"></span>
      <span class="theme-name">${escapeHtml(t.name)}</span>
      <span class="theme-tag">${escapeHtml(t.tag)}</span>
    `;
    btn.addEventListener('click', () => applyTheme(t.id));
    grid.appendChild(btn);
  }
}

function openSettings() {
  const modal = document.getElementById('settings-modal');
  renderThemeGrid();
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  // Focus close button for accessibility.
  requestAnimationFrame(() => document.getElementById('settings-close')?.focus());
}

function closeSettings() {
  const modal = document.getElementById('settings-modal');
  modal.hidden = true;
  document.body.style.overflow = '';
}

// Apply stored theme immediately so there's no flash of default colors.
applyTheme(getStoredTheme());

// ---------- Device id (for history log) ---------------------------------

function getDeviceName() {
  let name = localStorage.getItem(DEVICE_KEY);
  if (!name) {
    // Guess something friendly.
    const ua = navigator.userAgent;
    let guess = 'device';
    if (/iPad/i.test(ua)) guess = 'iPad';
    else if (/iPhone/i.test(ua)) guess = 'iPhone';
    else if (/Android/i.test(ua)) guess = 'Android';
    else if (/Macintosh/i.test(ua)) guess = 'Mac';
    else if (/Windows/i.test(ua)) guess = 'Windows';
    else if (/Linux/i.test(ua)) guess = 'Linux';
    const suffix = Math.random().toString(36).slice(2, 6);
    name = `${guess}-${suffix}`;
    localStorage.setItem(DEVICE_KEY, name);
  }
  return name;
}

// ---------- Local persistence (cache + prefs + queue) -------------------

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.hiddenShows)) state.hiddenShows = new Set(parsed.hiddenShows);
    if (typeof parsed.hideWatched === 'boolean') state.hideWatched = parsed.hideWatched;
  } catch (e) {
    console.warn('Could not load prefs:', e);
  }
}

function savePrefs() {
  localStorage.setItem(
    PREFS_KEY,
    JSON.stringify({
      hiddenShows: [...state.hiddenShows],
      hideWatched: state.hideWatched,
    })
  );
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.watched)) state.watched = new Set(parsed.watched);
    if (Array.isArray(parsed.history)) state.history = parsed.history;
    if (typeof parsed.version === 'number') state.serverVersion = parsed.version;
  } catch (e) {
    console.warn('Could not load cache:', e);
  }
}

function saveCache() {
  localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({
      watched: [...state.watched],
      history: state.history,
      version: state.serverVersion,
    })
  );
}

function loadQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    state.pendingQueue = raw ? JSON.parse(raw) : [];
  } catch {
    state.pendingQueue = [];
  }
}

function saveQueue() {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(state.pendingQueue));
}

function enqueue(op) {
  state.pendingQueue.push(op);
  saveQueue();
  renderSync();
}

// ---------- Data loading -----------------------------------------------

async function loadData() {
  const res = await fetch('data/episodes.json');
  if (!res.ok) throw new Error('Failed to load episode data');
  state.data = await res.json();
}

// ---------- Server sync -------------------------------------------------

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

function applyServerState(serverState) {
  if (!serverState) return;
  const prevWatched = state.watched;
  const newWatched = new Set(serverState.watched || []);
  const sameWatched =
    prevWatched.size === newWatched.size &&
    [...prevWatched].every((id) => newWatched.has(id));

  state.watched = newWatched;
  state.history = serverState.history || [];
  state.serverVersion = serverState.version || 0;
  saveCache();
  return { sameWatched };
}

// Are there any rows currently vanishing? If so, don't clobber the list.
function listIsAnimating() {
  return !!document.querySelector('.episode.vanishing, .episode.collapsing');
}

async function pullFromServer() {
  try {
    setSyncing(true);
    const data = await apiFetch('/api/progress');
    const res = applyServerState(data);
    state.lastError = null;
    // Only re-render the full list if the server actually has different
    // watched data than we already do; otherwise we'd kill any in-flight
    // vanish animations. Stats/history/sync are cheap and safe to refresh.
    renderStats();
    renderHistory();
    renderSync();
    if (res && !res.sameWatched && !listIsAnimating()) {
      renderList();
    }
  } catch (e) {
    state.lastError = e.message;
    renderSync();
  } finally {
    setSyncing(false);
  }
}

async function flushQueue() {
  if (state.pendingQueue.length === 0) return;
  const device = getDeviceName();
  while (state.pendingQueue.length > 0) {
    const op = state.pendingQueue[0];
    try {
      setSyncing(true);
      let result;
      if (op.type === 'toggle') {
        result = await apiFetch('/api/progress/toggle', {
          method: 'POST',
          body: JSON.stringify({ id: op.id, watched: op.watched, device }),
        });
      } else if (op.type === 'replace') {
        result = await apiFetch('/api/progress', {
          method: 'PUT',
          body: JSON.stringify({ watched: op.watched, device }),
        });
      } else if (op.type === 'reset') {
        result = await apiFetch('/api/progress', {
          method: 'DELETE',
          body: JSON.stringify({ device }),
        });
      }
      applyServerState(result);
      state.pendingQueue.shift();
      saveQueue();
    } catch (e) {
      state.lastError = e.message;
      break; // stop, try again later
    } finally {
      setSyncing(false);
    }
  }
  // Refresh cheap panels, but leave the episode list alone so any vanish
  // animation still in progress can finish without getting wiped out.
  renderStats();
  renderHistory();
  renderSync();
}

async function syncNow() {
  await flushQueue();
  await pullFromServer();
}

// ---------- Derived helpers --------------------------------------------

function getNextEpisode() {
  return state.data.episodes.find((ep) => !state.watched.has(ep.id)) || null;
}

function matchesFilters(ep) {
  if (state.hiddenShows.has(ep.show)) return false;
  if (state.hideWatched && state.watched.has(ep.id)) return false;
  if (state.query) {
    const q = state.query.toLowerCase();
    const haystack = `${ep.series} ${ep.code} ${ep.title}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

// ---------- Rendering --------------------------------------------------

function renderAll() {
  renderStats();
  renderShowFilters();
  renderList();
  renderHistory();
  renderSync();
}

function renderStats() {
  const total = state.data.episodes.length;
  const watched = state.watched.size;
  const pct = total ? Math.round((watched / total) * 100) : 0;

  document.getElementById('stat-watched').textContent = watched.toLocaleString();
  document.getElementById('stat-total').textContent = total.toLocaleString();
  document.getElementById('stat-percent').textContent = pct + '%';

  const next = getNextEpisode();
  document.getElementById('stat-next').textContent = next
    ? `${next.series} ${next.code}`
    : 'All caught up';

  document.getElementById('progress-bar').style.width = pct + '%';
}

function reducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function renderShowFilters() {
  const container = document.getElementById('show-filters');
  container.innerHTML = '';
  for (const show of state.data.shows) {
    const active = !state.hiddenShows.has(show.slug);
    const chip = document.createElement('button');
    chip.className = 'chip' + (active ? ' active' : '');
    chip.style.setProperty('--chip-color', SHOW_COLOR[show.slug] || 'var(--accent)');
    chip.dataset.show = show.slug;
    chip.innerHTML = `
      <span class="dot"></span>
      <span>${show.name}</span>
      <span class="count">${show.count}</span>
    `;
    chip.addEventListener('click', () => {
      if (state.hiddenShows.has(show.slug)) state.hiddenShows.delete(show.slug);
      else state.hiddenShows.add(show.slug);
      savePrefs();
      renderShowFilters();
      renderList();
    });
    container.appendChild(chip);
  }
}

function renderList() {
  const container = document.getElementById('episode-list');
  const empty = document.getElementById('empty-state');

  const next = getNextEpisode();
  const rows = state.data.episodes.filter(matchesFilters);

  container.innerHTML = '';
  if (rows.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const ep of rows) frag.appendChild(buildRow(ep, next));
  container.appendChild(frag);
}

function buildRow(ep, next) {
  const row = document.createElement('div');
  const isWatched = state.watched.has(ep.id);
  const isNext = next && ep.id === next.id;
  row.className =
    'episode' + (isWatched ? ' watched' : '') + (isNext ? ' next-up' : '');
  row.style.setProperty('--show-color', SHOW_COLOR[ep.show] || 'var(--accent)');
  row.dataset.id = ep.id;

  const titleHtml = ep.sourceUrl
    ? `<a href="${ep.sourceUrl}" target="_blank" rel="noopener">${escapeHtml(ep.title)}</a>`
    : escapeHtml(ep.title);
  const nextPill = isNext ? '<span class="next-pill">NEXT</span>' : '';

  row.innerHTML = `
    <span class="e-num">${ep.id.toString().padStart(3, '0')}</span>
    <span class="e-show"><span class="dot"></span>${escapeHtml(ep.series)}</span>
    <span class="e-code">${escapeHtml(ep.code)}</span>
    <span class="e-title">${nextPill}${titleHtml}</span>
    <span class="e-date">${escapeHtml(ep.airDate)}</span>
    <span class="e-act">
      <button class="watch-btn" type="button" aria-pressed="${isWatched}">
        <span class="check"></span>
        ${isWatched ? 'Watched' : 'Mark'}
      </button>
    </span>
  `;
  return row;
}

function renderHistory() {
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  if (!list) return;

  const byId = new Map(state.data.episodes.map((ep) => [ep.id, ep]));
  const entries = [...state.history].reverse().slice(0, 100);
  list.innerHTML = '';

  if (entries.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'history-item';

    const when = new Date(entry.ts);
    const whenText = formatRelative(when);
    const whenAbs = when.toLocaleString();

    let label = '';
    let sub = '';
    if (entry.action === 'watched' || entry.action === 'unwatched') {
      const ep = byId.get(entry.id);
      const verb = entry.action === 'watched' ? 'Watched' : 'Unwatched';
      label = ep ? `${verb} ${escapeHtml(ep.series)} ${escapeHtml(ep.code)}` : `${verb} #${entry.id}`;
      sub = ep ? escapeHtml(ep.title) : '';
      li.style.setProperty('--show-color', ep ? SHOW_COLOR[ep.show] || 'var(--accent)' : 'var(--accent)');
    } else if (entry.action === 'bulk-replace') {
      label = `Replaced list (${entry.count || 0} watched)`;
    } else if (entry.action === 'reset') {
      label = 'Cleared all progress';
      li.classList.add('warn');
    } else {
      label = entry.action;
    }

    const device = entry.device ? ` &middot; ${escapeHtml(entry.device)}` : '';
    li.innerHTML = `
      <span class="h-time" title="${escapeHtml(whenAbs)}">${escapeHtml(whenText)}</span>
      <span class="h-body">
        <span class="h-label">${label}</span>
        ${sub ? `<span class="h-sub">${sub}</span>` : ''}
      </span>
      <span class="h-meta">${device}</span>
    `;
    frag.appendChild(li);
  }
  list.appendChild(frag);
}

function renderSync() {
  const el = document.getElementById('sync-status');
  if (!el) return;
  let text = '';
  let cls = 'sync-status';
  if (!state.online) {
    text = `Offline${state.pendingQueue.length ? ` (${state.pendingQueue.length} queued)` : ''}`;
    cls += ' offline';
  } else if (state.syncing) {
    text = 'Syncing...';
    cls += ' syncing';
  } else if (state.lastError) {
    text = `Sync error: ${state.lastError}`;
    cls += ' error';
  } else if (state.pendingQueue.length) {
    text = `${state.pendingQueue.length} pending`;
    cls += ' pending';
  } else {
    text = 'Synced';
    cls += ' ok';
  }
  el.className = cls;
  el.textContent = text;
}

function setSyncing(v) {
  state.syncing = v;
  renderSync();
}

function formatRelative(date) {
  const now = Date.now();
  const diff = Math.floor((now - date.getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- Interactions -----------------------------------------------

function toggleWatched(id, force) {
  const wantWatched = force === true || (force === undefined && !state.watched.has(id));
  if (wantWatched === state.watched.has(id)) return;

  if (wantWatched) state.watched.add(id);
  else state.watched.delete(id);

  // Optimistic local history so it appears instantly.
  state.history.push({
    ts: new Date().toISOString(),
    id,
    action: wantWatched ? 'watched' : 'unwatched',
    device: getDeviceName(),
    pending: true,
  });
  saveCache();

  animateRowToggle(id, wantWatched);
  renderStats();
  renderHistory();

  enqueue({ type: 'toggle', id, watched: wantWatched });
  flushQueue();
}

// Targeted update for a single row so we don't rebuild the whole list.
// Moves the NEXT pill to the new next-up episode, and smoothly collapses
// the row away when "Hide watched" is on.
function animateRowToggle(id, wantWatched) {
  const row = document.querySelector(`.episode[data-id="${id}"]`);
  if (!row) {
    renderList();
    return;
  }
  row.classList.toggle('watched', wantWatched);
  const btn = row.querySelector('.watch-btn');
  if (btn) {
    btn.setAttribute('aria-pressed', wantWatched ? 'true' : 'false');
    btn.innerHTML = `<span class="check"></span>${wantWatched ? 'Watched' : 'Mark'}`;
  }

  // Reposition the NEXT pill.
  const newNext = getNextEpisode();
  const lastNext = document.querySelector('.episode.next-up');
  if (lastNext && (!newNext || lastNext.dataset.id !== String(newNext.id))) {
    lastNext.classList.remove('next-up');
    const oldPill = lastNext.querySelector('.next-pill');
    if (oldPill) oldPill.remove();
  }
  if (newNext) {
    const nextRow = document.querySelector(`.episode[data-id="${newNext.id}"]`);
    if (nextRow && !nextRow.classList.contains('next-up')) {
      nextRow.classList.add('next-up');
      const title = nextRow.querySelector('.e-title');
      if (title && !title.querySelector('.next-pill')) {
        const pill = document.createElement('span');
        pill.className = 'next-pill';
        pill.textContent = 'NEXT';
        title.prepend(pill);
      }
    }
  }

  if (wantWatched && state.hideWatched) collapseRemove(row);
}

// Animate every currently-visible watched row out in a little stagger when
// the user flips "Hide watched" on. Feels much nicer than a snap re-render.
function vanishWatchedRows() {
  const rows = [...document.querySelectorAll('.episode.watched')];
  if (rows.length === 0) return;
  rows.forEach((row, i) => {
    setTimeout(() => collapseRemove(row), Math.min(i * 30, 240));
  });
}

function collapseRemove(el) {
  if (reducedMotion()) { el.remove(); return; }

  // Lock the current height so we can animate it to 0, and mark the row
  // as vanishing. CSS runs the slide+blur+fade animation, then an explicit
  // collapse animation once phase 1 finishes via `animationend`.
  const h = el.getBoundingClientRect().height;
  el.style.setProperty('--vanish-h', h + 'px');
  el.classList.add('vanishing');

  const onVanishEnd = (e) => {
    if (e.animationName !== 'row-vanish') return;
    el.removeEventListener('animationend', onVanishEnd);
    el.classList.add('collapsing');
  };
  const onCollapseEnd = (e) => {
    if (e.animationName !== 'row-collapse') return;
    el.removeEventListener('animationend', onCollapseEnd);
    if (el.isConnected) el.remove();
  };
  el.addEventListener('animationend', onVanishEnd);
  el.addEventListener('animationend', onCollapseEnd);

  // Safety net in case animationend doesn't fire (tab hidden, etc.)
  setTimeout(() => { if (el.isConnected) el.remove(); }, 900);
}

function markNextWatched() {
  const next = getNextEpisode();
  if (!next) return;
  toggleWatched(next.id, true);
}

// Smooth scroll to the current "next" episode and pulse it for a moment.
// If "hide watched" is on the NEXT is already the first visible row; either
// way we just find whichever row is marked .next-up in the DOM.
function jumpToNext() {
  const next = getNextEpisode();
  if (!next) {
    toastHint('All caught up!');
    return;
  }
  // Make sure the row is actually in the list right now (it could be
  // filtered out by search or show chips).
  let el = document.querySelector(`.episode[data-id="${next.id}"]`);
  if (!el) {
    const search = document.getElementById('search');
    if (search && search.value) {
      search.value = '';
      state.query = '';
      renderList();
      el = document.querySelector(`.episode[data-id="${next.id}"]`);
    }
  }
  if (!el) {
    toastHint('Next episode is filtered out.');
    return;
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('highlight');
  void el.offsetWidth; // reflow so the class re-applies
  el.classList.add('highlight');
  setTimeout(() => el.classList.remove('highlight'), 1800);
}

// Tiny ephemeral toast. Creates the element on demand.
function toastHint(msg) {
  let t = document.getElementById('toast-hint');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast-hint';
    t.className = 'toast-hint';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 1800);
}

function exportProgress() {
  const payload = {
    app: 'arrowverse-tracker',
    exportedAt: new Date().toISOString(),
    watched: [...state.watched].sort((a, b) => a - b),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `arrowverse-tracker-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importProgress(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || !Array.isArray(parsed.watched)) throw new Error('Invalid file');
      const ids = parsed.watched.filter((n) => Number.isInteger(n));
      state.watched = new Set(ids);
      saveCache();
      renderStats();
      renderList();
      enqueue({ type: 'replace', watched: ids });
      flushQueue();
    } catch (e) {
      alert('Could not import: ' + e.message);
    }
  };
  reader.readAsText(file);
}

function resetProgress() {
  confirmDialog({
    title: 'Reset progress',
    body:
      'This will clear every watched episode on the server (all devices) and cannot be undone. Continue?',
    okLabel: 'Reset everything',
  }).then((ok) => {
    if (!ok) return;
    state.watched.clear();
    saveCache();
    renderStats();
    renderList();
    enqueue({ type: 'reset' });
    flushQueue();
  });
}

// In-app confirmation dialog. Returns a promise that resolves true/false.
function confirmDialog({ title = 'Confirm', body = 'Are you sure?', okLabel = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('confirm-title');
    const bodyEl = document.getElementById('confirm-body');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    const closeBtn = document.getElementById('confirm-close');
    if (!modal) { resolve(window.confirm(body)); return; }

    titleEl.textContent = title;
    bodyEl.textContent = body;
    okBtn.textContent = okLabel;

    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => okBtn.focus());

    const cleanup = (result) => {
      modal.hidden = true;
      document.body.style.overflow = '';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => { if (e.target === modal) cleanup(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter' && document.activeElement !== cancelBtn) cleanup(true);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

// ---------- Wire up ----------------------------------------------------

function bindEvents() {
  document.getElementById('episode-list').addEventListener('click', (e) => {
    const row = e.target.closest('.episode');
    if (!row) return;
    if (e.target.closest('a')) return; // don't toggle when clicking external link
    const id = Number(row.dataset.id);
    toggleWatched(id);
  });

  const search = document.getElementById('search');
  search.addEventListener('input', () => {
    state.query = search.value.trim();
    renderList();
  });

  const hideWatched = document.getElementById('hide-watched');
  hideWatched.checked = state.hideWatched;
  hideWatched.addEventListener('change', () => {
    const wasOn = state.hideWatched;
    state.hideWatched = hideWatched.checked;
    savePrefs();
    if (!wasOn && state.hideWatched) {
      // Turning ON: animate every already-watched row out with a stagger.
      vanishWatchedRows();
    } else {
      renderList();
    }
  });

  const jumpBtn = document.getElementById('jump-next');
  if (jumpBtn) jumpBtn.addEventListener('click', jumpToNext);

  document.getElementById('mark-next').addEventListener('click', markNextWatched);
  document.getElementById('export-btn').addEventListener('click', exportProgress);
  document.getElementById('reset-btn').addEventListener('click', resetProgress);

  const importBtn = document.getElementById('import-btn');
  const importFile = document.getElementById('import-file');
  importBtn.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => {
    if (importFile.files && importFile.files[0]) {
      importProgress(importFile.files[0]);
      importFile.value = '';
    }
  });

  const historyToggle = document.getElementById('history-toggle');
  const historyPanel = document.getElementById('history-panel');
  if (historyToggle && historyPanel) {
    historyToggle.addEventListener('click', () => {
      const hidden = historyPanel.hasAttribute('hidden');
      if (hidden) {
        historyPanel.removeAttribute('hidden');
        historyToggle.setAttribute('aria-expanded', 'true');
        renderHistory();
      } else {
        historyPanel.setAttribute('hidden', '');
        historyToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  const syncBtn = document.getElementById('sync-btn');
  if (syncBtn) syncBtn.addEventListener('click', syncNow);

  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsClose = document.getElementById('settings-close');
  if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
  if (settingsClose) settingsClose.addEventListener('click', closeSettings);
  if (settingsModal) {
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) closeSettings();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsModal.hidden) closeSettings();
  });

  window.addEventListener('online', () => {
    state.online = true;
    renderSync();
    syncNow();
  });
  window.addEventListener('offline', () => {
    state.online = false;
    renderSync();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
  });
  window.addEventListener('focus', () => syncNow());

  // Light polling so other devices' changes show up within a few seconds.
  setInterval(() => {
    if (state.online && document.visibilityState === 'visible') pullFromServer();
  }, 15000);

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'n' || e.key === 'N') markNextWatched();
    if (e.key === '/') {
      e.preventDefault();
      search.focus();
    }
  });
}

// ---------- PWA wiring ------------------------------------------------

let deferredInstallPrompt = null;

function setupPWA() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    });
  }

  const installBtn = document.getElementById('install-btn');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    try {
      await deferredInstallPrompt.userChoice;
    } finally {
      deferredInstallPrompt = null;
      installBtn.hidden = true;
    }
  });
  window.addEventListener('appinstalled', () => {
    installBtn.hidden = true;
    deferredInstallPrompt = null;
  });
}

async function init() {
  loadPrefs();
  loadCache();
  loadQueue();

  try {
    await loadData();
  } catch (e) {
    document.getElementById('episode-list').innerHTML =
      `<p class="empty-state">Failed to load data. Run <code>node scripts/build-data.js</code> first.</p>`;
    console.error(e);
    return;
  }

  const generated = state.data.generatedAt
    ? new Date(state.data.generatedAt).toLocaleDateString()
    : '';
  document.getElementById('data-generated').textContent = generated
    ? `Data generated ${generated}`
    : '';

  bindEvents();
  setupPWA();
  renderAll();
  syncNow(); // hydrate from server
}

init();
