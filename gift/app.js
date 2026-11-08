'use strict';
const $ = (s) => document.querySelector(s);
const SHARED = 'giftSwap.shared.v1';
const MEKEY = 'giftSwap.me.v1';
const ROOMKEY = 'giftSwap.room.v1';
const COUNTDOWN_MS = 2 * 60 * 1000;
const IDLE_MS = 24 * 60 * 60 * 1000;

function randomHex(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function bootRoom() {
  const fromHash = (location.hash || '').replace(/^#/, '');
  let secret = /^[0-9a-f]{32}$/.test(fromHash) ? fromHash : localStorage.getItem(ROOMKEY);
  if (!secret || !/^[0-9a-f]{32}$/.test(secret)) secret = randomHex(16);
  localStorage.setItem(ROOMKEY, secret);
  if (location.hash !== '#' + secret) history.replaceState(null, '', '#' + secret);
  return secret;
}
const secret = bootRoom();
const storageKey = () => SHARED + '.' + secret;
const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('gift-swap-' + secret) : null;

const load = () => { try { return JSON.parse(sessionStorage.getItem(MEKEY)) || null; } catch { return null; } };
const store = (v) => v ? sessionStorage.setItem(MEKEY, JSON.stringify(v)) : sessionStorage.removeItem(MEKEY);
let me = load();
let pollT, cdT;
let netReady = false;
let lastSent = '';

function fresh(epoch) { return { epoch: epoch || 0, slots: [{ status: 'free' }, { status: 'free' }] }; }
function rank(status) { return { free: 0, joined: 1, submitted: 2, revealed: 3, done: 4 }[status] || 0; }
function normalizeSlot(s) {
  s = s || {};
  if (s.status === 'done') return { status: 'done', name: s.name || '', gen: s.gen || '', joinedAt: s.joinedAt || 0 };
  if (!s.gen || s.status === 'free') return { status: 'free' };
  const o = { status: s.status, name: s.name, gen: s.gen, joinedAt: s.joinedAt || 0 };
  if (s.code) o.code = s.code;
  if (s.submittedAt) o.submittedAt = s.submittedAt;
  if (s.ideas) o.ideas = s.ideas.slice();
  if (s.inbox && s.inbox.ideas) o.inbox = { gen: s.inbox.gen, from: s.inbox.from, ideas: s.inbox.ideas.slice() };
  if (s.burned) o.burned = true;
  if (s.wipeAt) o.wipeAt = s.wipeAt;
  return o;
}
function pack(state) {
  return {
    epoch: (state && state.epoch) || 0,
    slots: [0, 1].map((i) => normalizeSlot(state && state.slots && state.slots[i])),
  };
}
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = stable(v[k]);
    return o;
  }
  return v;
}
function encode(state) { return JSON.stringify(stable(pack(state))); }
function preferSame(a, b) {
  const ra = rank(a.status), rb = rank(b.status);
  const win = ra > rb ? a : rb > ra ? b : ((a.wipeAt || a.submittedAt || a.joinedAt || 0) >= (b.wipeAt || b.submittedAt || b.joinedAt || 0) ? a : b);
  const lose = win === a ? b : a;
  const out = { ...win };
  if (!out.joinedAt && lose.joinedAt) out.joinedAt = lose.joinedAt;
  if (win.status === 'revealed' || win.status === 'done') return out;
  if (!out.ideas && lose.ideas) out.ideas = lose.ideas.slice();
  if (!out.code && lose.code) out.code = lose.code;
  if (!out.inbox && lose.inbox) out.inbox = { gen: lose.inbox.gen, from: lose.inbox.from, ideas: lose.inbox.ideas.slice() };
  return out;
}
function merge(local, remote) {
  local = pack(local);
  remote = pack(remote);
  if (remote.epoch !== local.epoch) return remote.epoch > local.epoch ? remote : local;
  const byGen = new Map();
  function take(s) {
    if (!s || !s.gen || s.status === 'free') return;
    const prev = byGen.get(s.gen);
    byGen.set(s.gen, prev ? preferSame(prev, s) : s);
  }
  local.slots.forEach(take);
  remote.slots.forEach(take);
  const slots = [{ status: 'free' }, { status: 'free' }];
  [...byGen.values()].sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0) || (a.gen < b.gen ? -1 : 1))
    .forEach((s) => {
      const i = slots[0].gen ? 1 : 0;
      if (!slots[i].gen) slots[i] = s;
    });
  return pack({ epoch: local.epoch, slots });
}
function loadShared() {
  try {
    const s = JSON.parse(localStorage.getItem(storageKey()));
    if (s && Array.isArray(s.slots)) return pack(s);
  } catch { /* ignore broken storage */ }
  return fresh(0);
}
function worthPublishing(state) {
  state = pack(state);
  return state.epoch > 0 || state.slots.some((s) => s.status !== 'free');
}
function publishLatest() {
  if (!netReady) return;
  const raw = localStorage.getItem(storageKey());
  if (!raw || raw === lastSent) return;
  let state;
  try { state = JSON.parse(raw); } catch { return; }
  if (!worthPublishing(state)) return;
  if (!sendState(raw)) return;
  lastSent = raw;
}
function saveShared(state) {
  const next = encode(state);
  if (localStorage.getItem(storageKey()) === next) return false;
  localStorage.setItem(storageKey(), next);
  if (bc) bc.postMessage({ type: 'update' });
  publishLatest();
  return true;
}
function applyRemote(remote) {
  const merged = merge(loadShared(), remote);
  const next = encode(merged);
  const remoteEnc = encode(remote);
  const changed = localStorage.getItem(storageKey()) !== next;
  if (changed) localStorage.setItem(storageKey(), next);
  if (next !== remoteEnc) { lastSent = ''; publishLatest(); }
  else lastSent = next;
  if (changed) route();
}
function sweep(state) {
  let changed = false;
  const t = Date.now();
  state.slots.forEach((s, i) => {
    if (s.status === 'joined' && t - s.joinedAt >= IDLE_MS) { state.slots[i] = { status: 'free' }; changed = true; }
    if (s.status === 'revealed' && t >= s.wipeAt) { state.slots[i] = { status: 'done', name: s.name, gen: s.gen, joinedAt: s.joinedAt || 0 }; changed = true; }
  });
  state.slots.forEach((s) => { if (s.status === 'free' && s.inbox) { delete s.inbox; changed = true; } });
  if (state.slots.every((s) => s.status === 'done') ||
      (state.slots.some((s) => s.status === 'done') && state.slots.every((s) => s.status === 'done' || s.status === 'free'))) {
    state.slots = fresh(state.epoch).slots; changed = true;
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
    return Promise.resolve({ slot: i, code, name, gen: state.slots[i].gen });
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
    state.slots[i] = { status: 'revealed', name: s.name, burned: true, wipeAt, submittedAt: s.submittedAt, gen: s.gen, joinedAt: s.joinedAt || 0 };
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
  if (id !== 'v-reveal') clearInterval(cdT);
}
const bounce = (el) => { el.classList.remove('bounce'); void el.offsetWidth; el.classList.add('bounce'); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function gameStillHasMe() {
  if (!me) return false;
  const slots = readState().slots;
  let i = -1;
  if (me.gen) i = slots.findIndex((s) => s.gen === me.gen);
  if (i < 0 && me.code) i = slots.findIndex((s) => s.code === me.code && !s.burned);
  if (i < 0 && me.revealed) i = slots.findIndex((s) => (s.status === 'revealed' || s.status === 'done') && s.name === me.name);
  if (i < 0) return false;
  const slot = slots[i];
  if (me.revealed && !((slot.status === 'revealed' || slot.status === 'done') && slot.name === me.name)) return false;
  if (!me.revealed && (slot.code !== me.code || slot.burned)) return false;
  if (me.slot !== i) { me.slot = i; store(me); }
  return true;
}

async function home() {
  show('v-home');
  const st = await api('status');
  $('#slots').innerHTML = st.slots.map((s, i) => `<li>${s.taken ? esc(s.name) : `<span class="muted">Player ${i + 1} — open</span>`}
     ${s.submitted ? ' <span class="check" title="Ideas entered">✓</span>' : ''}</li>`).join('');
  const full = st.slots.every((s) => s.taken);
  $('#joinForm').hidden = full; $('#fullMsg').hidden = !full;
  pollT = setTimeout(route, 4000);
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
    pollT = setTimeout(route, 4000);
  } else if (v.state === 'waiting') {
    show('v-wait');
    $('#myCode').textContent = me.code;
    $('.other').textContent = v.otherName ? v.otherName + ':' : 'Other player:';
    $('#otherCheck').innerHTML = v.otherSubmitted ? '<span class="check">✓</span> ideas entered' : 'not entered yet';
    pollT = setTimeout(route, 4000);
  } else if (v.state === 'ready') {
    show('v-gift');
    $('.codeSmall').textContent = me.code;
    $('#giftBtn').classList.toggle('green-gift', v.slot === 1);
    pollT = setTimeout(route, 4000);
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
    me = { slot: r.slot, code: r.code, name: r.name, gen: r.gen }; store(me);
    route();
  } catch (x) { err(x.message); home(); }
});
$('#codeForm').addEventListener('submit', async (e) => {
  e.preventDefault(); err('');
  try {
    const code = $('#codeIn').value.trim();
    const v = await api('check', { code });
    me = { code, slot: v.slot, name: v.name, gen: readState().slots[v.slot].gen }; render(v);
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
async function openGift() {
  const b = $('#giftBtn'); if (b.classList.contains('opening')) return;
  err(''); b.classList.add('opening');
  try {
    const r = await api('reveal', { code: me.code, slot: me.slot });
    const wipeAt = Date.now() + (r.wipeAt - r.serverNow);
    store({ revealed: r.ideas, wipeAt, name: me.name, slot: me.slot, gen: me.gen });
    setTimeout(() => showReveal(r.ideas, wipeAt, true), 900);
  } catch (x) { b.classList.remove('opening'); err(x.message); }
}
$('#giftBtn').addEventListener('pointerdown', (e) => {
  if (e.button) return;
  e.preventDefault();
  openGift();
});
$('#giftBtn').addEventListener('click', openGift);
$('#resetBtn').addEventListener('click', () => {
  if (!confirm('Clear both players and start over?')) return;
  saveShared(fresh(Date.now()));
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
window.addEventListener('storage', (e) => { if (e.key === storageKey()) route(); });

function setNet(text) { const n = $('#netStatus'); if (n) n.textContent = text || ''; }
function inviteLink() { return location.origin + location.pathname + location.search + '#' + secret; }
$('#shareUrl').value = inviteLink();
$('#copyLink').addEventListener('click', async () => {
  const url = inviteLink();
  $('#shareUrl').value = url;
  try { await navigator.clipboard.writeText(url); }
  catch {
    $('#shareUrl').focus();
    $('#shareUrl').select();
    document.execCommand('copy');
  }
  const b = $('#copyLink');
  b.textContent = 'Copied';
  setTimeout(() => { b.textContent = 'Copy link'; }, 1500);
});

let socketSend = () => false;
let sendGen = 0;
function sendState(text) { return socketSend(text); }

function startNet() {
  if (!crypto.subtle) {
    setNet('Other phones can connect only from the https link. This page still works in two tabs.');
    netReady = true;
    return;
  }
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let ws, ping, attempt = 0, stopped = false, alive = false;
  let topic = '';
  let aes;
  function rem(n) {
    const out = [];
    do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n);
    return out;
  }
  function bytesOf(s) { return enc.encode(s); }
  function withStr(s) { const b = bytesOf(s); return [b.length >> 8, b.length & 255, ...b]; }
  function packet(head, body) { return new Uint8Array([head, ...rem(body.length), ...body]); }
  async function setup() {
    const topicHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('gift-swap-topic:' + secret)));
    topic = 'gs/' + [...topicHash.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const keyRaw = await crypto.subtle.digest('SHA-256', enc.encode('gift-swap-v1:' + secret));
    aes = await crypto.subtle.importKey('raw', keyRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async function encrypt(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(text)));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv, 0); out.set(ct, iv.length);
    return out;
  }
  async function decrypt(bytes) {
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aes, ct);
    return dec.decode(plain);
  }
  function handle(buf) {
    const u = new Uint8Array(buf);
    let i = 1, mult = 1, size = 0, b;
    do { b = u[i++]; size += (b & 127) * mult; mult *= 128; } while (b & 128);
    const type = u[0] >> 4;
    const rest = u.subarray(i, i + size);
    if (type === 2) {
      ws.send(packet(0x82, [0, 1, ...withStr(topic), 0]));
      return;
    }
    if (type === 9) {
      alive = true;
      netReady = true;
      setNet('Live. The other phone updates when it has this link open.');
      // Give a retained game a moment to arrive before we publish ours.
      setTimeout(publishLatest, 500);
      return;
    }
    if (type !== 3) return;
    const tlen = (rest[0] << 8) | rest[1];
    let off = 2 + tlen;
    if (((u[0] & 6) >> 1) > 0) off += 2;
    const payload = rest.subarray(off);
    decrypt(payload).then((text) => {
      let remote;
      try { remote = JSON.parse(text); } catch { return; }
      if (!remote || !Array.isArray(remote.slots)) return;
      applyRemote(remote);
    }).catch(() => {});
  }
  function connect() {
    if (stopped) return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    alive = false;
    netReady = false;
    setNet(attempt ? 'Reconnecting so the other phone can catch up…' : 'Connecting so the other phone can join…');
    let sock;
    try { sock = new WebSocket('wss://broker.hivemq.com:8884/mqtt', ['mqtt']); }
    catch { schedule(); return; }
    ws = sock;
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => {
      if (ws !== sock) return;
      attempt = 0;
      const id = bytesOf('g' + randomHex(6));
      const body = [...withStr('MQTT'), 4, 0x02, 0, 45, id.length >> 8, id.length & 255, ...id];
      sock.send(packet(0x10, body));
    };
    sock.onmessage = (ev) => { if (ws === sock) handle(ev.data); };
    sock.onerror = () => {};
    sock.onclose = () => {
      if (ws !== sock) return;
      alive = false;
      netReady = false;
      clearInterval(ping);
      if (!stopped) schedule();
    };
    clearInterval(ping);
    ping = setInterval(() => { if (ws && ws.readyState === 1) ws.send(new Uint8Array([0xc0, 0])); }, 20000);
  }
  function schedule() {
    const wait = Math.min(15000, 1000 * 2 ** attempt++);
    setTimeout(connect, wait);
  }
  socketSend = (text) => {
    if (!alive || !ws || ws.readyState !== 1) return false;
    const gen = ++sendGen;
    const sock = ws;
    encrypt(text).then((bytes) => {
      if (gen !== sendGen || ws !== sock || sock.readyState !== 1) return;
      sock.send(packet(0x31, [...withStr(topic), ...bytes]));
    }).catch(() => {});
    return true;
  };
  setup().then(connect).catch(() => setNet('Could not start the phone link. Two tabs on this device still work.'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!ws || ws.readyState > 1) { attempt = 0; connect(); }
    route();
  });
}
startNet();
route();
