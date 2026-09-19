'use strict';
/**
 * Postgres. Ничего не хранится на диске сервера и в памяти процесса:
 * Render может усыпить/перезапустить сервис в любой момент, а файловая
 * система у web-сервиса временная. Аватарки лежат прямо в БД (bytea).
 */
const { Pool, types } = require('pg');

types.setTypeParser(20, (v) => parseInt(v, 10)); // bigint/count -> number

const url = process.env.DATABASE_URL;
if (!url) console.warn('[db] DATABASE_URL не задан');

// Внешний адрес Render Postgres (*.render.com) требует SSL, внутренний — нет.
const useSsl = url && (/render\.com/.test(url) || process.env.PGSSL === 'require');

const pool = new Pool({
  connectionString: url,
  max: Number(process.env.PG_POOL_MAX || 8),
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 15000,
  keepAlive: true,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});
// Render может оборвать простаивающее соединение — не даём процессу упасть.
pool.on('error', (e) => console.error('[db] idle client error:', e.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nickname      TEXT NOT NULL,
  avatar        BYTEA,
  avatar_mime   TEXT,
  avatar_v      INT  NOT NULL DEFAULT 0,
  token_v       INT  NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS circles (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  leader_id    BIGINT NOT NULL REFERENCES users(id),
  tag_secret   TEXT NOT NULL UNIQUE,
  streak       INT NOT NULL DEFAULT 0,
  best_streak  INT NOT NULL DEFAULT 0,
  resist_month TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  BIGINT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  user_id   BIGINT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS gm_user ON group_members(user_id);

CREATE TABLE IF NOT EXISTS events (
  id            BIGSERIAL PRIMARY KEY,
  group_id      BIGINT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  location      TEXT NOT NULL DEFAULT '',
  starts_at     TIMESTAMPTZ NOT NULL,
  remind_before INT[] NOT NULL DEFAULT '{60}',
  status        TEXT NOT NULL DEFAULT 'planned',   -- planned | live | finished
  result        TEXT,                              -- success | saved | broken | solo
  opened_at     TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ev_group_time ON events(group_id, starts_at);
CREATE INDEX IF NOT EXISTS ev_status ON events(status, starts_at);

-- Напоминания живут в БД: если сервис спал, при пробуждении всё, что
-- «просрочилось», подхватится (и отправится ровно один раз).
CREATE TABLE IF NOT EXISTS event_reminders (
  id        BIGSERIAL PRIMARY KEY,
  event_id  BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  minutes   INT NOT NULL,
  notify_at TIMESTAMPTZ NOT NULL,
  sent_at   TIMESTAMPTZ,
  UNIQUE (event_id, minutes)
);
CREATE INDEX IF NOT EXISTS er_due ON event_reminders(notify_at) WHERE sent_at IS NULL;

CREATE TABLE IF NOT EXISTS checkins (
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id  BIGINT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  data       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS nt_user ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ps_user ON push_subscriptions(user_id);
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Миграция безопасна при одновременном старте web и cron (advisory lock). */
async function migrate(attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    let c;
    try {
      c = await pool.connect();
      await c.query('SELECT pg_advisory_lock(424242)');
      try {
        await c.query(SCHEMA);
      } finally {
        await c.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
      }
      return;
    } catch (e) {
      console.error(`[db] migrate попытка ${i}/${attempts}: ${e.message}`);
      if (i === attempts) throw e;
      await sleep(2000 * i); // БД на Render может ещё просыпаться
    } finally {
      if (c) c.release();
    }
  }
}

module.exports = { pool, migrate };
