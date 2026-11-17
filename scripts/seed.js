#!/usr/bin/env node
/**
 * `npm run seed` — put the studio into a demonstrable state, non-destructively.
 *
 * 1. loads the demo puzzle block if the DB is empty (never duplicates)
 * 2. approves anything still pending, so the render queue has work
 * 3. optionally renders one pack (`--render`) and waits for it to finish
 *
 * Safe to run repeatedly: every step is idempotent.
 */
import process from 'node:process';

const args = new Set(process.argv.slice(2));
const shouldRender = args.has('--render') || args.has('-r');
const shouldReset = args.has('--reset');

const repo = await import('../app/server/src/services/repo.js');
const { seedDemoIfEmpty } = await import('../app/server/src/services/content.js');
const { loadBrand } = await import('../app/server/src/services/brand.js');
const queue = await import('../app/server/src/services/queue.js');
const { DB_PATH } = await import('../app/server/src/lib/db.js');
const { logEvent } = repo;

const G = '\x1b[32m';
const Y = '\x1b[33m';
const D = '\x1b[2m';
const X = '\x1b[0m';
const say = (icon, text, detail = '') => console.log(`  ${icon} ${text}${detail ? ` ${D}${detail}${X}` : ''}`);

console.log(`\n  AtoZ Content Studio v6 — seed\n${D}  db: ${DB_PATH}${X}\n`);

if (shouldReset) {
  say(`${Y}■${X}`, 'resetting content tables');
  const { db } = await import('../app/server/src/lib/db.js');
  db.exec(`
    DELETE FROM asset;
    DELETE FROM delivery;
    DELETE FROM content;
    DELETE FROM job;
    DELETE FROM event_log;
    DELETE FROM notification;
    DELETE FROM agent_run;
  `);
}

loadBrand();

const seed = seedDemoIfEmpty();
if (seed.seeded) {
  say(`${G}✔${X}`, 'demo batch loaded', `contents: ${seed.summary?.contentsCreated ?? 0} · ideas: ${seed.summary?.ideasCount ?? 0}`);
} else {
  say(`${D}·${X}`, 'demo batch already present', `${seed.count} contents`);
}

const pending = repo.listContents({ status: 'blueprint_pending' });
if (pending.length) {
  const approved = repo.approveBlueprints({});
  say(`${G}✔${X}`, 'blueprints approved', `${approved.approvedCount} items`);
} else {
  say(`${D}·${X}`, 'nothing pending approval');
}

const ready = repo.listContents({ status: 'approved_for_production' });
say(`${G}✔${X}`, 'ready for production', `${ready.length} contents`);

if (!shouldRender) {
  if (ready.length) {
    const preview = ready.slice(0, 5).map((c) => `${c.contentId} ${D}${c.deliverableType}${X}`);
    console.log(`\n  ${D}queue preview:${X}\n${preview.map((p) => `    · ${p}`).join('\n')}`);
    console.log(`\n  ${D}add --render to render one full pack now${X}\n`);
  }
  process.exit(0);
}

const target = ready[0];
if (!target) {
  say(`${Y}!${X}`, 'nothing to render');
  process.exit(0);
}

say(`${D}▶${X}`, 'starting render worker');
queue.recoverJobs();
const worker = queue.startWorker();
const jobIds = ['cover', 'carousel', 'reel'].map((kind) =>
  queue.enqueue({ kind, contentId: target.contentId, payload: {}, priority: 10 })
);
say(`${D}▶${X}`, 'jobs queued', jobIds.join(' '));

const deadline = Date.now() + 180_000;
let lastLine = 0;
let lastPrint = 0;
const tick = setInterval(() => {
  const states = jobIds.map((id) => queue.getJob(id));
  const done = states.filter((j) => ['succeeded', 'failed', 'cancelled'].includes(j.status));
  const pct = Math.round(states.reduce((sum, j) => sum + (j.progress ?? 0), 0) / states.length);
  const line = `  ${D}…${X} ${done.length}/${states.length} jobs finished · ${pct}%`;
  if (line !== lastLine && Date.now() - lastPrint > 120) {
    lastPrint = Date.now();
    process.stdout.write(`\r${line}   `);
    lastLine = line;
  }
  if (done.length === states.length || Date.now() > deadline) {
    clearInterval(tick);
    process.stdout.write('\n');
    for (const job of states) {
      const icon = job.status === 'succeeded' ? `${G}✔${X}` : `${Y}!${X}`;
      const files = Array.isArray(job.result) ? job.result.map((a) => a.file).join(', ') : '';
      say(icon, `${job.kind.padEnd(8)} ${job.status}`, job.error ?? files);
    }
    logEvent('INFO', 'seed', `seed --render finished for ${target.contentId}`);
    void worker;
    process.exit(states.every((j) => j.status === 'succeeded') ? 0 : 1);
  }
}, 700);
