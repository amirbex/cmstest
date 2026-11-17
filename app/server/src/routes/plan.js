/**
 * Plan routes — v3.0 content-ops surface.
 *
 * Mounted by buildApp(). Everything here operates on the real model: ideas,
 * plan assets, publish events, three-window snapshots and human quality scores.
 */
import {
  PlanDelivery,
  QualityEvaluation,
  RawMetrics,
  SnapshotWindow,
  ContentId,
  DeliveryId,
} from '@atoz/contracts';
import { validate, bad, notFound } from '../lib/http.js';
import {
  ingestPlanFile,
  listIdeas,
  getIdea,
  listPublishes,
  getPublish,
  listPlanAssets,
  listBatches,
  deleteBatch,
  schedulePublish,
  rolloverPublish,
  publishNow,
  setPublishStatus,
  updatePublishContent,
  recordSnapshot,
  recordQuality,
  listSnapshots,
  analyticsOverview,
  publishBoard,
} from '../services/plan.js';
import { queryTemplates, catalogueFacets, getTemplate, suggestTemplates, FAMILIES } from '../engine/templates.js';
import {
  BUILD_GUIDES,
  buildConcept,
  chooseGuide,
  createEditDoc,
  getEditDoc,
  listEditDocs,
  saveEditDoc,
  deleteEditDoc,
  productionQueue,
} from '../services/production.js';

