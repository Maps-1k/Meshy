'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');
const { notifyUsers, publicKey } = require('./notify');
const { finalizeEvent, replaceReminders, tick, monthKey, CHECKIN_WINDOW_AFTER_H } = require('./logic');

const PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || (PROD ? '' : 'dev-only-secret');
if (!JWT_SECRET) throw new Error('JWT_SECRET обязателен в production');
const COOKIE = 'cal_sid';
const MAX_GROUP_SIZE = 30;
const REMIND_ALLOWED = [5, 10, 30, 60, 180, 1440, 2880];

/* ---------- утилиты ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const idOf = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Некорректный id');
  return n;
};
const secret = () => crypto.randomBytes(18).toString('base64url');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanMultiline = (s, max) => String(s ?? '').replace(/\r/g, '').trim().slice(0, max);
const baseUrl = (req) => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const publicUser = (u) => ({ id: u.id, username: u.username, nickname: u.nickname, avatarV: u.avatar_v });

/* ---------- авторизация (stateless JWT в httpOnly cookie) ---------- */
function issueToken(req, res, user) {
  const token = jwt.sign({ sub: user.id, tv: user.token_v }, JWT_SECRET, { expiresIn: '60d' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 60 * 24 * 3600 * 1000, path: '/' });
}
async function auth(req, res, next) {
  let payload;
  try {
    const t = req.cookies[COOKIE] || (req.headers.authorization || '').replace(/^Bearer /, '');
    payload = jwt.verify(t, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Требуется вход' });
  }
  try {
    const u = (await pool.query('SELECT id, username, email, nickname, avatar_v, token_v FROM users WHERE id=$1', [payload.sub])).rows[0];
    if (!u || u.token_v !== payload.tv) return res.status(401).json({ error: 'Сессия устарела, войдите заново' });
    req.user = u;
    next();
  } catch (e) { next(e); }
}

/* ---------- доступ к группам ---------- */
async function mineCircle(userId, circleId) {
  const r = await pool.query(
    'SELECT c.* FROM circles c JOIN group_members m ON m.group_id=c.id WHERE c.id=$1 AND m.user_id=$2',
    [circleId, userId]
  );
  if (!r.rows[0]) throw new HttpError(404, 'Группа не найдена');
  return r.rows[0];
}
const leaderOnly = (c, user) => {
  if (c.leader_id !== user.id) throw new HttpError(403, 'Это может сделать только лидер группы');
};
async function loadMembers(circleIds) {
  const rows = (
    await pool.query(
      `SELECT m.group_id, u.id, u.username, u.nickname, u.avatar_v AS "avatarV"
         FROM group_members m JOIN users u ON u.id = m.user_id
        WHERE m.group_id = ANY($1::bigint[]) ORDER BY m.joined_at, u.id`,
      [circleIds]
    )
  ).rows;
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.group_id)) map.set(r.group_id, []);
    map.get(r.group_id).push({ id: r.id, username: r.username, nickname: r.nickname, avatarV: r.avatarV });
  }
  return map;
}
const circleDto = (c, members, meId) => ({
  id: c.id,
  name: c.name,
  leaderId: c.leader_id,
  isLeader: c.leader_id === meId,
  streak: c.streak,
  bestStreak: c.best_streak,
  resistAvailable: c.resist_month !== monthKey(new Date()),
  members: members || [],
  nextEvent: c.next_event || null,
});

const EVENT_SQL = `
  SELECT e.id, e.group_id AS "groupId", c.name AS "groupName", e.title, e.description, e.location,
         e.starts_at AS "startsAt", e.remind_before AS "remindBefore", e.status, e.result,
         ARRAY(SELECT k.user_id::int FROM checkins k WHERE k.event_id = e.id) AS "presentIds",
         (SELECT count(*) FROM group_members g2 WHERE g2.group_id = e.group_id) AS total
    FROM events e JOIN circles c ON c.id = e.group_id`;

