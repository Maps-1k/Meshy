'use strict';
/** Запуск одного тика: `node src/cron.js` (Render Cron Job, раз в 5 минут). */
const { migrate, pool } = require('./db');
const { tick } = require('./logic');

(async () => {
  await migrate();
  const r = await tick();
  console.log('[cron] tick', JSON.stringify(r));
  await pool.end();
})().catch((e) => { console.error('[cron] ошибка', e); process.exit(1); });
