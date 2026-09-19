'use strict';
/* Календарик: клиент без сборки. Все данные живут на сервере Render, здесь только интерфейс. */

/* ============ утилиты ============ */
const $ = (s, e = document) => e.querySelector(s);
const $$ = (s, e = document) => [...e.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dkey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toLocalInput = (d) => `${dkey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtT = (d) => new Date(d).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtD = (d) => new Date(d).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtDT = (d) => new Date(d).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const plural = (n, a, b, c) => { const m = n % 100, d = n % 10; return `${n} ${m > 10 && m < 20 ? c : d === 1 ? a : d > 1 && d < 5 ? b : c}`; };
const PALETTE = ['#c8ff2e', '#ff2d87', '#2f7bff', '#ff8a1f', '#a35bff', '#00e0c6'];
const colorOf = (id) => PALETTE[id % PALETTE.length];
const REMINDS = [[5, '5 мин'], [10, '10 мин'], [30, '30 мин'], [60, '1 час'], [180, '3 часа'], [1440, '1 день'], [2880, '2 дня']];
const REMIND_LABEL = Object.fromEntries(REMINDS);
const vibe = (p = [30, 40, 60]) => { try { navigator.vibrate && navigator.vibrate(p); } catch { /* нет вибрации */ } };

const S = { user: null, groups: [], events: [], ev: {}, notifs: [], unread: 0, month: startOfMonth(new Date()), sel: new Date(), rt: 0, cf: null, nfcAbort: null };
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
const stale = (tok) => tok !== S.rt;

/* ============ иконки ============ */
const ICONS = {
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="4"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17.5" cy="9" r="2.6"/><path d="M17 14.3c2.3.2 4 1.6 4.5 4.2"/>',
  bell: '<path d="M6 16.5V11a6 6 0 1112 0v5.5l1.5 2h-15z"/><path d="M10 21h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.4 4-6.5 8-6.5s7.2 2.1 8 6.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chevL: '<path d="M15 5l-7 7 7 7"/>',
  chevR: '<path d="M9 5l7 7-7 7"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16v4z"/>',
  camera: '<path d="M4 8h3l1.6-2.4h6.8L17 8h3v11H4z"/><circle cx="12" cy="13.5" r="3.6"/>',
  nfc: '<path d="M6 8.5a6.5 6.5 0 010 7"/><path d="M10 6a10.5 10.5 0 010 12"/><path d="M14 3.5a14.5 14.5 0 010 17"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0113 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  flame: '<path d="M12 2.8c.7 3.6 5.2 5.6 5.2 10.6a5.2 5.2 0 01-10.4 0c0-2.1 1-3.4 2.1-4.6.2 1.4.9 2.2 1.8 2.5C10.2 8.9 10.6 5.7 12 2.8z"/>',
  shield: '<path d="M12 3l7.5 3v5.6c0 4.4-3 7.6-7.5 9.4-4.5-1.8-7.5-5-7.5-9.4V6L12 3z"/>',
  logout: '<path d="M9 4H5v16h4M15 8l4 4-4 4M19 12H9"/>',
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z" fill="currentColor"/>',
};
const ico = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;

/* ============ огонёк ============ */
const TIERS = [
  { o: ['#3b4256', '#8891a8'], m: ['#4b526a', '#a5adc4'] },   // 0: остыл
  { o: ['#ff2d55', '#ff8a1f'], m: ['#ff8a1f', '#ffd23f'] },   // 1+: тёплый
  { o: ['#ff1f8e', '#ff6a00'], m: ['#ff6a00', '#ffe14d'] },   // 7+: жаркий
  { o: ['#2f4bff', '#00d5ff'], m: ['#00d5ff', '#b6fbff'] },   // 30+: синий
  { o: ['#7a2bff', '#ff2bd6'], m: ['#ff2bd6', '#ffd0f7'] },   // 100+: фиолетовый
];
function initDefs() {
  const lg = (id, a, b) => `<linearGradient id="${id}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
  $('#defs').innerHTML = '<defs>' +
    TIERS.map((t, i) => lg('go' + i, ...t.o) + lg('gm' + i, ...t.m)).join('') +
    lg('gc', '#fff3b0', '#ffffff') +
    '<linearGradient id="gs" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".45" stop-color="#9fd8ff"/><stop offset="1" stop-color="#2f7bff"/></linearGradient>' +
    '</defs>';
}
const tierOf = (n) => (n >= 100 ? 4 : n >= 30 ? 3 : n >= 7 ? 2 : n >= 1 ? 1 : 0);
const SPARKS = [[38, 96, 2.2, -10, 2.6, 0], [58, 92, 1.8, 12, 2.2, .6], [48, 100, 2.6, -4, 3, 1.2], [66, 98, 1.6, 16, 2.4, 1.8], [32, 90, 1.5, -14, 2.8, .9], [52, 94, 2, 6, 2, 2.1]];
function flame(n, { size = 96, burst = false, num = true } = {}) {
  const t = tierOf(n);
  return `<div class="flame t${t}${burst ? ' burst' : ''}" style="--sz:${size}px" role="img" aria-label="Огонёк: ${n}">
    <svg viewBox="0 0 100 130" aria-hidden="true">
      <g class="fl-o"><path fill="url(#go${t})" d="M50 4C58 26 84 42 84 78C84 105 68 124 50 124C32 124 16 105 16 78C16 60 26 50 32 38C34 48 40 54 44 52C40 34 42 18 50 4Z"/></g>
      <g class="fl-m"><path fill="url(#gm${t})" d="M50 44C55 58 70 66 70 88C70 106 61 118 50 118C39 118 30 106 30 88C30 74 38 68 42 58C44 64 47 66 49 65C47 56 47 50 50 44Z"/></g>
      <g class="fl-c"><path fill="url(#gc)" d="M50 76C54 84 62 88 62 100C62 111 56 118 50 118C44 118 38 111 38 100C38 92 44 88 46 82C47 85 49 86 50 85C49 81 49 79 50 76Z"/></g>
      ${SPARKS.map(([x, y, r, dx, dur, del]) => `<circle class="sp" cx="${x}" cy="${y}" r="${r}" style="--dx:${dx}px;--dur:${dur}s;--del:${del}s"/>`).join('')}
    </svg>${num ? `<b class="fl-n">${n}</b>` : ''}</div>`;
}
function shield(on, z = 30) {
  return `<span class="shield ${on ? 'on' : 'off'}" style="--z:${z}px" title="${on ? 'Резист доступен' : 'Резист потрачен'}">
    <svg viewBox="0 0 24 28" aria-hidden="true"><path d="M12 1l9 3.5v8.2c0 6-4 10.4-9 13.3C7 23.1 3 18.7 3 12.7V4.5L12 1z" fill="url(#gs)" stroke="rgba(255,255,255,.75)" stroke-width="1"/>
    <path d="M12 6v15M7 10.5l5 3 5-3" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1.2" stroke-linecap="round"/>${on ? '' : '<path d="M9 5l3 6-3 4 3 8" fill="none" stroke="rgba(0,0,0,.6)" stroke-width="1.2"/>'}</svg></span>`;
}
function avatar(u, size = 44) {
  const init = esc((u.nickname || u.username || '?').trim().slice(0, 1).toUpperCase());
  const h = [...(u.username || 'x')].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const inner = u.avatarV > 0 ? `<img src="/api/users/${u.id}/avatar?v=${u.avatarV}" alt="" loading="lazy" decoding="async">` : `<b>${init}</b>`;
  return `<span class="av" style="--s:${size}px;--h:${h}">${inner}</span>`;
}
function avStack(members, max = 4) {
  const shown = members.slice(0, max);
  const extra = members.length - shown.length;
  return `<span class="avs">${shown.map((m) => avatar(m, 34)).join('')}${extra > 0 ? `<span class="av more">+${extra}</span>` : ''}</span>`;
}
function countUp(el, from, to, ms = 900) {
  if (!el) return;
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / ms);
    el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ============ сеть ============ */
