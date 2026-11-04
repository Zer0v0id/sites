'use strict';
const $ = (s) => document.querySelector(s);
const SHARED = 'giftSwap.shared.v1';
const MEKEY = 'giftSwap.me.v1';
const COUNTDOWN_MS = 2 * 60 * 1000;
const IDLE_MS = 24 * 60 * 60 * 1000;
const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('gift-swap-test') : null;

const load = () => { try { return JSON.parse(sessionStorage.getItem(MEKEY)) || null; } catch { return null; } };
const store = (v) => v ? sessionStorage.setItem(MEKEY, JSON.stringify(v)) : sessionStorage.removeItem(MEKEY);
let me = load();
let pollT, cdT;

function fresh() { return { slots: [{ status: 'free' }, { status: 'free' }] }; }
function loadShared() {
  try {
    const s = JSON.parse(localStorage.getItem(SHARED));
    if (s && Array.isArray(s.slots) && s.slots.length === 2) return s;
  } catch { /* ignore broken storage */ }
  return fresh();
}
function saveShared(state) {
  const next = JSON.stringify(state);
  if (localStorage.getItem(SHARED) === next) return false;
  localStorage.setItem(SHARED, next);
  if (bc) bc.postMessage({ type: 'update' });
  return true;
}
function sweep(state) {
  let changed = false;
  const t = Date.now();
  state.slots.forEach((s, i) => {
    if (s.status === 'joined' && t - s.joinedAt >= IDLE_MS) { state.slots[i] = { status: 'free' }; changed = true; }
    if (s.status === 'revealed' && t >= s.wipeAt) { state.slots[i] = { status: 'done', name: s.name }; changed = true; }
  });
  state.slots.forEach((s) => { if (s.status === 'free' && s.inbox) { delete s.inbox; changed = true; } });
  if (state.slots.every((s) => s.status === 'done') ||
      (state.slots.some((s) => s.status === 'done') && state.slots.every((s) => s.status === 'done' || s.status === 'free'))) {
    state.slots = fresh().slots; changed = true;
  }
  return changed;
}
function readState() {
  const state = loadShared();
  if (sweep(state)) saveShared(state);
  return state;
}
function randCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 100000).padStart(5, '0');
}
function unlock(state, code, hintSlot) {
  if (!/^\d{5}$/.test(String(code || ''))) return null;
  const order = hintSlot === 1 ? [1, 0] : [0, 1];
  for (const i of order) {
    const s = state.slots[i];
    if (!s.code || s.burned) continue;
    if (s.code === String(code)) return i;
  }
  return null;
}
function cleanIdeas(arr) {
  if (!Array.isArray(arr) || arr.length !== 4) return { err: 'Exactly four gift ideas are required.' };
  const ideas = arr.map((x) => String(x ?? '').trim().replace(/\s+/g, ' '));
  if (ideas.some((x) => !x)) return { err: 'All four gift ideas must be filled in.' };
  if (ideas.some((x) => x.length > 120)) return { err: 'Keep each idea under 120 characters.' };
  if (new Set(ideas.map((x) => x.toLowerCase())).size !== 4) return { err: 'Each gift idea must be unique — no duplicates.' };
  return { ideas };
}
function deliver(state, i) {
  const mine = state.slots[i];
  const other = state.slots[1 - i];
  if (!mine.ideas || !other.gen) return false;
  if (other.inbox && other.inbox.gen === other.gen && other.inbox.from === mine.gen) return false;
  other.inbox = { gen: other.gen, from: mine.gen, ideas: mine.ideas.slice() };
  return true;
}
function view(state, i) {
  const mine = state.slots[i], other = state.slots[1 - i];
  const otherSubmitted = ['submitted', 'revealed', 'done'].includes(other.status);
  let st;
  if (mine.status === 'revealed') st = 'revealed';
  else if (mine.status !== 'submitted') st = 'needIdeas';
  else if (mine.inbox && mine.inbox.gen === mine.gen) st = 'ready';
  else st = 'waiting';
  return { slot: i, name: mine.name, state: st, otherName: other.name || null, otherJoined: !!other.name, otherSubmitted, wipeAt: mine.wipeAt || null };
}
function fail(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}
function api(path, body) {
  body = body || {};
  if (path === 'status') {
    const state = readState();
    return Promise.resolve({ slots: state.slots.map((s) => ({
      taken: s.status !== 'free', name: s.name || null,
      submitted: ['submitted', 'revealed', 'done'].includes(s.status),
      opened: s.status === 'revealed' || s.status === 'done',
    })) });
  }
  const state = loadShared();
  sweep(state);
  if (path === 'join') {
    const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    if (!name) return Promise.reject(fail('Please enter your name.', 400));
    const i = state.slots.findIndex((s) => s.status === 'free');
    if (i < 0) { saveShared(state); return Promise.reject(fail('Both slots are taken right now.', 409)); }
    let code;
    do { code = randCode(); } while (state.slots.some((s) => s.code === code));
    state.slots[i] = { status: 'joined', name, code, joinedAt: Date.now(), gen: crypto.randomUUID() };
    saveShared(state);
    return Promise.resolve({ slot: i, code, name });
  }
  const i = unlock(state, body.code, body.slot);
  if (i == null) { saveShared(state); return Promise.reject(fail("That code didn't work.", 401)); }
  const s = state.slots[i];
  if (path === 'submit') {
    if (s.status !== 'joined') { saveShared(state); return Promise.reject(fail('Your ideas are already locked in.', 409)); }
    if (!state.slots[1 - i].name) { saveShared(state); return Promise.reject(fail('Waiting for the other player to join first.', 409)); }
    const c = cleanIdeas(body.ideas);
    if (c.err) { saveShared(state); return Promise.reject(fail(c.err, 400)); }
    s.ideas = c.ideas;
    s.status = 'submitted';
    s.submittedAt = Date.now();
    deliver(state, i);
    saveShared(state);
    return Promise.resolve(view(state, i));
  }
  if (path === 'check') {
    if (s.ideas && s.status === 'submitted') deliver(state, i);
    const other = state.slots[1 - i];
    if (other.ideas && other.status === 'submitted') deliver(state, 1 - i);
    saveShared(state);
    return Promise.resolve(view(state, i));
  }
  if (path === 'reveal') {
    const v = view(state, i);
    if (v.state !== 'ready') { saveShared(state); return Promise.reject(fail('Not ready to open yet.', 409)); }
    const all = s.ideas.concat(s.inbox.ideas);
    for (let j = all.length - 1; j > 0; j--) {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      const r = buf[0] % (j + 1);
      [all[j], all[r]] = [all[r], all[j]];
    }
    const picked = all.slice(0, 4);
    const wipeAt = Date.now() + COUNTDOWN_MS;
    const serverNow = Date.now();
    state.slots[i] = { status: 'revealed', name: s.name, burned: true, wipeAt, submittedAt: s.submittedAt, gen: s.gen };
    saveShared(state);
    return Promise.resolve({ ...view(state, i), ideas: picked, wipeAt, serverNow });
  }
  return Promise.reject(fail('Something went wrong', 500));
}

