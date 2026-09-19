'use strict';
const { migrate, pool } = require('./db');
const { createApp } = require('./app');
const { tick } = require('./logic');

const PORT = Number(process.env.PORT) || 3000; // Render передаёт порт через PORT
const HOST = '0.0.0.0';                        // и требует слушать на всех интерфейсах

async function main() {
  await migrate();
  const app = createApp();
  const server = app.listen(PORT, HOST, () => console.log(`[server] слушаю ${HOST}:${PORT}`));
  // Таймауты больше, чем у прокси Render, иначе бывают случайные 502
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  // Пока сервис бодрствует — тикаем раз в минуту. Проснувшись после сна,
  // сразу догоняем всё пропущенное. (Тик идемпотентен, см. logic.js)
  const runTick = () => tick().catch((e) => console.error('[tick]', e.message));
  runTick();
  const timer = setInterval(runTick, 60 * 1000);

  // Render шлёт SIGTERM при деплое/перезапуске: закрываемся аккуратно
  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    console.log(`[server] ${sig}: останавливаюсь`);
    clearInterval(timer);
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
main().catch((e) => { console.error('[fatal]', e); process.exit(1); });
