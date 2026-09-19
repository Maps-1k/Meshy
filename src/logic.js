'use strict';
const { pool } = require('./db');
const { notifyUsers } = require('./notify');

const monthKey = (d) => new Date(d).toISOString().slice(0, 7); // YYYY-MM (UTC)
const CHECKIN_WINDOW_AFTER_H = 6; // встреча автоматически закрывается через 6 ч после начала

/**
 * Итог встречи и огонёк группы.
 *  - пришли все            -> огонёк +1                      (result = success)
 *  - пришли не все, резист
 *    в этом месяце свободен -> огонёк не меняется, резист тратится (saved)
 *  - пришли не все, резист
 *    уже потрачен           -> огонёк обнуляется               (broken)
 *  - в группе меньше 2 человек -> не считается               (solo)
 * Транзакция + FOR UPDATE: двойной вызов (кроны, гонки) безопасен.
 */
async function finalizeEvent(eventId) {
  const client = await pool.connect();
  let out = null;
  let notifyIds = [];
  let msg = null;
  try {
    await client.query('BEGIN');
    const ev = (await client.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [eventId])).rows[0];
    if (!ev || ev.status === 'finished') {
      await client.query('ROLLBACK');
      return null;
    }
    const c = (await client.query('SELECT * FROM circles WHERE id=$1 FOR UPDATE', [ev.group_id])).rows[0];
    const members = (await client.query('SELECT user_id FROM group_members WHERE group_id=$1', [c.id])).rows.map((r) => r.user_id);
    const present = new Set((await client.query('SELECT user_id FROM checkins WHERE event_id=$1', [eventId])).rows.map((r) => r.user_id));
    const allCame = members.length >= 2 && members.every((m) => present.has(m));
    const month = monthKey(ev.starts_at);

    const prev = c.streak;
    let streak = c.streak;
    let resistMonth = c.resist_month;
    let result;
    if (members.length < 2) result = 'solo';
    else if (allCame) { result = 'success'; streak += 1; }
    else if (resistMonth !== month) { result = 'saved'; resistMonth = month; }
    else { result = 'broken'; streak = 0; }

    const best = Math.max(c.best_streak, streak);
    await client.query('UPDATE circles SET streak=$2, best_streak=$3, resist_month=$4 WHERE id=$1', [c.id, streak, best, resistMonth]);
    await client.query(`UPDATE events SET status='finished', result=$2, finished_at=now() WHERE id=$1`, [eventId, result]);
    await client.query('COMMIT');

    out = { eventId, groupId: c.id, groupName: c.name, result, prevStreak: prev, streak, bestStreak: best, present: present.size, total: members.length };
    notifyIds = members;
    const url = '/#/group/' + c.id;
    if (result === 'success') msg = { kind: 'streak', title: `🔥 Огонёк вырос до ${streak}`, body: `${c.name}: встреча состоялась, пришли все`, data: { url } };
    else if (result === 'saved') msg = { kind: 'resist', title: '🛡 Резист спас огонёк', body: `${c.name}: не все пришли, но огонёк остался на ${streak}. Резист в этом месяце потрачен`, data: { url } };
    else if (result === 'broken') msg = { kind: 'broken', title: '💔 Огонёк погас', body: `${c.name}: не все пришли, резист уже потрачен. Серия ${prev} сброшена`, data: { url } };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (msg) await notifyUsers(notifyIds, msg).catch((e) => console.error('[notify]', e.message));
  return out;
}

function reminderLabel(min) {
  if (min >= 1440) return `через ${Math.round(min / 1440)} дн.`;
  if (min >= 60) return `через ${Math.round(min / 60)} ч`;
  return `через ${min} мин`;
}

/** Пересоздаёт напоминания события (только те, что ещё впереди). */
async function replaceReminders(client, eventId, startsAt, minutes) {
  await client.query('DELETE FROM event_reminders WHERE event_id=$1', [eventId]);
  for (const m of minutes) {
    const at = new Date(new Date(startsAt).getTime() - m * 60000);
    if (at.getTime() > Date.now()) {
      await client.query(
        'INSERT INTO event_reminders(event_id, minutes, notify_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [eventId, m, at]
      );
    }
  }
}

let ticking = false;
/**
 * Идемпотентный «тик»: отправляет созданные к этому моменту напоминания
 * и закрывает просроченные встречи. Его безопасно вызывать откуда угодно и
 * сколько угодно раз: из setInterval веб-процесса, из Render Cron Job или
 * с внешнего пингера (/api/tick). Каждое напоминание «забирается» атомарным
 * UPDATE ... RETURNING, поэтому дублей не будет.
 */
async function tick() {
  if (ticking) return { skipped: true };
  ticking = true;
  const stats = { reminders: 0, finalized: 0 };
  try {
    const due = (
      await pool.query(
        `UPDATE event_reminders SET sent_at = now()
          WHERE sent_at IS NULL AND notify_at <= now()
        RETURNING event_id, minutes`
      )
    ).rows;
    for (const r of due) {
      const ev = (
        await pool.query(
          `SELECT e.id, e.title, e.group_id, c.name
             FROM events e JOIN circles c ON c.id = e.group_id
            WHERE e.id=$1 AND e.status='planned' AND e.starts_at > now()`,
          [r.event_id]
        )
      ).rows[0];
      if (!ev) continue; // событие уже удалено/началось — «протухшее» напоминание не шлём
      const ids = (await pool.query('SELECT user_id FROM group_members WHERE group_id=$1', [ev.group_id])).rows.map((x) => x.user_id);
      await notifyUsers(ids, {
        kind: 'reminder',
        title: `⏰ ${ev.title}`,
        body: `${ev.name}: ${reminderLabel(r.minutes)}`,
        data: { url: '/#/group/' + ev.group_id, eventId: ev.id },
        tag: 'ev' + ev.id,
      });
      stats.reminders++;
    }

    const over = (
      await pool.query(
        `SELECT id FROM events
          WHERE status IN ('planned','live') AND starts_at < now() - make_interval(hours => $1)
          ORDER BY starts_at LIMIT 50`,
        [CHECKIN_WINDOW_AFTER_H]
      )
    ).rows;
    for (const o of over) {
      try {
        if (await finalizeEvent(o.id)) stats.finalized++;
      } catch (e) {
        console.error('[tick] finalize', o.id, e.message);
      }
    }
  } finally {
    ticking = false;
  }
  return stats;
}

module.exports = { finalizeEvent, replaceReminders, tick, monthKey, CHECKIN_WINDOW_AFTER_H };
