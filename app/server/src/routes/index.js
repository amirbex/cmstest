/**
 * All HTTP routes. Thin by design: validate → call a service → respond.
 */
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { App, validate, bad, notFound } from '../lib/http.js';
import {
  RenderRequest,
  VoiceRequest,
  PuzzleBlock,
  CreativePlan,
  Subbrand,
  SUBBRANDS,
  ContentStatus,
  SocialCopy,
} from '@atoz/contracts';
import {
  listContents,
  getContent,
  listDeliveries,
  getDelivery,
  listAssets,
  listNotifications,
  listEvents,
  updatePlan,
  setContentStatus,
  approveBlueprints,
  recordMetrics,
  markPublished,
  listPuzzleBlocks,
  stats,
  notify,
  logEvent,
} from '../services/repo.js';
import { ingestPuzzleBlock, persistGeneratedBatch, duplicateContent, bulkSetStatus, seedDemoIfEmpty } from '../services/content.js';
import { db as appDb } from '../lib/db.js';
import { expandConcepts, generateBatch, atoozDecide, quotaSnapshot, getPrompts, savePrompts, listAgentRuns, aiStatus } from '../services/ai.js';
import { synthesizeVoice, listVoiceEngines } from '../services/voice.js';
import { enqueue, getJob, listJobs, cancelJob, queueDepth, onJobEvent } from '../services/queue.js';
import { weekBoard, monthBoard, scheduleDelivery, rollover, publishDelivery, describe } from '../services/calendar.js';
import { loadBrand, themeFor, chartPalette } from '../services/brand.js';
import { walkAssets } from '../lib/fsx.js';
import { MOTIONS, MOTION_KEYS, TRANSITIONS } from '../engine/motion.js';
import { renderPreviewFrame } from '../engine/compose.js';