async function api(method, url, body) {
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof Blob) { opt.body = body; opt.headers['Content-Type'] = body.type; }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  let r;
  try { r = await fetch(url, opt); }
  catch { throw new Error('Нет связи с сервером. Если он спал, подождите несколько секунд и повторите'); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && S.user) { S.user = null; showAuth(); }
  if (!r.ok) throw Object.assign(new Error(j.error || `Ошибка ${r.status}`), { status: r.status });
  return j;
}
const loadGroups = async () => { S.groups = (await api('GET', '/api/groups')).groups; };
const indexEvents = (list) => list.forEach((e) => { S.ev[e.id] = e; });
async function loadNotifs() {
  const r = await api('GET', '/api/notifications');
  S.notifs = r.notifications; S.unread = r.unread; updateBadge();
}
function updateBadge() {
  const b = $('#badge'); if (!b) return;
  b.hidden = !S.unread; b.textContent = S.unread > 9 ? '9+' : S.unread;
}

/* ============ листы, тосты, подтверждения ============ */
function sheet(html, cls = '') {
  $$('#layer .overlay').forEach((x) => x.remove());
  const el = document.createElement('div');
  el.className = 'overlay';
  el.innerHTML = `<div class="scrim" data-act="close"></div><section class="sheet glass ${cls}" role="dialog" aria-modal="true"><i class="grab"></i>${html}</section>`;
  $('#layer').appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
  document.body.classList.add('noscroll');
  return el;
}
function closeSheet() {
  if (S.nfcAbort) { try { S.nfcAbort.abort(); } catch { /* уже остановлено */ } S.nfcAbort = null; }
  if (S.cf) { const r = S.cf; S.cf = null; r(false); }
  const el = $('#layer .overlay');
  document.body.classList.remove('noscroll');
  if (!el) return;
  el.classList.remove('open');
  setTimeout(() => el.remove(), 380);
}
function confirmBox({ title, text, ok = 'Да', danger = false }) {
  return new Promise((res) => {
    sheet(`<h2 class="h2">${esc(title)}</h2><p class="dim">${esc(text)}</p>
      <div class="actions split"><button class="btn" data-act="cf-no">Отмена</button><button class="btn ${danger ? 'hot' : 'pri'}" data-act="cf-yes">${esc(ok)}</button></div>`);
    S.cf = res;
  });
}
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 3800);
}

/* ============ блик и наклон карточек ============ */
let lastTilt = null;
function initTilt() {
  const reset = () => { if (lastTilt) { lastTilt.style.setProperty('--rx', '0deg'); lastTilt.style.setProperty('--ry', '0deg'); lastTilt = null; } };
  document.addEventListener('pointermove', (e) => {
    const t = e.target.closest && e.target.closest('.tilt');
    if (!t) return reset();
    if (lastTilt && lastTilt !== t) reset();
    const r = t.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    t.style.setProperty('--rx', ((.5 - y) * 7).toFixed(2) + 'deg');
    t.style.setProperty('--ry', ((x - .5) * 9).toFixed(2) + 'deg');
    t.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
    t.style.setProperty('--my', (y * 100).toFixed(1) + '%');
    lastTilt = t;
  }, { passive: true });
  document.addEventListener('pointerup', reset, { passive: true });
  document.addEventListener('pointercancel', reset, { passive: true });
  document.addEventListener('pointerleave', reset, { passive: true });
}

