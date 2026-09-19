'use strict';
const webpush = require('web-push');
const { pool } = require('./db');

let pushOn = false;
const PUB = process.env.VAPID_PUBLIC_KEY;
const PRIV = process.env.VAPID_PRIVATE_KEY;
if (PUB && PRIV) {
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', PUB, PRIV);
    pushOn = true;
  } catch (e) {
    console.error('[push] некорректные VAPID-ключи, push отключён:', e.message);
  }
} else {
  console.warn('[push] VAPID-ключи не заданы — работают только уведомления внутри приложения');
}

const isPushEnabled = () => pushOn;
const publicKey = () => (pushOn ? PUB : null);

/**
 * Сохраняет уведомление в БД (его увидит каждый при следующем открытии
 * приложения — даже если push не дошёл) и рассылает Web Push.
 */
async function notifyUsers(userIds, n) {
  const ids = [...new Set((userIds || []).map(Number))].filter(Boolean);
  if (!ids.length) return;
  const { kind = 'info', title, body = '', data = {} } = n;

  await pool.query(
    `INSERT INTO notifications(user_id, kind, title, body, data)
     SELECT u, $2, $3, $4, $5::jsonb FROM unnest($1::bigint[]) AS u`,
    [ids, kind, title, body, JSON.stringify(data)]
  );

  if (!pushOn) return;
  const subs = (
    await pool.query(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::bigint[])',
      [ids]
    )
  ).rows;
  const payload = JSON.stringify({ title, body, url: data.url || '/', tag: n.tag });

  await Promise.allSettled(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 3600 }
        );
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [s.id]);
        } else {
          console.warn('[push] не отправлено:', e.statusCode || e.message);
        }
      }
    })
  );
}

module.exports = { notifyUsers, isPushEnabled, publicKey };