export function buildApp() {
  const app = new App({ maxBodyBytes: 12 * 1024 * 1024 });

  /* ── static ── */
  app
    .serve('/media/outputs', 'storage/outputs')
    .serve('/media/assets', 'storage/assets')
    .serve('/media/fonts', 'app/web/public/fonts');

  /* ── health & state ── */
  app.get('/api/health', () => ({
    success: true,
    data: {
      ok: true,
      version: '6.0.0',
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      mode: process.env.NODE_ENV ?? 'development',
    },
  }));

  app.get('/api/state', () => {
    const mem = process.memoryUsage();
    const load = os.loadavg()[0] ?? 0;
    const cpuCount = os.cpus().length || 1;
    return {
      success: true,
      data: {
        stats: stats(),
        notifications: listNotifications(12),
        system: {
          cpuPct: Math.min(99, Math.round((load / cpuCount) * 100)),
          ramUsedMb: Math.round(mem.rss / 1048576),
          ramTotalMb: Math.round(os.totalmem() / 1048576),
          platform: process.platform,
          queueDepth: queueDepth(),
          ai: aiStatus(),
          today: describe(new Date()),
        },
        brand: loadBrand(),
      },
    };
  });

  /* ── brand ── */
  app.get('/api/brand', () => ({ success: true, data: loadBrand() }));
  app.get('/api/brand/theme/:section', ({ params }) => {
    const parsed = Subbrand.safeParse(params.section);
    if (!parsed.success) throw bad(`بخش نامعتبر: ${params.section} — مقادیر مجاز: ${SUBBRANDS.join(', ')}`, 'INVALID_SECTION');
    const section = parsed.data;
    return { success: true, data: { theme: themeFor(section), palette: chartPalette(section) } };
  });

  /* ── motion library ── */
  app.get('/api/motions', () => ({
    success: true,
    data: {
      presets: MOTION_KEYS.map((key) => ({ key, label: MOTIONS[key].label })),
      transitions: Object.entries(TRANSITIONS).map(([key, v]) => ({ key, label: v.label })),
    },
  }));

  /* ── content ── */
  app.get('/api/contents', ({ query }) => ({
    success: true,
    data: listContents({
      status: query.status ? query.status.split(',') : undefined,
      batchId: query.batchId,
      section: query.section,
    }),
  }));

  app.get('/api/contents/:id', ({ params }) => {
    const content = getContent(params.id);
    if (!content) throw notFound('محتوا پیدا نشد');
    return { success: true, data: { content, deliveries: listDeliveries().filter((d) => d.contentId === content.contentId), assets: listAssets({ contentId: content.contentId }) } };
  });

  app.patch('/api/contents/:id/plan', ({ params, body }) => {
    if (!body?.plan) throw bad('بدنه باید شامل plan باشد');
    const plan = validate(CreativePlan, { ...getContent(params.id)?.plan, ...body.plan }, 'طرح محتوا');
    const updated = updatePlan(params.id, plan);
    if (!updated) throw notFound('محتوا پیدا نشد');
    return { success: true, data: updated };
  });

  app.patch('/api/contents/:id/status', ({ params, body }) => {
    const status = validate(ContentStatus, body?.status, 'وضعیت');
    const updated = setContentStatus(params.id, status);
    if (!updated) throw notFound('محتوا پیدا نشد');
    return { success: true, data: updated };
  });

  app.post('/api/contents/:id/duplicate', ({ params }) => {
    const copy = duplicateContent(params.id);
    if (!copy) throw notFound('محتوا پیدا نشد');
    return { success: true, data: copy };
  });

  app.post('/api/contents/bulk-status', ({ body }) => {
    if (!Array.isArray(body?.ids)) throw bad('ids باید آرایه باشد');
    const status = validate(ContentStatus, body?.status, 'وضعیت');
    return { success: true, data: bulkSetStatus(body.ids, status) };
  });

  app.del('/api/contents/:id', ({ params }) => {
    setContentStatus(params.id, 'archived');
    return { success: true, data: { archived: params.id } };
  });

  /* ── blueprints ── */
  app.post('/api/blueprints/approve', ({ body }) => {
    const result = approveBlueprints({
      contentIds: Array.isArray(body?.contentIds) ? body.contentIds : null,
      periodCode: body?.periodCode ?? null,
    });
    return { success: true, data: result };
  });

  /* ── ingest ── */
  app.post('/api/puzzle/ingest', ({ body }) => {
    const block = validate(PuzzleBlock, body?.puzzle ?? body, 'بلوک هفتگی');
    const summary = ingestPuzzleBlock(block);
    return { success: true, data: summary };
  });

  app.get('/api/puzzle/blocks', () => ({ success: true, data: listPuzzleBlocks() }));

  /* ── ideation ── */
  app.post('/api/ai/concepts', async ({ body }) => {
    if (!body?.rawIdea || String(body.rawIdea).trim().length < 3) throw bad('موضوع را وارد کنید');
    const data = await expandConcepts({
      rawIdea: String(body.rawIdea).slice(0, 500),
      sectionCode: Subbrand.safeParse(body.sectionCode).success ? body.sectionCode : 'Library',
      useWebSearch: Boolean(body.useWebSearch),
    });
    return { success: true, data };
  });

  app.post('/api/ai/generate', async ({ body }) => {
    if (!body?.conceptTitle) throw bad('کانسپت انتخاب نشده است');
    const counts = {
      article: clampCount(body.counts?.article),
      reels: clampCount(body.counts?.reels),
      youtube: clampCount(body.counts?.youtube),
      carousels: clampCount(body.counts?.carousels),
      posts: clampCount(body.counts?.posts),
    };
    const result = await generateBatch({
      conceptTitle: String(body.conceptTitle).slice(0, 200),
      conceptSummary: String(body.conceptSummary ?? '').slice(0, 800),
      sectionCode: Subbrand.safeParse(body.sectionCode).success ? body.sectionCode : 'Library',
      counts,
    });
    const records = persistGeneratedBatch({
      deliverables: result.deliverables,
      conceptTitle: body.conceptTitle,
      sectionCode: body.sectionCode ?? 'Library',
      counts,
      source: result.mode,
    });
    return { success: true, data: { records, mode: result.mode, source: result.source } };
  });

  /* ── assistant ── */
  app.post('/api/atooz/chat', async ({ body }) => {
    const message = String(body?.message ?? '').slice(0, 1200).trim();
    if (!message) throw bad('پیام خالی است');
    const decision = await atoozDecide({ message, context: { stats: stats(), today: describe(new Date()) } });

    if (body?.confirmedAction && decision.action !== 'NONE') {
      // execute the confirmed action server-side (never trust the client payload)
      if (decision.action === 'APPROVE_ALL_BLUEPRINTS') {
        const pending = listContents({ status: ['blueprint_pending'] }).map((c) => c.contentId);
        const result = approveBlueprints({ contentIds: pending });
        return { success: true, data: { ...decision, reply: `${result.approvedCount} الگو تایید شد.`, result } };
      }
      if (decision.action === 'CREATE_IDEA' && decision.ideaTopic) {
        const concepts = await expandConcepts({ rawIdea: decision.ideaTopic, sectionCode: decision.sectionCode });
        const generated = await generateBatch({
          conceptTitle: concepts.concepts[0].angleTitle,
          conceptSummary: concepts.concepts[0].summary,
          sectionCode: decision.sectionCode,
          counts: { article: 1, reels: 1, carousels: 1 },
        });
        const records = persistGeneratedBatch({
          deliverables: generated.deliverables,
          conceptTitle: concepts.concepts[0].angleTitle,
          sectionCode: decision.sectionCode,
          counts: { article: 1, reels: 1, carousels: 1 },
          source: generated.mode,
        });
        return {
          success: true,
          data: { ...decision, reply: `ایده ثبت شد و ${records.length} الگو ساخته شد.`, records },
        };
      }
    }
    return { success: true, data: decision };
  });

  /* ── voice ── */
  app.get('/api/voice/engines', async () => ({ success: true, data: await listVoiceEngines() }));

  app.post('/api/voice/synthesize', async ({ body }) => {
    const payload = validate(VoiceRequest, body, 'درخواست صدا');
    const result = await synthesizeVoice({
      scriptText: payload.scriptText,
      engine: payload.engine,
      contentId: payload.contentId ?? 'adhoc',
    });
    if (!result.ok) throw bad(result.error ?? 'تولید صدا ناموفق بود', 'VOICE_UNAVAILABLE');
    if (payload.contentId) {
      const content = getContent(payload.contentId);
      if (content) {
        updatePlan(payload.contentId, {
          audio: {
            file: result.file,
            durationSec: result.durationSec,
            engine: result.engine,
            words: result.words,
          },
        });
      }
    }
    return { success: true, data: result };
  });

  app.post('/api/voice/upload-sample', async ({ body }) => {
    const { base64Audio, fileName } = body ?? {};
    if (!base64Audio || typeof base64Audio !== 'string') throw bad('فایل صوتی ارسال نشده است');
    const safeName = `sample-${Date.now()}-${String(fileName ?? 'voice.wav').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const dir = path.resolve('storage/assets/voice-samples');
    fs.mkdirSync(dir, { recursive: true });
    const raw = base64Audio.replace(/^data:audio\/\w+;base64,/, '');
    const buffer = Buffer.from(raw, 'base64');
    if (buffer.length > 12 * 1024 * 1024) throw bad('حجم فایل صوتی بیش از حد مجاز است');
    await fsp.writeFile(path.join(dir, safeName), buffer);
    return { success: true, data: { fileName: safeName, url: `/media/assets/voice-samples/${safeName}` } };
  });

  /* ── render queue ── */
  app.post('/api/render', ({ body }) => {
    const { contentId, kinds } = validate(RenderRequest, body, 'درخواست رندر');
    const content = getContent(contentId);
    if (!content) throw notFound('محتوا پیدا نشد');
    const jobs = kinds.map((kind) => enqueue({ kind, contentId, priority: content.status === 'approved_for_production' ? 5 : 0 }));
    setContentStatus(contentId, 'queued', { cascadeDeliveries: false });
    return { success: true, data: { jobs, contentId } };
  });

  app.get('/api/render/jobs', () => ({ success: true, data: listJobs(40) }));
  app.get('/api/render/jobs/:id', ({ params }) => {
    const job = getJob(params.id);
    if (!job) throw notFound('جاب پیدا نشد');
    return { success: true, data: job };
  });
  app.post('/api/render/jobs/:id/cancel', ({ params }) => {
    const job = cancelJob(params.id);
    if (!job) throw notFound('جاب پیدا نشد');
    return { success: true, data: job };
  });

  /** Server-Sent Events: live job progress without polling. */
  app.get('/api/events', ({ stream, req }) => {
    const res = stream(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    const off = onJobEvent((event) => {
      res.write(`event: job\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      off();
    });
  });

  /* ── preview (studio scrubber) ── */
  app.post('/api/preview', async ({ body }) => {
    const plan = validate(CreativePlan, body?.plan, 'طرح پیش‌نمایش');
    const timeSec = Math.max(0, Math.min(60, Number(body?.timeSec) || 0));
    const result = await renderPreviewFrame({ plan, timeSec, contentId: body?.contentId ?? 'preview' });
    return { success: true, data: { url: `/media/outputs/previews/${path.basename(result.file)}?t=${Date.now()}` } };
  });

  /* ── calendar ── */
  app.get('/api/calendar/week', ({ query }) => ({
    success: true,
    data: weekBoard(query.date ? new Date(query.date) : new Date()),
  }));
  app.get('/api/calendar/month', ({ query }) => ({
    success: true,
    data: monthBoard(query.date ? new Date(query.date) : new Date()),
  }));
  app.post('/api/calendar/schedule', ({ body }) => {
    if (!body?.deliveryId) throw bad('شناسه تحویل لازم است');
    /* `date` is the canonical field; `isoDay` was the earlier name and is still
       accepted so both the Studio and the Calendar room can schedule a slot. */
    return { success: true, data: scheduleDelivery(body.deliveryId, body.date ?? body.isoDay ?? null) };
  });
  app.post('/api/calendar/rollover', ({ body }) => {
    if (!body?.deliveryId) throw bad('شناسه تحویل لازم است');
    return { success: true, data: rollover(body.deliveryId, Number(body.days) || 1) };
  });
  app.post('/api/calendar/publish', ({ body }) => {
    if (!body?.deliveryId) throw bad('شناسه تحویل لازم است');
    return { success: true, data: publishDelivery(body.deliveryId, body.platformPostId ?? null) };
  });

  /* ── metrics ── */
  app.post('/api/metrics', ({ body }) => {
    if (!body?.deliveryId) throw bad('شناسه تحویل لازم است');
    return { success: true, data: recordMetrics(body.deliveryId, body) };
  });

  /* ── gallery & assets ── */
  app.get('/api/assets', ({ query }) => ({
    success: true,
    data: listAssets({ contentId: query.contentId }),
  }));

  app.get('/api/dam', () => {
    const roots = [
      { id: 'outputs', title: 'خروجی‌های تولیدشده', dir: 'storage/outputs', prefix: '/media/outputs' },
      { id: 'assets', title: 'دارایی‌های برند', dir: 'storage/assets', prefix: '/media/assets' },
      { id: 'fonts', title: 'فونت‌های سیستم', dir: 'app/web/public/fonts', prefix: '/media/fonts' },
    ];
    return {
      success: true,
      data: roots.map((root) => {
        const files = walkAssets(path.resolve(root.dir), root.prefix);
        return { id: root.id, title: root.title, dir: root.dir, count: files.length, bytes: files.reduce((a, f) => a + f.bytes, 0), files: files.slice(0, 400) };
      }),
    };
  });

  /* ── monitoring ── */
  app.get('/api/logs', ({ query }) => ({
    success: true,
    data: listEvents({ level: query.level ?? 'ALL', limit: Math.min(500, Number(query.limit) || 200) }),
  }));
  app.del('/api/logs', () => {
    appDb.exec('DELETE FROM event_log');
    return { success: true };
  });
  app.get('/api/quotas', () => ({ success: true, data: { quotas: quotaSnapshot(), runs: listAgentRuns(50) } }));

  /* ── prompts ── */
  app.get('/api/prompts', () => ({ success: true, data: getPrompts() }));
  app.post('/api/prompts', ({ body }) => {
    /* Accept several client shapes without ever writing junk:
         { KEY: "text" }                       — flat (canonical)
         { prompts: { KEY: "text" } }          — nested, used by the Prompts room
       Every value must be a non-empty string; anything else is ignored rather
       than persisted, and a body with no usable keys is a client error. */
    const source = body?.prompts && typeof body.prompts === 'object' ? body.prompts : body;
    if (!source || typeof source !== 'object') throw bad('بدنه نامعتبر است');
    const patch = Object.fromEntries(
      Object.entries(source).filter(([key, value]) => /^[A-Z0-9_]{3,64}$/.test(key) && typeof value === 'string' && value.trim())
    );
    if (!Object.keys(patch).length) throw bad('هیچ پرامپت معتبری در بدنه نبود', 'VALIDATION');
    logEvent('INFO', 'prompts', `نسخه جدید پرامپت‌ها ذخیره شد: ${Object.keys(patch).join(', ')}`);
    return { success: true, data: savePrompts(patch) };
  });

  /* ── exports ── */
  app.get('/api/export/:contentId', async ({ params, stream }) => {
    const content = getContent(params.contentId);
    if (!content) throw notFound('محتوا پیدا نشد');
    const assets = listAssets({ contentId: content.contentId });
    const manifest = {
      exportedAt: new Date().toISOString(),
      content,
      deliveries: listDeliveries().filter((d) => d.contentId === content.contentId),
      assets,
    };
    stream(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${content.contentId}-package.json"`,
    }).end(JSON.stringify(manifest, null, 2));
    return undefined;
  });

  app.post('/api/demo/seed', () => ({ success: true, data: seedDemoIfEmpty() }));

  app.post('/api/notify', ({ body }) => {
    notify(body?.level ?? 'info', String(body?.message ?? '').slice(0, 400));
    return { success: true };
  });

  return app;
}

function clampCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(5, Math.trunc(n)));
}

export { SocialCopy };