export function registerPlanRoutes(app) {
  /* ── batches ── */
  app.get('/api/plan/batches', () => ({ success: true, data: listBatches() }));

  app.del('/api/plan/batches/:batchId', ({ params }) => ({
    success: true,
    data: deleteBatch(params.batchId),
  }));

  /** Ingest a plan file. Accepts either the raw plan JSON or a reference to one. */
  app.post('/api/plan/ingest', ({ body }) => {
    if (!body || typeof body !== 'object') throw bad('بدنه نامعتبر است');
    const plan = body.plan ?? body;
    const diff = ingestPlanFile(plan, {
      weekStartIso: body.weekStartIso ?? null,
      replace: Boolean(body.replace),
    });
    return { success: true, data: diff };
  });

  /* ── ideas ── */
  app.get('/api/plan/ideas', ({ query }) => ({
    success: true,
    data: listIdeas({ batchId: query.batchId, status: query.status, limit: Number(query.limit) || 500 }),
  }));

  app.get('/api/plan/ideas/:id', ({ params }) => {
    const idea = getIdea(params.id);
    if (!idea) throw notFound('ایده پیدا نشد');
    return { success: true, data: idea };
  });

  /* ── publishes ── */
  app.get('/api/plan/publishes', ({ query }) => ({
    success: true,
    data: listPublishes({
      batchId: query.batchId,
      contentId: query.contentId,
      platform: query.platform,
      status: query.status,
      from: query.from,
      to: query.to,
      limit: Number(query.limit) || 800,
    }),
  }));

  app.get('/api/plan/publishes/:id', ({ params }) => {
    const publish = getPublish(params.id);
    if (!publish) throw notFound('انتشار پیدا نشد');
    return { success: true, data: publish };
  });

  app.patch('/api/plan/publishes/:id/content', ({ params, body }) => ({
    success: true,
    data: updatePublishContent(params.id, body?.content ?? body ?? {}),
  }));

  app.post('/api/plan/publishes/:id/schedule', ({ params, body }) => ({
    success: true,
    data: schedulePublish(params.id, { date: body?.date ?? null, timeSlot: body?.timeSlot }),
  }));

  app.post('/api/plan/publishes/:id/rollover', ({ params, body }) => ({
    success: true,
    data: rolloverPublish(params.id, Number(body?.days) || 1),
  }));

  app.post('/api/plan/publishes/:id/publish', ({ params, body }) => ({
    success: true,
    data: publishNow(params.id, body?.platformPostId ?? null),
  }));

  app.post('/api/plan/publishes/:id/status', ({ params, body }) => ({
    success: true,
    data: setPublishStatus(params.id, String(body?.status ?? '')),
  }));

  /* ── snapshots (performance) ── */
  app.get('/api/plan/publishes/:id/snapshots', ({ params }) => {
    const publish = getPublish(params.id);
    if (!publish) throw notFound('انتشار پیدا نشد');
    return { success: true, data: listSnapshots(params.id) };
  });

  app.post('/api/plan/publishes/:id/snapshots', ({ params, body }) => {
    const window = validate(SnapshotWindow, body?.window, 'بازه');
    /* only raw metrics are accepted — KPIs are always derived server-side */
    const raw = validate(RawMetrics, body?.raw ?? {}, 'آمار خام');
    return {
      success: true,
      data: recordSnapshot(params.id, window, raw, { source: body?.source ?? 'manual' }),
    };
  });

  /* ── quality ── */
  app.post('/api/plan/publishes/:id/quality', ({ params, body }) => {
    const evaluation = validate(QualityEvaluation.partial(), body?.evaluation ?? body ?? {}, 'ارزیابی کیفیت');
    return { success: true, data: recordQuality(params.id, evaluation) };
  });

  /* ── plan assets ── */
  app.get('/api/plan/assets', ({ query }) => ({
    success: true,
    data: listPlanAssets(query.contentId),
  }));

  /* ── calendar & analytics ── */
  app.get('/api/plan/board', ({ query }) => ({
    success: true,
    data: publishBoard({ from: query.from, to: query.to }),
  }));

  app.get('/api/plan/analytics', ({ query }) => ({
    success: true,
    data: analyticsOverview({ batchId: query.batchId, window: query.window ?? '7d' }),
  }));

  /* ── template catalogue ── */
  app.get('/api/templates', ({ query }) => ({
    success: true,
    data: queryTemplates({
      q: query.q,
      category: query.category,
      family: query.family,
      tag: query.tag,
      aspect: query.aspect,
      motion: query.motion,
      page: query.page,
      pageSize: query.pageSize,
    }),
  }));

  app.get('/api/templates/facets', () => ({
    success: true,
    data: { ...catalogueFacets(), familiesMeta: FAMILIES },
  }));

  app.get('/api/templates/suggest/:intent', ({ params }) => ({
    success: true,
    data: suggestTemplates(params.intent, Number(params.limit) || 6),
  }));

  app.get('/api/templates/:id', ({ params }) => {
    const template = getTemplate(params.id);
    if (!template) throw notFound('قالب پیدا نشد');
    return { success: true, data: template };
  });

  /* ── production queue ── */
  app.get('/api/production/queue', ({ query }) => ({
    success: true,
    data: productionQueue({
      batchId: query.batchId,
      status: query.status,
      from: query.from,
      to: query.to,
    }),
  }));

  app.get('/api/production/guides', () => ({ success: true, data: BUILD_GUIDES }));

  /** Idea + build guide → timed concept (not persisted). */
  app.get('/api/production/concept/:deliveryId', ({ params, query }) => ({
    success: true,
    data: buildConcept(params.deliveryId, {
      guideId: query.guide ?? null,
      durationSec: query.duration ? Number(query.duration) : null,
    }),
  }));

  app.post('/api/production/concept/:deliveryId', ({ params, body }) => ({
    success: true,
    data: buildConcept(params.deliveryId, {
      guideId: body?.guideId ?? null,
      durationSec: body?.durationSec ?? null,
    }),
  }));

  app.get('/api/production/suggest-guide/:deliveryId', ({ params }) => {
    const publish = getPublish(params.deliveryId);
    if (!publish) throw notFound('انتشار پیدا نشد');
    const assets = listPlanAssets(publish.contentId);
    const primary = assets[0] ?? null;
    return { success: true, data: chooseGuide(primary?.assetType, publish.funnelStage) };
  });

  /* ── edit documents (the editor's persisted state) ── */
  app.get('/api/edits', ({ query }) => ({
    success: true,
    data: listEditDocs({
      deliveryId: query.deliveryId,
      status: query.status,
      limit: Number(query.limit) || 200,
    }),
  }));

  app.post('/api/edits', ({ body }) => {
    if (!body?.deliveryId) throw bad('شناسه انتشار لازم است');
    return {
      success: true,
      data: createEditDoc(body.deliveryId, {
        guideId: body.guideId ?? null,
        durationSec: body.durationSec ?? null,
        force: Boolean(body.force),
      }),
    };
  });

  app.get('/api/edits/:docId', ({ params }) => {
    const doc = getEditDoc(params.docId);
    if (!doc) throw notFound('سند تدوین پیدا نشد');
    return { success: true, data: doc };
  });

  app.put('/api/edits/:docId', ({ params, body }) => ({
    success: true,
    data: saveEditDoc(params.docId, body ?? {}),
  }));

  app.del('/api/edits/:docId', ({ params }) => ({ success: true, data: deleteEditDoc(params.docId) }));
}
