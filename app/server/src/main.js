/**
 * AtoZ Content Studio v7 — server entrypoint.
 *
 * Boot order matters: env → db → seed defaults → queue recovery → HTTP.
 * A missing API key or a missing TTS engine is a *warning*, never a crash:
 * the studio always comes up in a usable local mode.
 */
import 'node:process';
import fs from 'node:fs';
import path from 'node:path';

/* Load .env before anything reads process.env (the AI service captures its
   config at import time). `process.loadEnvFile` is built into Node 22 — no
   dotenv dependency, and a missing file is simply ignored. */
for (const candidate of ['.env', path.join('..', '..', '.env')]) {
  if (fs.existsSync(candidate)) {
    try {
      process.loadEnvFile(candidate);
    } catch (err) {
      console.warn(`تحذیر: ${candidate} خوانده نشد — ${err.message}`);
    }
  }
}

import { buildApp } from './routes/index.js';
import { startWorker } from './services/queue.js';
import { ensurePuzzleBlocks, notify } from './services/repo.js';
import { getPrompts, AI_MODE } from './services/ai.js';
import { logEvent, DB_PATH } from './lib/db.js';
import { seedDemoIfEmpty } from './services/content.js';
import { loadBrand } from './services/brand.js';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main() {
  loadBrand();
  ensurePuzzleBlocks();
  getPrompts();

  if (process.env.ATOZ_SEED_DEMO === '1') {
    const result = seedDemoIfEmpty();
    if (result.seeded) logEvent('INFO', 'boot', 'داده نمونه بارگذاری شد');
  }

  const worker = startWorker();
  const app = buildApp();
  await app.listen(PORT, HOST);

  notify('info', `استودیو محتوای AtoZ نسخه ۷ بالا آمد (حالت هوش مصنوعی: ${AI_MODE}).`);
  logEvent('INFO', 'boot', `HTTP روی http://localhost:${PORT} آماده است`, {
    db: DB_PATH,
    aiMode: AI_MODE,
    renderWorkers: worker.concurrency,
  });

  console.log(`\n  ▸ AtoZ Content Studio v7`);
  console.log(`  ▸ http://localhost:${PORT}`);
  console.log(`  ▸ AI mode: ${AI_MODE}${AI_MODE === 'local' ? '  (بدون کلید — خروجی قالب‌محور آفلاین)' : ''}`);
  console.log(`  ▸ DB: ${DB_PATH}`);
  console.log(`  ▸ render concurrency: ${worker.concurrency}\n`);

  const shutdown = (signal) => {
    logEvent('INFO', 'boot', `دریافت ${signal} — خروج تمیز`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    logEvent('ERROR', 'process', `unhandledRejection: ${err?.stack ?? err}`);
  });
  process.on('uncaughtException', (err) => {
    logEvent('ERROR', 'process', `uncaughtException: ${err?.stack ?? err}`);
  });
}

main().catch((err) => {
  console.error('server failed to start:', err);
  process.exit(1);
});