// snow
(function snow() {
  const box = $('#snow'), n = window.innerWidth < 600 ? 18 : 32;
  for (let i = 0; i < n; i++) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const size = 12 + Math.random() * 26;
    s.setAttribute('viewBox', '-50 -50 100 100'); s.setAttribute('width', size); s.setAttribute('height', size);
    s.innerHTML = '<use href="#flake"/>';
    s.style.left = Math.random() * 100 + 'vw';
    s.style.animationDuration = 7 + Math.random() * 10 + 's';
    s.style.animationDelay = -Math.random() * 15 + 's';
    box.appendChild(s);
  }
})();

const err = (m) => { $('#err').textContent = m || ''; };
function show(id) {
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== id));
  clearTimeout(pollT);
}
const bounce = (el) => { el.classList.remove('bounce'); void el.offsetWidth; el.classList.add('bounce'); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function gameStillHasMe() {
  if (!me) return false;
  const slot = readState().slots[me.slot];
  if (!slot) return false;
  if (me.revealed) return (slot.status === 'revealed' || slot.status === 'done') && slot.name === me.name;
  return slot.code === me.code && !slot.burned;
}

async function home() {
  show('v-home');
  const st = await api('status');
  $('#slots').innerHTML = st.slots.map((s, i) => `<li>${s.taken ? esc(s.name) : `<span class="muted">Player ${i + 1} — open</span>`}
     ${s.submitted ? ' <span class="check" title="Ideas entered">✓</span>' : ''}</li>`).join('');
  const full = st.slots.every((s) => s.taken);
  $('#joinForm').hidden = full; $('#fullMsg').hidden = !full;
}

async function route() {
  err('');
  me = load();
  if (me && me.revealed) {
    if (!gameStillHasMe()) { store(null); me = null; return home(); }
    if (Date.now() < me.wipeAt) {
      if ($('#v-reveal').hidden) showReveal(me.revealed, me.wipeAt, false);
      return;
    }
    store(null); me = null; return show('v-done');
  }
  if (!me || !me.code) return home();
  if (!gameStillHasMe()) { store(null); me = null; err('This tab\'s saved spot expired. Join again or use your code.'); return home(); }
  try {
    const v = await api('check', { code: me.code, slot: me.slot });
    render(v);
  } catch (e) {
    if (e.status === 401) { store(null); me = null; err('This tab\'s saved spot expired. Join again or use your code.'); return home(); }
    err(e.message); home();
  }
}

function render(v) {
  me.slot = v.slot; me.name = v.name; store(me);
  document.querySelectorAll('.me').forEach((e) => (e.textContent = v.name));
  if (v.state === 'needIdeas') {
    show('v-ideas');
    $('#waitJoin').hidden = v.otherJoined; $('#submitIdeas').disabled = !v.otherJoined;
    if (!v.otherJoined) pollT = setTimeout(route, 5000);
  } else if (v.state === 'waiting') {
    show('v-wait');
    $('#myCode').textContent = me.code;
    $('.other').textContent = v.otherName ? v.otherName + ':' : 'Other player:';
    $('#otherCheck').innerHTML = v.otherSubmitted ? '<span class="check">✓</span> ideas entered' : 'not entered yet';
    pollT = setTimeout(route, 8000);
  } else if (v.state === 'ready') {
    show('v-gift');
    $('.codeSmall').textContent = me.code;
    $('#giftBtn').classList.toggle('green-gift', v.slot === 1);
  }
}

function showReveal(ideas, wipeAt, animate) {
  show('v-reveal');
  const ol = $('#revealList'); ol.innerHTML = '';
  ideas.forEach((idea, i) => {
    setTimeout(() => {
      const li = document.createElement('li'); li.textContent = idea;
      if (!animate) li.style.animation = 'none';
      ol.appendChild(li);
      if (animate) for (let k = 0; k < 10; k++) {
        const s = document.createElement('i'); s.className = 'spark';
        s.style.left = '50%'; s.style.top = '50%';
        s.style.setProperty('--dx', (Math.random() * 160 - 80) + 'px'); s.style.setProperty('--dy', (Math.random() * 80 - 40) + 'px');
        li.appendChild(s); setTimeout(() => s.remove(), 1000);
      }
    }, animate ? 600 + i * 1100 : 0);
  });
  setTimeout(() => {
    $('#cdBox').hidden = false;
    const tick = () => {
      const ms = wipeAt - Date.now();
      if (ms <= 0) { clearInterval(cdT); store(null); return show('v-done'); }
      const s = Math.ceil(ms / 1000); $('#cd').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    clearInterval(cdT); tick(); cdT = setInterval(tick, 250);
  }, animate ? 600 + ideas.length * 1100 : 0);
}

$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault(); err('');
  try {
    const r = await api('join', { name: $('#name').value });
    me = { slot: r.slot, code: r.code, name: r.name }; store(me);
    route();
  } catch (x) { err(x.message); home(); }
});
$('#codeForm').addEventListener('submit', async (e) => {
  e.preventDefault(); err('');
  try {
    const code = $('#codeIn').value.trim();
    const v = await api('check', { code });
    me = { code, slot: v.slot, name: v.name }; render(v);
  } catch (x) { err(x.message); }
});
$('#ideasForm').addEventListener('submit', async (e) => {
  e.preventDefault(); err('');
  const ideas = [...document.querySelectorAll('.idea')].map((i) => i.value.trim());
  if (ideas.some((x) => !x)) return err('Fill in all four ideas.');
  if (new Set(ideas.map((x) => x.toLowerCase())).size !== 4) return err('Each idea must be different.');
  const btn = $('#submitIdeas'); btn.disabled = true;
  try {
    const v = await api('submit', { code: me.code, slot: me.slot, ideas });
    bounce($('#v-ideas'));
    setTimeout(() => { render(v); bounce($('#v-wait').hidden ? $('#v-gift') : $('#v-wait')); }, 700);
  } catch (x) { err(x.message); btn.disabled = false; if (x.status === 409) route(); }
});
$('#recheck').addEventListener('click', () => { bounce($('#v-wait')); route(); });
$('#giftBtn').addEventListener('click', async () => {
  const b = $('#giftBtn'); if (b.classList.contains('opening')) return;
  err(''); b.classList.add('opening');
  try {
    const r = await api('reveal', { code: me.code, slot: me.slot });
    const wipeAt = Date.now() + (r.wipeAt - r.serverNow);
    store({ revealed: r.ideas, wipeAt, name: me.name, slot: me.slot });
    setTimeout(() => showReveal(r.ideas, wipeAt, true), 900);
  } catch (x) { b.classList.remove('opening'); err(x.message); }
});
$('#resetBtn').addEventListener('click', () => {
  if (!confirm('Clear both players and start over?')) return;
  localStorage.removeItem(SHARED);
  store(null); me = null;
  clearInterval(cdT); clearTimeout(pollT);
  if (bc) bc.postMessage({ type: 'reset' });
  home();
});
if (bc) bc.onmessage = (ev) => {
  if (ev.data && ev.data.type === 'reset') {
    store(null); me = null; clearInterval(cdT); clearTimeout(pollT); home();
    return;
  }
  route();
};
window.addEventListener('storage', (e) => { if (e.key === SHARED) route(); });
route();