/* ============ каркас и роутер ============ */
const go = (h) => { if (location.hash === h) renderRoute(); else location.hash = h; };
function shell() {
  $('#app').innerHTML = `<main id="view" class="view"></main>
    <nav class="tabbar glass" id="tabbar" style="--i:0"><i class="ind"></i>
      <a href="#/" data-tab="calendar">${ico('calendar')}<span>Календарь</span></a>
      <a href="#/groups" data-tab="groups">${ico('flame')}<span>Огоньки</span></a>
      <a href="#/notifs" data-tab="notifs">${ico('bell')}<span>События</span><em class="badge" id="badge" hidden></em></a>
      <a href="#/profile" data-tab="profile">${ico('user')}<span>Профиль</span></a>
    </nav>`;
  updateBadge();
}
function setTab(tab) {
  const tb = $('#tabbar'); if (!tb) return;
  const idx = { calendar: 0, groups: 1, notifs: 2, profile: 3 }[tab];
  if (idx === undefined) tb.setAttribute('data-none', ''); else { tb.removeAttribute('data-none'); tb.style.setProperty('--i', idx); }
  $$('a', tb).forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
}
async function renderRoute(soft = false) {
  if (!S.user || !$('#view')) return;
  const tok = ++S.rt;
  const [, a, b] = (location.hash.replace(/^#/, '') || '/').split('/');
  const tab = { groups: 'groups', group: 'groups', notifs: 'notifs', profile: 'profile', tap: null }[a];
  setTab(a === undefined || a === '' ? 'calendar' : tab);
  const v = $('#view');
  if (!soft) { v.classList.remove('in'); void v.offsetWidth; v.classList.add('in'); window.scrollTo(0, 0); }
  try {
    if (a === 'tap') await tapView(b, tok);
    else if (a === 'group') await groupView(Number(b), tok);
    else if (a === 'groups') await groupsView(tok);
    else if (a === 'notifs') await notifsView(tok);
    else if (a === 'profile') profileView();
    else await calendarView(tok);
  } catch (e) {
    if (stale(tok)) return;
    v.innerHTML = `<div class="glass empty">${flame(0, { size: 84, num: false })}<h2 class="h2">Не получилось загрузить</h2><p class="dim">${esc(e.message)}</p><button class="btn pri" data-act="reload">Повторить</button></div>`;
  }
}

/* ============ вход и регистрация ============ */
function showAuth(mode = 'login') {
  const reg = mode === 'register';
  $('#app').innerHTML = `<div class="auth">
    <div class="brand">${flame(7, { size: 112, num: false })}
      <h1 class="title chrome" style="font-size:44px">Календарик</h1>
      <p class="dim">Собирайтесь с друзьями и держите общий огонёк</p></div>
    <div class="glass card-in">
      <div class="seg" role="tablist">
        <button data-act="auth-mode" data-m="login" class="${reg ? '' : 'on'}" role="tab">Вход</button>
        <button data-act="auth-mode" data-m="register" class="${reg ? 'on' : ''}" role="tab">Регистрация</button>
      </div>
      <form data-form="${reg ? 'register' : 'login'}">
        ${reg ? `
          <label class="field"><span>Юзернейм, по нему вас будут находить</span><input name="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="например, anya_k"></label>
          <label class="field"><span>Почта</span><input name="email" type="email" required autocomplete="email" autocapitalize="off" placeholder="you@mail.com"></label>
          <label class="field"><span>Никнейм (необязательно)</span><input name="nickname" maxlength="30" autocomplete="nickname" placeholder="Как вас показывать друзьям"></label>
          <label class="field"><span>Пароль, от 8 символов</span><input name="password" type="password" required minlength="8" autocomplete="new-password"></label>`
        : `
          <label class="field"><span>Юзернейм или почта</span><input name="login" required autocomplete="username" autocapitalize="off" spellcheck="false"></label>
          <label class="field"><span>Пароль</span><input name="password" type="password" required autocomplete="current-password"></label>`}
        <p class="err" role="alert"></p>
        <button class="btn pri block" type="submit">${reg ? 'Создать аккаунт' : 'Войти'}</button>
      </form>
    </div></div>`;
}
async function enter() {
  shell();
  await Promise.all([loadGroups().catch(() => {}), loadNotifs().catch(() => {})]);
  await renderRoute();
}

/* ============ календарь ============ */
function gridDays(m) {
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
}
async function loadEvents() {
  const days = gridDays(S.month);
  const from = new Date(days[0]); from.setHours(0, 0, 0, 0);
  const to = new Date(days[41]); to.setHours(24, 0, 0, 0);
  S.events = (await api('GET', `/api/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)).events;
  indexEvents(S.events);
}
async function calendarView(tok) {
  if (!S.groupsLoaded) { await loadGroups().catch(() => {}); S.groupsLoaded = true; }
  await loadEvents();
  if (stale(tok)) return;
  paintCalendar();
}
function resultPill(e) {
  if (e.status === 'live') return `<span class="pill live">идёт ${e.presentIds.length}/${e.total}</span>`;
  if (e.result === 'success') return '<span class="pill ok">огонёк +1</span>';
  if (e.result === 'saved') return '<span class="pill saved">резист</span>';
  if (e.result === 'broken') return '<span class="pill broken">огонёк погас</span>';
  return '';
}
function evCard(e) {
  return `<article class="card ev tilt" data-act="open-event" data-id="${e.id}" style="--c:${colorOf(e.groupId)}" tabindex="0">
    <i class="bar"></i>
    <div class="ev-main"><span class="ev-time">${fmtT(e.startsAt)}</span><h3 class="h3">${esc(e.title)}</h3><span class="small dim">${esc(e.groupName)}${e.location ? ', ' + esc(e.location) : ''}</span></div>
    <div>${resultPill(e)}</div></article>`;
}
function paintCalendar() {
  const m = S.month, days = gridDays(m);
  const byDay = {};
  for (const e of S.events) (byDay[dkey(new Date(e.startsAt))] ||= []).push(e);
  const selKey = dkey(S.sel), todayKey = dkey(new Date());
  const monthName = m.toLocaleDateString('ru-RU', { month: 'long' });
  const dayEvents = byDay[selKey] || [];
  const nx = S.groups.filter((g) => g.nextEvent).map((g) => ({ g, e: g.nextEvent })).sort((a, b) => new Date(a.e.startsAt) - new Date(b.e.startsAt))[0];
  $('#view').innerHTML = `
    ${nx ? `<a class="card paper next tilt" href="#/group/${nx.g.id}">
        <div><span class="small dim">Ближайшая встреча</span><div class="big">${fmtT(nx.e.startsAt)}</div>
        <h3 class="h3" style="margin-top:6px">${esc(nx.e.title)}</h3><span class="small dim">${esc(cap(fmtD(nx.e.startsAt)))}, ${esc(nx.g.name)}</span></div>
        ${flame(nx.g.streak, { size: 70 })}</a>` : ''}
    <section class="glass cal">
      <div class="cal-head">
        <button class="icon-btn" data-act="prev-month" aria-label="Предыдущий месяц">${ico('chevL')}</button>
        <span class="m chrome">${esc(monthName)} ${m.getFullYear()}</span>
        <button class="icon-btn" data-act="next-month" aria-label="Следующий месяц">${ico('chevR')}</button>
      </div>
      <div class="wk">${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="grid">${days.map((d) => {
        const k = dkey(d), evs = byDay[k] || [];
        const dots = [...new Set(evs.map((e) => e.groupId))].slice(0, 3).map((g) => `<i style="--c:${colorOf(g)}"></i>`).join('');
        return `<button class="day${d.getMonth() !== m.getMonth() ? ' dim' : ''}${k === todayKey ? ' today' : ''}${k === selKey ? ' sel' : ''}" data-act="pick-day" data-d="${k}"><span>${d.getDate()}</span><span class="dots">${dots}</span></button>`;
      }).join('')}</div>
    </section>
    <div class="sect"><h2 class="h2">${esc(cap(fmtD(S.sel)))}</h2>${dkey(S.sel) !== todayKey ? '<button class="btn sm" data-act="today">Сегодня</button>' : ''}</div>
    ${dayEvents.length ? `<div class="stack">${dayEvents.map(evCard).join('')}</div>`
      : `<div class="glass empty">${flame(0, { size: 64, num: false })}<h3 class="h3">В этот день пока пусто</h3><p class="dim">${S.groups.some((g) => g.isLeader) ? 'Нажмите плюс, чтобы назначить встречу' : 'Создайте группу и станьте её лидером, чтобы назначать встречи'}</p></div>`}
    <button class="fab" data-act="new-event" aria-label="Новая встреча">${ico('plus')}</button>`;
}

/* ============ встречи: карточка, форма ============ */
function eventSheet(id) {
  const e = S.ev[id]; if (!e) return;
  const g = S.groups.find((x) => x.id === e.groupId);
  const members = g ? g.members : [];
  const present = new Set(e.presentIds);
  const leader = !!(g && g.isLeader);
  const remind = (e.remindBefore || []).map((m) => REMIND_LABEL[m]).join(', ') || 'без напоминаний';
  sheet(`
    <span class="pill" style="background:${colorOf(e.groupId)};color:#000">${esc(e.groupName)}</span>
    <h2 class="h2" style="margin-top:10px">${esc(e.title)}</h2>
    <p class="dim">${esc(cap(fmtD(e.startsAt)))}, ${fmtT(e.startsAt)} ${resultPill(e)}</p>
    ${e.location ? `<p style="margin-top:12px;display:flex;gap:8px;align-items:center"><span style="width:20px;display:inline-block">${ico('pin')}</span>${esc(e.location)}</p>` : ''}
    ${e.description ? `<p class="dim" style="margin-top:10px;white-space:pre-wrap">${esc(e.description)}</p>` : ''}
    <div class="sect"><h3 class="h3">Кто пришёл</h3><span class="small dim">${present.size} из ${e.total}</span></div>
    ${members.length ? `<div class="card list">${members.map((m) => `<div class="row">${avatar(m, 36)}<div class="who"><b>${esc(m.nickname)}</b><span class="small dim">@${esc(m.username)}</span></div>${present.has(m.id) ? '<span class="pill ok">на месте</span>' : ''}</div>`).join('')}</div>` : ''}
    <p class="hint">Напоминания: ${esc(remind)}</p>
    <div class="actions">
      ${e.status !== 'finished' ? `<button class="btn pri block" data-act="scan">${ico('nfc')} Приложить к NFC-метке</button>` : ''}
      ${leader && e.status === 'planned' ? `<div class="split"><button class="btn" data-act="edit-event" data-id="${e.id}">${ico('edit')} Изменить</button><button class="btn hot" data-act="del-event" data-id="${e.id}">Удалить</button></div>` : ''}
      ${leader && e.status === 'live' ? `<button class="btn hot block" data-act="finish-event" data-id="${e.id}">Завершить встречу</button>` : ''}
    </div>`);
}
function defaultStart() {
  const d = new Date(S.sel); d.setHours(19, 0, 0, 0);
  if (d.getTime() < Date.now()) { const n = new Date(); n.setMinutes(0, 0, 0); n.setHours(n.getHours() + 1); return n; }
  return d;
}
function eventForm(ev, groupId) {
  const mine = S.groups.filter((g) => g.isLeader);
  if (!ev && !mine.length) { toast('Встречи назначает лидер. Создайте группу, и вы им станете'); return newGroupSheet(); }
  const d = ev ? new Date(ev.startsAt) : defaultStart();
  const rem = new Set(ev ? ev.remindBefore : [60]);
  sheet(`<h2 class="h2">${ev ? 'Изменить встречу' : 'Новая встреча'}</h2>
    <form data-form="event" data-id="${ev ? ev.id : ''}">
      ${ev ? '' : `<label class="field"><span>Группа</span><select name="group">${mine.map((g) => `<option value="${g.id}" ${g.id === groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>`}
      <label class="field"><span>Название</span><input name="title" required maxlength="80" value="${esc(ev ? ev.title : '')}" placeholder="Например, ужин у Ани"></label>
      <label class="field"><span>Дата и время</span><input type="datetime-local" name="when" required value="${toLocalInput(d)}"></label>
      <label class="field"><span>Место</span><input name="location" maxlength="100" value="${esc(ev ? ev.location : '')}"></label>
      <label class="field"><span>Описание</span><textarea name="description" maxlength="500">${esc(ev ? ev.description : '')}</textarea></label>
      <p class="hint">Напомнить всем участникам за</p>
      <div class="chips">${REMINDS.map(([m, l]) => `<label class="chip"><input type="checkbox" name="rem" value="${m}" ${rem.has(m) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <p class="err" role="alert"></p>
      <button class="btn pri block" type="submit">${ev ? 'Сохранить' : 'Создать встречу'}</button>
    </form>`);
}
function newGroupSheet() {
  sheet(`<h2 class="h2">Новая группа</h2><p class="dim">Вы станете её лидером: сможете добавлять людей, назначать встречи и передать лидерство.</p>
    <form data-form="group"><label class="field"><span>Название</span><input name="name" required maxlength="40" placeholder="Например, Семья или Клуб настолок"></label>
    <p class="err" role="alert"></p><button class="btn pri block" type="submit">Создать группу</button></form>`);
}

/* ============ NFC ============ */
const nfcSupported = () => 'NDEFReader' in window;
async function nfcScan() {
  if (!nfcSupported()) {
    sheet(`<h2 class="h2">Приложите телефон к метке</h2>
      <p class="dim">В этом браузере нет доступа к NFC из страницы. Ничего страшного: просто поднесите верх телефона к метке, и она сама откроет Календарик.</p>
      <p class="hint">На iPhone (XS и новее) и на Android чтение меток встроено в систему. Войдите в аккаунт в том браузере, который откроется по метке.</p>
      <div class="actions"><button class="btn" data-act="close">Понятно</button></div>`);
    return;
  }
  const ac = new AbortController(); S.nfcAbort = ac;
  sheet(`<div class="tapcard" style="margin-top:0;padding-top:6px"><span class="wave" style="--z:70px;width:84px;height:84px"><i></i><i></i><i></i>${ico('nfc')}</span>
    <h2 class="h2">Поднесите телефон к метке</h2><p class="dim">Держите рядом, пока не увидите результат</p>
    <div class="actions"><button class="btn" data-act="close">Отмена</button></div></div>`);
  try {
    const reader = new NDEFReader();
    await reader.scan({ signal: ac.signal });
    reader.onreading = (ev) => {
      for (const rec of ev.message.records) {
        if (rec.recordType !== 'url' && rec.recordType !== 'text') continue;
        const txt = new TextDecoder(rec.encoding || 'utf-8').decode(rec.data);
        const m = txt.match(/#\/tap\/([\w-]+)/);
        if (m) { ac.abort(); S.nfcAbort = null; closeSheet(); go('#/tap/' + m[1]); return; }
      }
      toast('Это не метка Календарика', 'bad');
    };
  } catch (e) {
    closeSheet();
    if (e.name !== 'AbortError') toast('Не удалось включить NFC: ' + e.message, 'bad');
  }
}

/* ============ итог встречи (огонёк вырос / резист / погас) ============ */
function showFinal(el, f) {
  const link = `<div class="actions"><a class="btn wht" href="#/group/${f.groupId}" data-act="close">Открыть группу</a></div>`;
  if (f.result === 'success') {
    el.innerHTML = `<div id="fslot">${flame(f.prevStreak, { size: 150 })}</div><h2 class="h2">Огонёк вырос до ${f.streak}</h2><p class="dim">Встреча состоялась, пришли все (${f.present} из ${f.total})</p>${link}`;
    setTimeout(() => { const s = $('#fslot'); if (!s) return; s.innerHTML = flame(f.streak, { size: 150, burst: true }); countUp($('#fslot .fl-n'), f.prevStreak, f.streak); vibe(); }, 650);
  } else if (f.result === 'saved') {
    el.innerHTML = `${flame(f.streak, { size: 130 })}<div style="margin:6px 0">${shield(true, 46)}</div><h2 class="h2">Резист спас огонёк</h2><p class="dim">Пришли ${f.present} из ${f.total}, но огонёк остался на ${f.streak}. Резист этого месяца потрачен.</p>${link}`;
    vibe([50]);
  } else {
    el.innerHTML = `<div id="fslot">${flame(f.prevStreak, { size: 150 })}</div><h2 class="h2">Огонёк погас</h2><p class="dim">Пришли ${f.present} из ${f.total}, а резист в этом месяце уже потрачен. Серия ${f.prevStreak} сброшена, начните заново.</p>${link}`;
    setTimeout(() => { const s = $('#fslot .flame'); if (s) s.classList.add('out'); }, 500);
    setTimeout(() => { const s = $('#fslot'); if (s) s.innerHTML = flame(0, { size: 150 }); }, 2100);
    vibe([120]);
  }
}
async function tapView(secret, tok) {
  const v = $('#view');
  v.innerHTML = `<div class="glass tapcard">${flame(0, { size: 110, num: false })}<h2 class="h2">Проверяю метку</h2></div>`;
  let r;
  try { r = await api('POST', '/api/tap', { secret }); }
  catch (e) {
    if (stale(tok)) return;
    v.innerHTML = `<div class="glass tapcard">${flame(0, { size: 96, num: false })}<h2 class="h2">Отметить не получилось</h2><p class="dim">${esc(e.message)}</p><div class="actions"><a class="btn wht" href="#/groups">К моим группам</a></div></div>`;
    return;
  }
  if (stale(tok)) return;
  history.replaceState(null, '', '#/groups'); // обновление страницы не пошлёт касание повторно
  loadGroups().catch(() => {});
  const card = document.createElement('div'); card.className = 'glass tapcard'; v.innerHTML = ''; v.appendChild(card);
  if (r.finalized) { showFinal(card, r.finalized); return; }
  vibe();
  const pct = Math.round((r.present / r.total) * 100);
  card.innerHTML = `${flame(r.group.streak, { size: 120 })}
    <h2 class="h2">${r.opened ? 'Встреча началась' : 'Вы на встрече'}</h2>
    <p class="dim">${esc(r.event.title)}, ${esc(r.group.name)}</p>
    <div class="progress" aria-label="Отметились"><i style="--p:0%"></i></div>
    <p class="small dim">Отметились ${r.present} из ${r.total}. ${r.opened ? 'Теперь пусть остальные приложат телефон к метке.' : 'Когда придут все, огонёк вырастет.'}</p>
    <div class="actions">${r.isLeader ? `<button class="btn hot" data-act="finish-event" data-id="${r.event.id}">Завершить встречу</button>` : ''}<a class="btn wht" href="#/group/${r.group.id}">Открыть группу</a></div>`;
  requestAnimationFrame(() => requestAnimationFrame(() => { const i = $('.progress i', card); if (i) i.style.setProperty('--p', pct + '%'); }));
}

/* ============ группы ============ */
function gCard(g) {
  const n = g.nextEvent;
  return `<a class="card gcard tilt" href="#/group/${g.id}">
    ${flame(g.streak, { size: 74 })}
    <div class="info"><h3 class="h3">${esc(g.name)}${g.isLeader ? ` <span class="crown" title="Вы лидер">${ico('crown')}</span>` : ''}</h3>
      ${avStack(g.members)}
      <span class="small dim">${n ? esc(cap(fmtDT(n.startsAt))) + ', ' + esc(n.title) : 'Встреч пока нет'}</span></div>
    ${shield(g.resistAvailable)}</a>`;
}
async function groupsView(tok) {
  await loadGroups();
  if (stale(tok)) return;
  $('#view').innerHTML = `<div class="top"><h1 class="title chrome">Огоньки</h1><button class="icon-btn" data-act="new-group" aria-label="Новая группа">${ico('plus')}</button></div>
    ${S.groups.length ? `<div class="stack">${S.groups.map(gCard).join('')}</div>`
      : `<div class="glass empty">${flame(0, { size: 84, num: false })}<h3 class="h3">Пока нет групп</h3><p class="dim">Создайте группу и добавьте друзей по юзернейму. Огонёк растёт, когда на встречу приходят все.</p><button class="btn pri" data-act="new-group">Создать группу</button></div>`}`;
}
async function groupView(id, tok) {
  const r = await api('GET', `/api/groups/${id}`);
  if (stale(tok)) return;
  S.cur = r.group; indexEvents(r.events);
  const i = S.groups.findIndex((x) => x.id === id);
  if (i >= 0) S.groups[i] = { ...S.groups[i], ...r.group, nextEvent: S.groups[i].nextEvent };
  paintGroup(r);
}
function paintGroup({ group: g, events }) {
  const up = events.filter((e) => e.status !== 'finished').sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  const past = events.filter((e) => e.status === 'finished').slice(0, 6);
  const streakText = g.streak === 0 ? 'Огонёк ждёт встречи, на которую придут все' : `${plural(g.streak, 'встреча', 'встречи', 'встреч')} подряд, пришли все`;
  $('#view').innerHTML = `
    <a class="back" href="#/groups">${ico('chevL')} Огоньки</a>
    <div class="top"><h1 class="title">${esc(g.name)}</h1>${g.isLeader ? `<button class="icon-btn" data-act="edit-group" aria-label="Переименовать">${ico('edit')}</button>` : ''}</div>
    <section class="glass hero">${flame(g.streak, { size: 150 })}<p class="streak">${streakText}</p></section>
    <div class="stats">
      <div class="card mono stat"><span class="small dim">Рекорд</span><b class="chrome">${g.bestStreak}</b></div>
      <div class="card paper stat"><span class="small dim">Резист месяца</span><div class="row1">${shield(g.resistAvailable, 32)}<b style="font-size:18px;letter-spacing:-.02em">${g.resistAvailable ? 'Есть' : 'Потрачен'}</b></div></div>
    </div>
    <div class="sect"><h2 class="h2">Встречи</h2>${g.isLeader ? `<button class="btn sm pri" data-act="new-event" data-g="${g.id}">${ico('plus')} Назначить</button>` : ''}</div>
    ${up.length ? `<div class="stack">${up.map(evCard).join('')}</div>` : '<div class="glass empty"><p class="dim">Пока ничего не запланировано</p></div>'}
    ${past.length ? `<div class="sect"><h3 class="h3">Прошедшие</h3></div><div class="stack">${past.map(evCard).join('')}</div>` : ''}
    <div class="sect"><h2 class="h2">Отметка на встрече</h2></div>
    <section class="card nfc">
      <div class="nfc-anim"><span class="wave"><i></i><i></i><i></i>${ico('nfc')}</span>
        <p class="small dim">Лидер первым касается NFC-метки телефоном, потом остальные. Как только отметились все, огонёк растёт.</p></div>
      <div class="btns"><button class="btn pri" data-act="scan">${ico('nfc')} Приложить к метке</button>${g.isLeader ? '<button class="btn" data-act="tag">Метка группы</button>' : ''}</div>
    </section>
    <div class="sect"><h2 class="h2">Участники</h2><span class="small dim">${g.members.length}</span></div>
    <div class="card list">${g.members.map((m) => `<div class="row">${avatar(m, 40)}<div class="who"><b>${esc(m.nickname)}${m.id === g.leaderId ? ` <span class="crown" title="Лидер">${ico('crown')}</span>` : ''}</b><span class="small dim">@${esc(m.username)}</span></div>${g.isLeader && m.id !== S.user.id ? `<button class="mini-x" data-act="kick" data-uid="${m.id}" data-name="${esc(m.nickname)}" aria-label="Убрать из группы">${ico('x')}</button>` : ''}</div>`).join('')}</div>
    ${g.isLeader ? `<div class="card form" style="margin-top:12px"><label class="field" style="margin:0"><span>Добавить по юзернейму</span><input id="addq" placeholder="@username" autocomplete="off" autocapitalize="off" spellcheck="false"></label><div class="list" id="addres"></div></div>` : ''}
    <div class="danger-zone">
      ${g.isLeader ? `<button class="btn block" data-act="transfer">Передать лидерство</button><button class="btn hot block" data-act="del-group">Удалить группу</button>` : `<button class="btn hot block" data-act="leave">Выйти из группы</button>`}
    </div>`;
}
let addTimer;
function searchUsers(q) {
  clearTimeout(addTimer);
  q = q.trim().replace(/^@/, '');
  if (q.length < 2) { const b = $('#addres'); if (b) b.innerHTML = ''; return; }
  addTimer = setTimeout(async () => {
    try {
      const { users } = await api('GET', '/api/users/search?q=' + encodeURIComponent(q));
      const box = $('#addres'); if (!box) return;
      const inGroup = new Set(((S.cur && S.cur.members) || []).map((m) => m.id));
      box.innerHTML = users.length
        ? users.map((u) => `<div class="row">${avatar(u, 38)}<div class="who"><b>${esc(u.nickname)}</b><span class="small dim">@${esc(u.username)}</span></div>${inGroup.has(u.id) ? '<span class="pill">в группе</span>' : `<button class="btn sm pri" data-act="add-member" data-u="${esc(u.username)}">Добавить</button>`}</div>`).join('')
        : '<p class="hint">Никого не нашли. Проверьте юзернейм</p>';
    } catch { /* сеть моргнула, следующий ввод повторит */ }
  }, 250);
}

/* ============ уведомления и push ============ */
const NKIND = { reminder: ['clock', '#ff8a1f'], event: ['calendar', '#2f7bff'], invite: ['users', '#00e0c6'], leader: ['crown', '#ffd23f'], streak: ['flame', '#c8ff2e'], resist: ['shield', '#00e0c6'], broken: ['flame', '#ff2d87'], live: ['pin', '#c8ff2e'], info: ['bell', '#ffffff'] };
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent);
async function pushStatus() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(rej, 2500))]);
    return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
  } catch { return 'off'; }
}
const b64u = (s) => { const b = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(b), (c) => c.charCodeAt(0)); };
async function enablePush() {
  const { key } = await api('GET', '/api/push/key');
  if (!key) throw new Error('На сервере не настроены push-ключи (VAPID). Уведомления будут приходить внутри приложения');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Разрешение на уведомления не выдано');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(key) }));
  await api('POST', '/api/push/subscribe', sub.toJSON());
}
async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
}
async function fillPush() {
  const box = $('#pushbox'); if (!box) return;
  const st = await pushStatus();
  if (!$('#pushbox')) return;
  const iosHint = isIOS() && !navigator.standalone;
  box.innerHTML = st === 'on' ? `<div class="row"><div class="who"><b>Push включены</b><span class="small dim">Напоминания придут даже при закрытом приложении</span></div><button class="btn sm" data-act="push-off">Выключить</button></div>`
    : st === 'denied' ? `<p class="hint">Уведомления запрещены для сайта. Разрешите их в настройках браузера.</p>`
    : (st === 'unsupported' || iosHint) ? `<p class="hint">${isIOS() ? 'На iPhone push работают у приложения на экране «Домой» (iOS 16.4+): «Поделиться», затем «На экран Домой». Откройте иконку и включите уведомления здесь.' : 'Этот браузер не поддерживает push. Напоминания будут появляться внутри приложения.'}</p>${st === 'off' ? '<button class="btn sm pri" data-act="push-on">Всё равно включить</button>' : ''}`
    : `<div class="row"><div class="who"><b>Push-уведомления</b><span class="small dim">О встречах, огоньках и приглашениях</span></div><button class="btn sm pri" data-act="push-on">Включить</button></div>`;
}
async function notifsView(tok) {
  await loadNotifs();
  if (stale(tok)) return;
  const items = S.notifs, hadUnread = S.unread > 0;
  $('#view').innerHTML = `<div class="top"><h1 class="title chrome">События</h1></div>
    <div class="card form" id="pushbox" style="margin-bottom:16px"></div>
    ${items.length ? `<div class="stack">${items.map((n) => {
      const [ic, col] = NKIND[n.kind] || NKIND.info;
      return `<article class="card n-item tilt${n.read ? '' : ' unread'}" data-act="open-url" data-url="${esc((n.data && n.data.url) || '')}"><span class="n-ico" style="--c:${col}">${ico(ic)}</span>
        <div><h3 class="h3">${esc(n.title)}</h3><p class="small dim">${esc(n.body)}</p><time>${esc(fmtDT(n.createdAt))}</time></div></article>`;
    }).join('')}</div>` : `<div class="glass empty">${flame(0, { size: 70, num: false })}<h3 class="h3">Пока тихо</h3><p class="dim">Здесь появятся напоминания о встречах, приглашения и новости об огоньках.</p></div>`}`;
  fillPush();
  if (hadUnread) api('POST', '/api/notifications/read').then(() => { S.unread = 0; updateBadge(); }).catch(() => {});
}

/* ============ профиль ============ */
function profileView() {
  const u = S.user;
  $('#view').innerHTML = `<div class="top"><h1 class="title chrome">Профиль</h1></div>
    <section class="glass me">
      <div class="avwrap">${avatar(u, 118)}<button class="cam" data-act="pick-avatar" aria-label="Сменить аватарку">${ico('camera')}</button></div>
      <h2 class="h2">${esc(u.nickname)}</h2><p class="dim">@${esc(u.username)}</p><p class="small faint">${esc(u.email)}</p>
    </section>
    <input type="file" id="avfile" accept="image/*" hidden>
    <div class="sect"><h3 class="h3">Никнейм</h3></div>
    <form class="card form" data-form="nick"><label class="field" style="margin-top:0"><span>Как вас видят друзья</span><input name="nickname" required maxlength="30" value="${esc(u.nickname)}"></label>
      <p class="err" role="alert"></p><button class="btn block" type="submit">Сохранить никнейм</button>
      <p class="hint">Юзернейм @${esc(u.username)} остаётся прежним: по нему вас находят и добавляют в группы.</p></form>
    <div class="sect"><h3 class="h3">Пароль</h3></div>
    <form class="card form" data-form="pass"><label class="field" style="margin-top:0"><span>Текущий пароль</span><input name="current" type="password" required autocomplete="current-password"></label>
      <label class="field"><span>Новый пароль, от 8 символов</span><input name="next" type="password" required minlength="8" autocomplete="new-password"></label>
      <p class="err" role="alert"></p><button class="btn block" type="submit">Сменить пароль</button></form>
    <div class="sect"><h3 class="h3">Уведомления</h3></div>
    <div class="card form" id="pushbox"></div>
    <button class="btn block" style="margin-top:22px" data-act="logout">${ico('logout')} Выйти из аккаунта</button>`;
  fillPush();
}
async function toAvatarBlob(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch {
    bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Не удалось открыть фото')); i.src = URL.createObjectURL(file); });
  }
  const w = bmp.width, h = bmp.height, s = Math.min(w, h);
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  cv.getContext('2d').drawImage(bmp, (w - s) / 2, (h - s) / 2, s, s, 0, 0, 256, 256);
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Не удалось обработать фото'))), 'image/jpeg', 0.86));
}

/* ============ действия (data-act) ============ */
const refresh = async () => { await loadGroups().catch(() => {}); await renderRoute(true); };
const A = {
  close: () => closeSheet(),
  'cf-yes': () => { const r = S.cf; S.cf = null; closeSheet(); if (r) r(true); },
  'cf-no': () => closeSheet(),
  reload: () => renderRoute(),
  'retry-boot': () => boot(),
  'auth-mode': (el) => showAuth(el.dataset.m),

  'prev-month': async () => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() - 1, 1); await renderRoute(true); },
  'next-month': async () => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() + 1, 1); await renderRoute(true); },
  today: async () => { S.sel = new Date(); S.month = startOfMonth(S.sel); await renderRoute(true); },
  'pick-day': async (el) => {
    const d = new Date(el.dataset.d + 'T00:00:00');
    const other = d.getMonth() !== S.month.getMonth() || d.getFullYear() !== S.month.getFullYear();
    S.sel = d;
    if (other) { S.month = startOfMonth(d); await renderRoute(true); } else paintCalendar();
  },

  'new-event': (el) => eventForm(null, Number(el.dataset.g) || null),
  'open-event': (el) => eventSheet(Number(el.dataset.id)),
  'edit-event': (el) => eventForm(S.ev[Number(el.dataset.id)]),
  'del-event': async (el) => {
    const id = Number(el.dataset.id);
    if (!(await confirmBox({ title: 'Удалить встречу?', text: 'Участники получат уведомление об отмене.', ok: 'Удалить', danger: true }))) return;
    await api('DELETE', `/api/events/${id}`); toast('Встреча удалена'); await refresh();
  },
  'finish-event': async (el) => {
    const id = Number(el.dataset.id);
    if (!(await confirmBox({ title: 'Завершить встречу?', text: 'Кто не успел отметиться, будет считаться отсутствующим. Если пришли не все, сработает резист или огонёк обнулится.', ok: 'Завершить', danger: true }))) return;
    const { finalized } = await api('POST', `/api/events/${id}/finish`);
    const sh = sheet('<div class="tapcard" style="margin-top:0;padding:6px 0 0"></div>');
    showFinal($('.tapcard', sh), finalized);
    await loadGroups().catch(() => {});
  },
  scan: () => nfcScan(),

  'new-group': () => newGroupSheet(),
  'edit-group': () => sheet(`<h2 class="h2">Название группы</h2><form data-form="rename"><label class="field"><span>Название</span><input name="name" required maxlength="40" value="${esc(S.cur.name)}"></label><p class="err" role="alert"></p><button class="btn pri block" type="submit">Сохранить</button></form>`),
  'add-member': async (el) => {
    await api('POST', `/api/groups/${S.cur.id}/members`, { username: el.dataset.u });
    toast('Участник добавлен', 'good'); await refresh();
  },
  kick: async (el) => {
    if (!(await confirmBox({ title: `Убрать ${el.dataset.name}?`, text: 'Человек выйдет из группы и не будет получать её уведомления.', ok: 'Убрать', danger: true }))) return;
    await api('DELETE', `/api/groups/${S.cur.id}/members/${el.dataset.uid}`); await refresh();
  },
  leave: async () => {
    if (!(await confirmBox({ title: 'Выйти из группы?', text: 'Огонёк и встречи группы останутся у остальных.', ok: 'Выйти', danger: true }))) return;
    await api('DELETE', `/api/groups/${S.cur.id}/members/${S.user.id}`); toast('Вы вышли из группы'); go('#/groups'); await loadGroups().catch(() => {});
  },
  'del-group': async () => {
    if (!(await confirmBox({ title: 'Удалить группу?', text: 'Пропадут все встречи и огонёк. Это нельзя отменить.', ok: 'Удалить', danger: true }))) return;
    await api('DELETE', `/api/groups/${S.cur.id}`); toast('Группа удалена'); go('#/groups');
  },
  transfer: () => {
    const others = S.cur.members.filter((m) => m.id !== S.user.id);
    if (!others.length) return toast('В группе больше никого нет: сначала добавьте участника', 'bad');
    sheet(`<h2 class="h2">Кому передать лидерство?</h2><p class="dim">Новый лидер получит все права: добавлять людей, назначать встречи и подтверждать их. Ваша NFC-метка перестанет работать.</p>
      <div class="card list" style="margin-top:14px">${others.map((m) => `<div class="row tilt" data-act="do-transfer" data-uid="${m.id}" data-name="${esc(m.nickname)}" style="cursor:pointer">${avatar(m, 40)}<div class="who"><b>${esc(m.nickname)}</b><span class="small dim">@${esc(m.username)}</span></div>${ico('chevR')}</div>`).join('')}</div>`);
  },
  'do-transfer': async (el) => {
    if (!(await confirmBox({ title: `Передать лидерство: ${el.dataset.name}?`, text: 'Все права перейдут к нему сразу. Вернуть их сможет только он сам.', ok: 'Передать', danger: true }))) return;
    await api('POST', `/api/groups/${S.cur.id}/transfer`, { userId: Number(el.dataset.uid) });
    toast('Лидерство передано', 'good'); await refresh();
  },

  tag: async () => {
    const { url } = await api('GET', `/api/groups/${S.cur.id}/tag`);
    sheet(`<h2 class="h2">NFC-метка группы</h2>
      <p class="dim">В метке лежит ссылка. Запишите её на любую NFC-наклейку (NTAG213 и подобные) и держите при себе. Лидер касается метки первым, потом остальные.</p>
      <label class="field"><span>Ссылка для метки</span><input id="tagurl" readonly value="${esc(url)}"></label>
      <div class="actions"><button class="btn pri block" data-act="tag-write">${ico('nfc')} Записать на метку (Android)</button><button class="btn block" data-act="tag-copy">Скопировать ссылку</button><button class="btn hot block" data-act="tag-rotate">Выпустить новую метку</button></div>
      <p class="hint">На iPhone запишите скопированную ссылку бесплатным приложением «NFC Tools»: пункт «Записать», «Добавить запись», «URL».</p>`);
  },
  'tag-write': async () => {
    if (!nfcSupported()) throw new Error('Запись из браузера работает в Chrome на Android. С iPhone скопируйте ссылку и запишите её приложением «NFC Tools»');
    const ac = new AbortController(); S.nfcAbort = ac;
    toast('Приложите чистую NFC-метку к телефону');
    await new NDEFReader().write({ records: [{ recordType: 'url', data: $('#tagurl').value }] }, { signal: ac.signal });
    S.nfcAbort = null; vibe(); toast('Метка записана', 'good');
  },
  'tag-copy': async () => {
    const inp = $('#tagurl');
    try { await navigator.clipboard.writeText(inp.value); toast('Ссылка скопирована', 'good'); }
    catch { inp.select(); document.execCommand && document.execCommand('copy'); toast('Ссылка выделена, скопируйте её'); }
  },
  'tag-rotate': async () => {
    if (!(await confirmBox({ title: 'Выпустить новую метку?', text: 'Старая метка сразу перестанет работать. Новую ссылку нужно будет записать на метку.', ok: 'Выпустить', danger: true }))) return;
    await api('POST', `/api/groups/${S.cur.id}/tag/rotate`);
    toast('Готово: запишите новую ссылку', 'good'); await A.tag();
  },

  'open-url': (el) => { const h = (el.dataset.url || '').split('#')[1]; if (h) go('#' + h); },
  'pick-avatar': () => $('#avfile').click(),
  'push-on': async () => { await enablePush(); toast('Push включены', 'good'); fillPush(); },
  'push-off': async () => { await disablePush(); toast('Push выключены'); fillPush(); },
  logout: async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    S.user = null; S.groups = []; S.groupsLoaded = false; S.ev = {}; location.hash = '#/'; showAuth();
  },
};

/* ============ формы (data-form) ============ */
async function submitForm(f, fn) {
  const btn = $('button[type=submit]', f), err = $('.err', f);
  if (err) err.textContent = '';
  if (btn) btn.disabled = true;
  try { await fn(new FormData(f)); }
  catch (e) { if (err) err.textContent = e.message; else toast(e.message, 'bad'); }
  finally { if (btn) btn.disabled = false; }
}
const F = {
  login: (f) => submitForm(f, async (d) => { S.user = (await api('POST', '/api/auth/login', { login: d.get('login'), password: d.get('password') })).user; await enter(); }),
  register: (f) => submitForm(f, async (d) => {
    S.user = (await api('POST', '/api/auth/register', { username: d.get('username'), email: d.get('email'), nickname: d.get('nickname'), password: d.get('password') })).user;
    await enter(); toast('Аккаунт создан. Теперь создайте группу', 'good');
  }),
  event: (f) => submitForm(f, async (d) => {
    const body = { title: d.get('title'), startsAt: new Date(d.get('when')).toISOString(), location: d.get('location'), description: d.get('description'), remindBefore: d.getAll('rem').map(Number) };
    if (f.dataset.id) await api('PATCH', `/api/events/${f.dataset.id}`, body);
    else await api('POST', `/api/groups/${d.get('group')}/events`, body);
    closeSheet(); toast(f.dataset.id ? 'Встреча обновлена' : 'Встреча создана, участники уведомлены', 'good'); await refresh();
  }),
  group: (f) => submitForm(f, async (d) => {
    const { group } = await api('POST', '/api/groups', { name: d.get('name') });
    closeSheet(); await loadGroups().catch(() => {}); go('#/group/' + group.id);
  }),
  rename: (f) => submitForm(f, async (d) => { await api('PATCH', `/api/groups/${S.cur.id}`, { name: d.get('name') }); closeSheet(); await refresh(); }),
  nick: (f) => submitForm(f, async (d) => { S.user = (await api('PATCH', '/api/me', { nickname: d.get('nickname') })).user; toast('Никнейм обновлён', 'good'); profileView(); }),
  pass: (f) => submitForm(f, async (d) => { await api('POST', '/api/me/password', { current: d.get('current'), next: d.get('next') }); f.reset(); toast('Пароль изменён, остальные устройства вышли', 'good'); }),
};

/* ============ обработчики и запуск ============ */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = A[el.dataset.act]; if (!fn) return;
  try { await fn(el, e); } catch (err) { toast(err.message, 'bad'); }
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault();
  if (F[f.dataset.form]) F[f.dataset.form](f);
});
document.addEventListener('input', (e) => { if (e.target.id === 'addq') searchUsers(e.target.value); });
document.addEventListener('change', async (e) => {
  if (e.target.id !== 'avfile' || !e.target.files[0]) return;
  try {
    const blob = await toAvatarBlob(e.target.files[0]);
    const r = await api('PUT', '/api/me/avatar', blob);
    S.user.avatarV = r.avatarV; toast('Аватарка обновлена', 'good'); profileView();
  } catch (err) { toast(err.message, 'bad'); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
  if (e.key === 'Enter' && e.target.matches && e.target.matches('article[data-act]')) e.target.click();
});
window.addEventListener('hashchange', () => renderRoute());
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.user) loadNotifs().catch(() => {}); });
setInterval(() => { if (S.user && !document.hidden) loadNotifs().catch(() => {}); }, 60000);

async function boot() {
  initDefs();
  $('#app').innerHTML = `<div class="splash">${flame(3, { size: 110, num: false })}<h1 class="title chrome">Календарик</h1><p id="splash-p">Загружаю</p></div>`;
  // Бесплатный сервис Render засыпает после простоя и просыпается до минуты: честно об этом говорим
  const slow = setTimeout(() => { const p = $('#splash-p'); if (p) p.textContent = 'Сервер просыпается после простоя, это занимает до минуты. Ваши данные в безопасности.'; }, 3500);
  try { S.user = (await api('GET', '/api/me')).user; }
  catch (e) {
    clearTimeout(slow);
    if (e.status === 401) { showAuth(); return; }
    $('#app').innerHTML = `<div class="splash">${flame(0, { size: 90, num: false })}<h2 class="h2">Нет связи с сервером</h2><p>${esc(e.message)}</p><button class="btn pri" data-act="retry-boot">Повторить</button></div>`;
    return;
  }
  clearTimeout(slow);
  await enter();
}
initTilt();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
