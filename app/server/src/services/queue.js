/**
 * Persistent render queue.
 *
 * v5.0 executed `npx remotion render` inline inside the request and kept the
 * HTTP connection open until the video finished — one slow job blocked the whole
 * studio and a crash lost everything. Here jobs live in SQLite, a single worker
 * drains them with a concurrency cap, progress is streamed to the UI over
 * Server-Sent Events, and a crash mid-render is recovered on boot.
 */
import { db, tx, nowIso, logEvent, notify } from '../lib/db.js';
import { renderCover, renderCarousel, renderReel } from '../engine/compose.js';
import { getContent, insertAsset, nextAssetId, setContentStatus } from './repo.js';
import { synthesizeVoice } from './voice.js';
import { pruneOldFrames } from '../lib/fsx.js';

const CONCURRENCY = Number(process.env.ATOZ_RENDER_CONCURRENCY ?? 1);
const running = new Map();
const listeners = new Set();

export function onJobEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event) {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      /* ignore */
    }
  }
}

export function enqueue({ kind, contentId, payload = {}, priority = 0 }) {
  const jobId = `JOB-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  db.prepare(
    `INSERT INTO job (job_id, kind, content_id, status, progress, step, payload_json, priority, created_at)
     VALUES (?,?,?,'queued',0,'در صف رندر',?,?,?)`
  ).run(jobId, kind, contentId, JSON.stringify(payload), priority, nowIso());
  emit({ type: 'job', jobId, status: 'queued', progress: 0, step: 'در صف رندر', contentId });
  setImmediate(pump);
  return jobId;
}

export function getJob(jobId) {
  const row = db.prepare('SELECT * FROM job WHERE job_id = ?').get(jobId);
  if (!row) return null;
  return {
    jobId: row.job_id,
    kind: row.kind,
    contentId: row.content_id,
    status: row.status,
    progress: row.progress,
    step: row.step,
    error: row.error,
    result: JSON.parse(row.result_json || '[]'),
    attempts: row.attempts,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

export function listJobs(limit = 40) {
  return db
    .prepare('SELECT * FROM job ORDER BY created_at DESC LIMIT ?')
    .all(limit)
    .map((row) => getJob(row.job_id));
}

export function cancelJob(jobId) {
  db.prepare("UPDATE job SET status='cancelled', finished_at=? WHERE job_id=? AND status='queued'").run(nowIso(), jobId);
  return getJob(jobId);
}

function update(jobId, patch) {
  const current = getJob(jobId);
  if (!current) return null;
  const next = { ...current, ...patch };
  db.prepare('UPDATE job SET status=?, progress=?, step=?, error=?, result_json=?, finished_at=? WHERE job_id=?').run(
    next.status,
    next.progress,
    next.step,
    next.error ?? null,
    JSON.stringify(next.result ?? []),
    next.finishedAt ?? null,
    jobId
  );
  emit({
    type: 'job',
    jobId,
    status: next.status,
    progress: next.progress,
    step: next.step,
    error: next.error ?? null,
    contentId: next.contentId,
  });
  return next;
}

/** Recover jobs that were mid-flight when the process died. */
export function recoverJobs() {
  const stuck = db.prepare("SELECT job_id FROM job WHERE status='running'").all();
  for (const { job_id } of stuck) {
    db.prepare("UPDATE job SET status='queued', progress=0, step='بازیابی پس از راه‌اندازی مجدد' WHERE job_id=?").run(job_id);
  }
  pruneOldFrames();
  return stuck.length;
}

async function runJob(job) {
  const content = getContent(job.contentId);
  if (!content) throw new Error('محتوای مربوط به این جاب پیدا نشد');
  const plan = content.plan;
  const revision = content.revision ?? 1;
  const onProgress = (progress, step) => update(job.jobId, { progress: Math.min(99, progress), step });
  const created = [];

  if (job.kind === 'cover') {
    update(job.jobId, { status: 'running', step: 'در حال ساخت کاور', progress: 10, startedAt: nowIso() });
    const out = await renderCover({ plan, contentId: content.contentId, revision });
    created.push(out);
  } else if (job.kind === 'carousel') {
    update(job.jobId, { status: 'running', step: 'در حال ساخت اسلایدها', progress: 5, startedAt: nowIso() });
    created.push(...(await renderCarousel({ plan, contentId: content.contentId, revision, onProgress })));
  } else if (job.kind === 'reel') {
    update(job.jobId, { status: 'running', step: 'آماده‌سازی صدا', progress: 3, startedAt: nowIso() });
    let audioFile = null;
    if (plan.voiceoverScript?.trim() && plan.audio?.file) {
      audioFile = plan.audio.file;
    } else if (plan.voiceoverScript?.trim()) {
      try {
        const voice = await synthesizeVoice({ scriptText: plan.voiceoverScript, engine: 'auto', contentId: content.contentId });
        if (voice?.ok && voice.file) {
          audioFile = voice.file;
          update(job.jobId, { step: 'صدا آماده شد؛ رندر فریم‌ها', progress: 6 });
        }
      } catch (err) {
        logEvent('WARN', 'voice', `تولید صدا برای ${content.contentId} ناموفق بود: ${err.message}`);
        update(job.jobId, { step: 'صدا در دسترس نیست — رندر بی‌صدا', progress: 6 });
      }
    }
    const out = await renderReel({
      plan,
      contentId: content.contentId,
      revision,
      jobId: job.jobId,
      audioFile,
      onProgress,
    });
    created.push(out);
  } else if (job.kind === 'pack') {
    update(job.jobId, { status: 'running', step: 'ساخت بسته کامل', progress: 5, startedAt: nowIso() });
    const cover = await renderCover({ plan, contentId: content.contentId, revision });
    created.push(cover);
    created.push(...(await renderCarousel({ plan, contentId: content.contentId, revision, onProgress: (p, s) => onProgress(50 + p / 2, s) })));
    created.push(await renderReel({ plan, contentId: content.contentId, revision, jobId: job.jobId, onProgress: (p, s) => onProgress(60 + p * 0.4, s) }));
  } else {
    throw new Error(`نوع جاب ناشناخته: ${job.kind}`);
  }

  tx(() => {
    for (const file of created) {
      insertAsset({
        assetId: nextAssetId(),
        contentId: content.contentId,
        kind: file.kind === 'video' ? 'video' : 'image',
        file: file.file,
        url: file.url,
        bytes: file.bytes,
        width: file.width,
        height: file.height,
        durationSec: file.durationSec ?? null,
      });
    }
    setContentStatus(content.contentId, 'produced');
  });

  update(job.jobId, {
    status: 'succeeded',
    progress: 100,
    step: 'تکمیل شد',
    result: created.map((c) => ({ url: c.url, file: c.file, bytes: c.bytes, kind: c.kind })),
    finishedAt: nowIso(),
  });
  notify('success', `خروجی ${job.kind} برای ${content.contentId} آماده شد.`);
  return created;
}

async function pump() {
  if (running.size >= CONCURRENCY) return;
  const next = db
    .prepare("SELECT * FROM job WHERE status='queued' ORDER BY priority DESC, created_at ASC LIMIT 1")
    .get();
  if (!next) return;

  const job = getJob(next.job_id);
  db.prepare("UPDATE job SET status='running', attempts=attempts+1, started_at=? WHERE job_id=?").run(nowIso(), job.jobId);
  running.set(job.jobId, true);

  try {
    await runJob(job);
  } catch (err) {
    logEvent('ERROR', 'render', `جاب ${job.jobId} شکست خورد: ${err.message}`);
    update(job.jobId, {
      status: 'failed',
      error: err.message,
      step: 'ناموفق',
      finishedAt: nowIso(),
    });
    const content = getContent(job.contentId);
    if (content) setContentStatus(job.contentId, 'failed', { cascadeDeliveries: false });
    notify('error', `رندر ${job.contentId} ناموفق بود: ${err.message.slice(0, 120)}`);
  } finally {
    running.delete(job.jobId);
    setImmediate(pump);
  }
}

export function queueDepth() {
  const row = db.prepare("SELECT COUNT(*) AS n FROM job WHERE status IN ('queued','running')").get();
  return row.n;
}

export function startWorker() {
  const recovered = recoverJobs();
  if (recovered) logEvent('INFO', 'queue', `${recovered} جاب نیمه‌تمام بازیابی شد`);
  setImmediate(pump);
  return { concurrency: CONCURRENCY, recovered };
}