function parseRemind(v) {
  if (v === undefined) return [60];
  if (!Array.isArray(v)) throw new HttpError(400, 'Некорректные напоминания');
  return [...new Set(v.map(Number))].filter((n) => REMIND_ALLOWED.includes(n)).sort((a, b) => a - b);
}
function parseStart(v, allowPast) {
  const d = new Date(v);
  if (isNaN(d)) throw new HttpError(400, 'Укажите дату и время события');
  if (!allowPast && d.getTime() < Date.now() - 5 * 60000) throw new HttpError(400, 'Дата события уже прошла');
  return d;
}

/* ---------- приложение ---------- */
function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render стоит за своим прокси: нужен реальный IP и req.secure
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          manifestSrc: ["'self'"],
          workerSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(PROD ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '50kb' }));

  // Проверка живости для Render (без обращения к БД, чтобы не уронить сервис из-за БД)
  app.get('/healthz', (req, res) => res.type('text').send('ok'));

  const api = express.Router();
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Слишком много попыток. Подождите несколько минут' } });
  const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: true, legacyHeaders: false });
  api.use(apiLimiter);

  /* --- внешний «будильник» для бесплатного тарифа Render --- */
  api.all('/tick', wrap(async (req, res) => {
    const key = process.env.CRON_SECRET;
    if (!key) throw new HttpError(404, 'Не найдено');
    const given = req.get('x-cron-key') || req.query.key || '';
    if (!safeEq(given, key)) throw new HttpError(403, 'Нет доступа');
    res.json({ ok: true, ...(await tick()) });
  }));

  /* --- аккаунт --- */
  api.post('/auth/register', authLimiter, wrap(async (req, res) => {
    const username = clean(req.body.username, 40).toLowerCase().replace(/^@/, '');
    const email = clean(req.body.email, 120).toLowerCase();
    const password = String(req.body.password || '');
    const nickname = clean(req.body.nickname, 30) || username;
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Юзернейм: 3–20 символов, латиница, цифры и _');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Проверьте адрес почты');
    if (password.length < 8 || password.length > 100) throw new HttpError(400, 'Пароль должен быть от 8 символов');
    const hash = await bcrypt.hash(password, 10);
    try {
      const u = (await pool.query(
        `INSERT INTO users(username, email, password_hash, nickname) VALUES($1,$2,$3,$4)
         RETURNING id, username, email, nickname, avatar_v, token_v`,
        [username, email, hash, nickname]
      )).rows[0];
      issueToken(req, res, u);
      res.status(201).json({ user: { ...publicUser(u), email: u.email } });
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, /email/.test(e.constraint || '') ? 'Эта почта уже зарегистрирована' : 'Этот юзернейм уже занят');
      throw e;
    }
  }));

  const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);
  api.post('/auth/login', authLimiter, wrap(async (req, res) => {
    const login = clean(req.body.login, 120).toLowerCase().replace(/^@/, '');
    const password = String(req.body.password || '');
    const u = (await pool.query('SELECT * FROM users WHERE username=$1 OR email=$1', [login])).rows[0];
    const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok) throw new HttpError(401, 'Неверный логин или пароль');
    issueToken(req, res, u);
    res.json({ user: { ...publicUser(u), email: u.email } });
  }));

  api.post('/auth/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });

  api.get('/me', auth, (req, res) => res.json({ user: { ...publicUser(req.user), email: req.user.email } }));

  api.patch('/me', auth, wrap(async (req, res) => {
    const nickname = clean(req.body.nickname, 30);
    if (nickname.length < 1) throw new HttpError(400, 'Никнейм не может быть пустым');
    await pool.query('UPDATE users SET nickname=$2 WHERE id=$1', [req.user.id, nickname]);
    res.json({ user: { ...publicUser({ ...req.user, nickname }), email: req.user.email } });
  }));

  api.post('/me/password', auth, authLimiter, wrap(async (req, res) => {
    const cur = String(req.body.current || '');
    const next = String(req.body.next || '');
    if (next.length < 8 || next.length > 100) throw new HttpError(400, 'Новый пароль должен быть от 8 символов');
    const row = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
    if (!(await bcrypt.compare(cur, row.password_hash))) throw new HttpError(403, 'Текущий пароль указан неверно');
    const hash = await bcrypt.hash(next, 10);
    // token_v++ выкидывает все остальные устройства, текущее получает новый токен
    const u = (await pool.query('UPDATE users SET password_hash=$2, token_v=token_v+1 WHERE id=$1 RETURNING id, token_v', [req.user.id, hash])).rows[0];
    issueToken(req, res, u);
    res.json({ ok: true });
  }));

  // Аватарка: клиент уменьшает до 256×256 JPEG; храним в БД (диск Render временный)
  const sniff = (b) => {
    if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
    return null;
  };
  api.put('/me/avatar', auth, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '400kb' }), wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Пришлите изображение JPEG, PNG или WebP до 400 КБ');
    const mime = sniff(req.body);
    if (!mime) throw new HttpError(400, 'Неподдерживаемый формат изображения');
    const r = await pool.query('UPDATE users SET avatar=$2, avatar_mime=$3, avatar_v=avatar_v+1 WHERE id=$1 RETURNING avatar_v', [req.user.id, req.body, mime]);
    res.json({ avatarV: r.rows[0].avatar_v });
  }));

  api.get('/users/:id/avatar', auth, wrap(async (req, res) => {
    const r = (await pool.query('SELECT avatar, avatar_mime FROM users WHERE id=$1', [idOf(req.params.id)])).rows[0];
    if (!r || !r.avatar) throw new HttpError(404, 'Нет аватарки');
    res.set('Cache-Control', 'private, max-age=31536000, immutable').type(r.avatar_mime).send(r.avatar);
  }));

  api.get('/users/search', auth, wrap(async (req, res) => {
    const q = clean(req.query.q, 40).toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '');
    if (q.length < 2) return res.json({ users: [] });
    const rows = (await pool.query(
      `SELECT id, username, nickname, avatar_v AS "avatarV" FROM users
        WHERE username LIKE $1 AND id <> $2
        ORDER BY (username = $3) DESC, username LIMIT 10`,
      [q.replace(/_/g, '\\_') + '%', req.user.id, q]
    )).rows;
    res.json({ users: rows });
  }));

  /* --- группы --- */
  api.get('/groups', auth, wrap(async (req, res) => {
    const rows = (await pool.query(
      `SELECT c.*,
              (SELECT row_to_json(x) FROM (
                 SELECT e.id, e.title, e.starts_at AS "startsAt", e.status FROM events e
                  WHERE e.group_id = c.id AND e.status IN ('planned','live')
                    AND e.starts_at > now() - make_interval(hours => $2)
                  ORDER BY e.starts_at LIMIT 1) x) AS next_event
         FROM circles c JOIN group_members m ON m.group_id = c.id
        WHERE m.user_id = $1 ORDER BY c.streak DESC, c.created_at`,
      [req.user.id, CHECKIN_WINDOW_AFTER_H]
    )).rows;
    const members = await loadMembers(rows.map((r) => r.id));
    res.json({ groups: rows.map((c) => circleDto(c, members.get(c.id), req.user.id)) });
  }));

  api.post('/groups', auth, wrap(async (req, res) => {
    const name = clean(req.body.name, 40);
    if (!name) throw new HttpError(400, 'Назовите группу');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const c = (await client.query('INSERT INTO circles(name, leader_id, tag_secret) VALUES($1,$2,$3) RETURNING *', [name, req.user.id, secret()])).rows[0];
      await client.query('INSERT INTO group_members(group_id, user_id) VALUES($1,$2)', [c.id, req.user.id]);
      await client.query('COMMIT');
      const members = await loadMembers([c.id]);
      res.status(201).json({ group: circleDto(c, members.get(c.id), req.user.id) });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));

  api.get('/groups/:id', auth, wrap(async (req, res) => {
    const c = await mineCircle(req.user.id, idOf(req.params.id));
    const members = await loadMembers([c.id]);
    const events = (await pool.query(
      `${EVENT_SQL} WHERE e.group_id = $1 AND e.starts_at > now() - interval '60 days' ORDER BY e.starts_at DESC LIMIT 60`,
      [c.id]
    )).rows;
    res.json({ group: circleDto(c, members.get(c.id), req.user.id), events });
  }));

  api.patch('/groups/:id', auth, wrap(async (req, res) => {
    const c = await mineCircle(req.user.id, idOf(req.params.id));
    leaderOnly(c, req.user);
    const name = clean(req.body.name, 40);
    if (!name) throw new HttpError(400, 'Назовите группу');
    await pool.query('UPDATE circles SET name=$2 WHERE id=$1', [c.id, name]);
    res.json({ ok: true });
  }));

  api.delete('/groups/:id', auth, wrap(async (req, res) => {
    const c = await mineCircle(req.user.id, idOf(req.params.id));
    leaderOnly(c, req.user);
    const ids = (await pool.query('SELECT user_id FROM group_members WHERE group_id=$1', [c.id])).rows.map((r) => r.user_id).filter((i) => i !== req.user.id);
    await pool.query('DELETE FROM circles WHERE id=$1', [c.id]);
    await notifyUsers(ids, { kind: 'info', title: 'Группа удалена', body: `Лидер удалил группу «${c.name}»`, data: { url: '/#/groups' } });
    res.json({ ok: true });
  }));

  api.post('/groups/:id/members', auth, wrap(async (req, res) => {
    const c = await mineCircle(req.user.id, idOf(req.params.id));
    leaderOnly(c, req.user);
    const uname = clean(req.body.username, 40).toLowerCase().replace(/^@/, '');
    const u = (await pool.query('SELECT id, username, nickname, avatar_v AS "avatarV" FROM users WHERE username=$1', [uname])).rows[0];
    if (!u) throw new HttpError(404, 'Пользователь с таким юзернеймом не найден');
    const count = (await pool.query('SELECT count(*) AS n FROM group_members WHERE group_id=$1', [c.id])).rows[0].n;
    if (count >= MAX_GROUP_SIZE) throw new HttpError(400, `В группе не больше ${MAX_GROUP_SIZE} человек`);
    const ins = await pool.query('INSERT INTO group_members(group_id, user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING user_id', [c.id, u.id]);
    if (!ins.rows[0]) throw new HttpError(409, 'Этот человек уже в группе');
    await notifyUsers([u.id], { kind: 'invite', title: 'Вас добавили в группу', body: `«${c.name}», лидер ${req.user.nickname}`, data: { url: '/#/group/' + c.id } });
    res.status(201).json({ member: u });
  }));

  api.delete('/groups/:id/members/:uid', auth, wrap(async (req, res) => {
    const c = await mineCircle(req.user.id, idOf(req.params.id));
    const uid = idOf(req.params.uid);
    if (uid === c.leader_id) throw new HttpError(400, 'Лидер не может выйти: передайте лидерство или удалите группу');
    if (uid !== req.user.id) leaderOnly(c, req.user);
    const del = await pool.query('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2 RETURNING user_id', [c.id, uid]);
    if (!del.rows[0]) throw new HttpError(404, 'Участник не найден');
    if (uid !== req.user.id) await notifyUsers([uid], { kind: 'info', title: 'Вас убрали из группы', body: `«${c.name}»`, data: { url: '/#/groups' } });
    res.json({ ok: true });
  }));

  // Передача лидерства: все права следуют за leader_id, а метка обновляется,
  // чтобы старый лидер больше не мог подтверждать встречи.
  api.post('/groups/:id/transfer', auth, wrap(async (req, res) => {
    const c = await mineCircle(req.user.id, idOf(req.params.id));
    leaderOnly(c, req.user);
    const to = idOf(req.body.userId);
    if (to === c.leader_id) throw new HttpError(400, 'Вы и так лидер');
    const isMember = (await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2', [c.id, to])).rows[0];
    if (!isMember) throw new HttpError(400, 'Новый лидер должен быть участником группы');
    await pool.query('UPDATE circles SET leader_id=$2, tag_secret=$3 WHERE id=$1', [c.id, to, secret()]);
    await notifyUsers([to], { kind: 'leader', title: 'Вы теперь лидер группы', body: `«${c.name}»: вам переданы все права. Запишите новую NFC-метку`, data: { url: '/#/group/' + c.id } });
    res.json({ ok: true });
  }));

  /* --- NFC-метка группы --- */
  api.get('/groups/:id/tag', auth, wrap(async (req, res) => {
    const c = await mineCircle(req.user.id, idOf(req.params.id));
    leaderOnly(c, req.user);
    res.json({ url: `${baseUrl(req)}/#/tap/${c.tag_secret}` });
  }));
  api.post('/groups/:id/tag/rotate', auth, wrap(async (req, res) => {
    const c = await mineCircle(req.user.id, idOf(req.params.id));
    leaderOnly(c, req.user);
    const s = secret();
    await pool.query('UPDATE circles SET tag_secret=$2 WHERE id=$1', [c.id, s]);
    res.json({ url: `${baseUrl(req)}/#/tap/${s}` });
  }));

  /**
   * Касание NFC-метки. Метка хранит ссылку /#/tap/<secret> — её открывает и
   * iPhone (нативное чтение NDEF), и Android, и кнопка «Считать» в приложении.
   * 1) Лидер касается первым — встреча начинается (status = live).
   * 2) Остальные касаются — отмечаются как пришедшие.
   * 3) Когда отметились все — встреча закрывается сразу и огонёк считается.
   */
  api.post('/tap', auth, wrap(async (req, res) => {
    const s = String(req.body.secret || '');
    const c = s ? (await pool.query('SELECT * FROM circles WHERE tag_secret=$1', [s])).rows[0] : null;
    if (!c) throw new HttpError(404, 'Метка не распознана. Возможно, лидер её обновил — попросите новую');
    const mem = (await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2', [c.id, req.user.id])).rows[0];
    if (!mem) throw new HttpError(403, 'Вы не участник этой группы');
    const ev = (await pool.query(
      `SELECT * FROM events
        WHERE group_id=$1 AND status IN ('planned','live')
          AND starts_at BETWEEN now() - make_interval(hours => $2) AND now() + interval '3 hours'
        ORDER BY abs(extract(epoch FROM (starts_at - now()))) LIMIT 1`,
      [c.id, CHECKIN_WINDOW_AFTER_H]
    )).rows[0];
    if (!ev) throw new HttpError(404, `Сейчас в группе нет встречи: метка работает с 3 часов до начала и ${CHECKIN_WINDOW_AFTER_H} ч после`);

    const isLeader = c.leader_id === req.user.id;
    let opened = false;
    if (ev.status === 'planned') {
      if (!isLeader) throw new HttpError(409, 'Лидер ещё не начал встречу. Пусть он первым приложит телефон к метке');
      const u = await pool.query(`UPDATE events SET status='live', opened_at=now() WHERE id=$1 AND status='planned' RETURNING id`, [ev.id]);
      opened = !!u.rows[0];
      if (opened) {
        const others = (await pool.query('SELECT user_id FROM group_members WHERE group_id=$1 AND user_id<>$2', [c.id, req.user.id])).rows.map((r) => r.user_id);
        await notifyUsers(others, { kind: 'live', title: `📍 Встреча началась: ${ev.title}`, body: `«${c.name}»: приложите телефон к NFC-метке`, data: { url: '/#/group/' + c.id }, tag: 'live' + ev.id });
      }
    }
    await pool.query('INSERT INTO checkins(event_id, user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [ev.id, req.user.id]);
    const cnt = (await pool.query(
      `SELECT (SELECT count(*) FROM checkins WHERE event_id=$1) AS present,
              (SELECT count(*) FROM group_members WHERE group_id=$2) AS total`,
      [ev.id, c.id]
    )).rows[0];
    let finalized = null;
    if (cnt.total >= 2 && cnt.present >= cnt.total) finalized = await finalizeEvent(ev.id);
    const fresh = (await pool.query('SELECT streak, best_streak FROM circles WHERE id=$1', [c.id])).rows[0];
    res.json({
      opened, isLeader, finalized,
      event: { id: ev.id, title: ev.title, startsAt: ev.starts_at },
      group: { id: c.id, name: c.name, streak: fresh.streak, bestStreak: fresh.best_streak },
      present: cnt.present, total: cnt.total,
    });
  }));

  /* --- события --- */
  api.get('/events', auth, wrap(async (req, res) => {
    const from = new Date(String(req.query.from)); const to = new Date(String(req.query.to));
    if (isNaN(from) || isNaN(to) || to <= from || to - from > 70 * 86400000) throw new HttpError(400, 'Некорректный период');
    const events = (await pool.query(
      `${EVENT_SQL} JOIN group_members m ON m.group_id = c.id AND m.user_id = $1
        WHERE e.starts_at >= $2 AND e.starts_at < $3 ORDER BY e.starts_at`,
      [req.user.id, from, to]
    )).rows;
    res.json({ events });
  }));

  api.post('/groups/:id/events', auth, wrap(async (req, res) => {
    const c = await mineCircle(req.user.id, idOf(req.params.id));
    leaderOnly(c, req.user);
    const title = clean(req.body.title, 80);
    if (!title) throw new HttpError(400, 'Назовите событие');
    const startsAt = parseStart(req.body.startsAt, false);
    const remind = parseRemind(req.body.remindBefore);
    const client = await pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      id = (await client.query(
        `INSERT INTO events(group_id, title, description, location, starts_at, remind_before, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [c.id, title, cleanMultiline(req.body.description, 500), clean(req.body.location, 100), startsAt, remind, req.user.id]
      )).rows[0].id;
      await replaceReminders(client, id, startsAt, remind);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    const others = (await pool.query('SELECT user_id FROM group_members WHERE group_id=$1 AND user_id<>$2', [c.id, req.user.id])).rows.map((r) => r.user_id);
    await notifyUsers(others, { kind: 'event', title: `📅 Новая встреча: ${title}`, body: `«${c.name}»`, data: { url: '/#/group/' + c.id, eventId: id } });
    const ev = (await pool.query(`${EVENT_SQL} WHERE e.id=$1`, [id])).rows[0];
    res.status(201).json({ event: ev });
  }));

  async function eventForLeader(req) {
    const e = (await pool.query('SELECT * FROM events WHERE id=$1', [idOf(req.params.id)])).rows[0];
    if (!e) throw new HttpError(404, 'Событие не найдено');
    const c = await mineCircle(req.user.id, e.group_id);
    leaderOnly(c, req.user);
    return { e, c };
  }

  api.patch('/events/:id', auth, wrap(async (req, res) => {
    const { e, c } = await eventForLeader(req);
    if (e.status !== 'planned') throw new HttpError(409, 'Встречу, которая уже началась, изменить нельзя');
    const title = req.body.title !== undefined ? clean(req.body.title, 80) : e.title;
    if (!title) throw new HttpError(400, 'Назовите событие');
    const startsAt = req.body.startsAt !== undefined ? parseStart(req.body.startsAt, false) : e.starts_at;
    const remind = req.body.remindBefore !== undefined ? parseRemind(req.body.remindBefore) : e.remind_before;
    const desc = req.body.description !== undefined ? cleanMultiline(req.body.description, 500) : e.description;
    const loc = req.body.location !== undefined ? clean(req.body.location, 100) : e.location;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE events SET title=$2, description=$3, location=$4, starts_at=$5, remind_before=$6 WHERE id=$1', [e.id, title, desc, loc, startsAt, remind]);
      await replaceReminders(client, e.id, startsAt, remind);
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
    if (new Date(startsAt).getTime() !== new Date(e.starts_at).getTime()) {
      const others = (await pool.query('SELECT user_id FROM group_members WHERE group_id=$1 AND user_id<>$2', [c.id, req.user.id])).rows.map((r) => r.user_id);
      await notifyUsers(others, { kind: 'event', title: `🕒 Время изменено: ${title}`, body: `«${c.name}»`, data: { url: '/#/group/' + c.id } });
    }
    res.json({ event: (await pool.query(`${EVENT_SQL} WHERE e.id=$1`, [e.id])).rows[0] });
  }));

  api.delete('/events/:id', auth, wrap(async (req, res) => {
    const { e, c } = await eventForLeader(req);
    if (e.status !== 'planned') throw new HttpError(409, 'Начавшуюся встречу удалить нельзя');
    await pool.query('DELETE FROM events WHERE id=$1', [e.id]);
    const others = (await pool.query('SELECT user_id FROM group_members WHERE group_id=$1 AND user_id<>$2', [c.id, req.user.id])).rows.map((r) => r.user_id);
    await notifyUsers(others, { kind: 'event', title: `Встреча отменена: ${e.title}`, body: `«${c.name}»`, data: { url: '/#/group/' + c.id } });
    res.json({ ok: true });
  }));

  // Лидер может закрыть встречу вручную (кто не отметился — считается отсутствующим)
  api.post('/events/:id/finish', auth, wrap(async (req, res) => {
    const { e } = await eventForLeader(req);
    if (e.status !== 'live') throw new HttpError(409, 'Встреча ещё не началась: сначала приложите телефон к NFC-метке');
    const finalized = await finalizeEvent(e.id);
    if (!finalized) throw new HttpError(409, 'Встреча уже закрыта');
    res.json({ finalized });
  }));

  /* --- уведомления и push --- */
  api.get('/notifications', auth, wrap(async (req, res) => {
    const rows = (await pool.query(
      `SELECT id, kind, title, body, data, created_at AS "createdAt", read_at IS NOT NULL AS read
         FROM notifications WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT 60`,
      [req.user.id]
    )).rows;
    const unread = (await pool.query('SELECT count(*) AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [req.user.id])).rows[0].n;
    res.json({ notifications: rows, unread });
  }));
  api.post('/notifications/read', auth, wrap(async (req, res) => {
    await pool.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);
    res.json({ ok: true });
  }));
  api.get('/push/key', auth, (req, res) => res.json({ key: publicKey() }));
  api.post('/push/subscribe', auth, wrap(async (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys || !keys.p256dh || !keys.auth || String(endpoint).length > 800) throw new HttpError(400, 'Некорректная подписка');
    await pool.query(
      `INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth) VALUES($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth`,
      [req.user.id, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ ok: true });
  }));
  api.post('/push/unsubscribe', auth, wrap(async (req, res) => {
    await pool.query('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [req.user.id, String(req.body.endpoint || '')]);
    res.json({ ok: true });
  }));

  api.use((req, res) => res.status(404).json({ error: 'Не найдено' }));
  app.use('/api', api);

  /* --- статика (фронтенд) --- */
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: '10m',
    setHeaders: (res, file) => {
      if (/(sw\.js|index\.html|manifest\.webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой файл' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный запрос' });
    console.error('[error]', req.method, req.originalUrl, err);
    res.status(500).json({ error: 'Что-то пошло не так на сервере. Попробуйте ещё раз' });
  });

  return app;
}

module.exports = { createApp };
