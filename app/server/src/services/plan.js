/**
 * Plan service — v3.0 content-ops model.
 *
 * This is the heart of v7: it ingests the real `ATZ-B-MXX-WXX-PX` plan files
 * (ideas -> plan assets -> publish events) and turns them into a queryable
 * production surface.
 *
 * Design rules learned from the v6 simplification:
 *  • one idea may have many publish events across platforms and even repeated
 *    publishes of the same idea — never collapse them
 *  • schedule_key is the movable calendar address; scheduled_for is derived
 *    from it and re-derived on rollover, so the two can never disagree
 *  • raw metrics and computed KPIs live in separate columns and KPI values are
 *    never accepted from the client
 *  • ingest is idempotent per batch: re-uploading a corrected plan updates rows
 *    in place and reports what changed, instead of duplicating everything
 */
import { db, nowIso, tx, logEvent, notify, getMeta, setMeta } from '../lib/db.js';
import {
  ContentPlanFile,
  parseScheduleKey,
  PLATFORM_LABEL,
  FORMAT_LABEL,
  isVideoFormat,
  isCarouselFormat,
} from '@atoz/contracts';

/* ────────────────────────── row mappers ────────────────────────── */

const parseJson = (value, fallback) => {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export function rowToIdea(row) {
  if (!row) return null;
  return {
    contentId: row.content_id,
    batchId: row.batch_id,
    title: row.title,
    pillar: row.pillar,
    thread: row.thread,
    sectionCode: row.section_code,
    personas: parseJson(row.personas_json, []),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToPublish(row) {
  if (!row) return null;
  const key = parseScheduleKey(row.schedule_key);
  const content = parseJson(row.content_json, {});
  return {
    deliveryId: row.delivery_id,
    contentId: row.content_id,
    batchId: row.batch_id,
    scheduleKey: row.schedule_key,
    schedule: key,
    platform: row.platform,
    platformLabel: PLATFORM_LABEL[row.platform] ?? row.platform,
    formatCode: row.format_code,
    formatLabel: FORMAT_LABEL[row.format_code] ?? row.format_code,
    formatType: row.format_type,
    dayOfWeek: row.day_of_week,
    timeSlot: row.time_slot,
    funnelStage: row.funnel_stage,
    contentPillar: row.content_pillar,
    ctaTargetId: row.cta_target_id,
    platformPostId: row.platform_post_id,
    publishStatus: row.publish_status,
    scheduledFor: row.scheduled_for,
    assetIds: parseJson(row.asset_ids_json, []),
    positioning: parseJson(row.positioning_json, {}),
    visual: parseJson(row.visual_json, {}),
    content,
    quality: parseJson(row.quality_json, {}),
    rolloverCount: row.rollover_count,
    publishedAt: row.published_at,
    isVideo: key ? isVideoFormat(key.format) : false,
    isCarousel: key ? isCarouselFormat(key.format) : false,
  };
}

export function rowToPlanAsset(row) {
  if (!row) return null;
  return {
    assetId: row.asset_id,
    contentId: row.content_id,
    assetType: row.asset_type,
    name: row.name,
    storageLocation: row.storage_location,
    subfileCodes: parseJson(row.subfile_codes_json, []),
    createdAt: row.created_at,
  };
}

/* ────────────────────────── calendar derivation ────────────────────────── */

/**
 * Convert a schedule_key into a concrete date.
 *
 * The key encodes month/week/day-of-week relative to the plan's start date, but
 * plan files also carry `day_of_week` + `time_slot` for the actual week. We
 * anchor on the batch's week start, which is recorded the first time the batch
 * is ingested, so every publish lands on a real date in the right local week.
 */
export function resolveScheduledFor({ scheduleKey, weekStartIso, timeSlot = '09:00' }) {
  const key = parseScheduleKey(scheduleKey);
  if (!key || !weekStartIso) return null;
  const start = new Date(`${weekStartIso}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  /* day 1 = Saturday; the week board is Saturday-first to match the Iranian week */
  const offsetDays = key.day - 1;
  const [hh, mm] = String(timeSlot).split(':').map((n) => Number(n));
  start.setDate(start.getDate() + offsetDays);
  start.setHours(Number.isFinite(hh) ? hh : 9, Number.isFinite(mm) ? mm : 0, 0, 0);
  return start.toISOString();
}

/** Saturday of the week containing `date`, as YYYY-MM-DD. */
export function weekStartOf(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun .. 6=Sat
  const back = (dow + 1) % 7; // Saturday -> 0
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ────────────────────────── ingest ────────────────────────── */

/**
 * Ingest one plan file. Idempotent: an existing batch is updated in place.
 * Returns a per-entity diff so the UI can say "3 new ideas, 12 updated".
 */
export function ingestPlanFile(raw, { weekStartIso = null, replace = false } = {}) {
  const parsed = ContentPlanFile.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.')}: ${i.message}`).join(' · ');
    throw Object.assign(new Error(`فایل پلن معتبر نیست — ${detail}`), { code: 'VALIDATION', status: 400 });
  }
  const plan = parsed.data;
  const batchId = plan.schema_metadata.batch_id;
  const stamp = nowIso();

  /* the batch's week anchor is set once, then reused on every re-ingest */
  const metaKey = `batch:${batchId}:weekStart`;
  const anchor = weekStartIso || getMeta(metaKey, null) || weekStartOf(new Date());
  if (!getMeta(metaKey, null)) setMeta(metaKey, anchor);

  /* schedule_key -> the actual date, so the calendar never has to guess */
  const dayIsoByKeyPrefix = new Map();

  return tx(() => {
    const diff = {
      batchId,
      weekStart: anchor,
      ideas: { added: 0, updated: 0 },
      assets: { added: 0, updated: 0 },
      publishes: { added: 0, updated: 0 },
      removed: 0,
      warnings: [],
    };

    /* ── ideas ── */
    const ideaStmt = db.prepare(
      `INSERT INTO idea (content_id, batch_id, title, pillar, thread, section_code, personas_json, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(content_id) DO UPDATE SET
         title=excluded.title, pillar=excluded.pillar, thread=excluded.thread,
         personas_json=excluded.personas_json, updated_at=excluded.updated_at`
    );
    const ideaExists = db.prepare('SELECT 1 FROM idea WHERE content_id = ?');
    for (const idea of plan.content_ideas) {
      const section = idea.pillar.match(/\bP(\d)\b/)?.[1];
      const sectionCode = PILLAR_SECTION[section] ?? 'Library';
      const existed = Boolean(ideaExists.get(idea.content_id));
      ideaStmt.run(
        idea.content_id,
        batchId,
        idea.title,
        idea.pillar,
        idea.thread,
        sectionCode,
        JSON.stringify(idea.personas ?? []),
        existed ? undefined ?? 'idea' : 'idea',
        stamp,
        stamp
      );
      if (existed) diff.ideas.updated++;
      else diff.ideas.added++;
    }

    /* ── plan assets ── */
    const assetStmt = db.prepare(
      `INSERT INTO plan_asset (asset_id, content_id, asset_type, name, storage_location, subfile_codes_json, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(asset_id) DO UPDATE SET
         asset_type=excluded.asset_type, name=excluded.name,
         storage_location=excluded.storage_location, subfile_codes_json=excluded.subfile_codes_json`
    );
    const assetExists = db.prepare('SELECT 1 FROM plan_asset WHERE asset_id = ?');
    for (const asset of plan.assets) {
      const existed = Boolean(assetExists.get(asset.asset_id));
      assetStmt.run(
        asset.asset_id,
        asset.content_id,
        asset.asset_type,
        asset.name,
        asset.storage_location ?? '',
        JSON.stringify(asset.version_and_subfile_codes ?? []),
        stamp
      );
      if (existed) diff.assets.updated++;
      else diff.assets.added++;
    }

    /* ── publish events ── */
    const publishStmt = db.prepare(
      `INSERT INTO publish (
         delivery_id, content_id, batch_id, schedule_key, platform, format_code, format_type,
         day_of_week, time_slot, funnel_stage, content_pillar, cta_target_id, platform_post_id,
         publish_status, scheduled_for, asset_ids_json, positioning_json, visual_json, content_json,
         quality_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(delivery_id) DO UPDATE SET
         schedule_key=excluded.schedule_key, platform=excluded.platform, format_code=excluded.format_code,
         format_type=excluded.format_type, day_of_week=excluded.day_of_week, time_slot=excluded.time_slot,
         funnel_stage=excluded.funnel_stage, content_pillar=excluded.content_pillar,
         cta_target_id=excluded.cta_target_id, scheduled_for=excluded.scheduled_for,
         asset_ids_json=excluded.asset_ids_json, positioning_json=excluded.positioning_json,
         visual_json=excluded.visual_json, content_json=excluded.content_json,
         updated_at=excluded.updated_at`
    );
    const publishExists = db.prepare('SELECT 1 FROM publish WHERE delivery_id = ?');
    for (const delivery of plan.deliveries) {
      const key = parseScheduleKey(delivery.schedule_key);
      if (!key) {
        diff.warnings.push(`کلید تقویمی نامعتبر: ${delivery.delivery_id} → ${delivery.schedule_key}`);
        continue;
      }
      const scheduledFor = resolveScheduledFor({
        scheduleKey: delivery.schedule_key,
        weekStartIso: anchor,
        timeSlot: delivery.time_slot,
      });
      const existed = Boolean(publishExists.get(delivery.delivery_id));
      publishStmt.run(
        delivery.delivery_id,
        delivery.content_id,
        batchId,
        delivery.schedule_key,
        PLATFORM_FROM_KEY[key.platform] ?? 'website',
        key.format,
        delivery.format_type,
        delivery.day_of_week,
        delivery.time_slot,
        delivery.funnel_stage,
        delivery.content_pillar,
        delivery.cta_target_id ?? null,
        delivery.platform_post_id ?? null,
        delivery.publish_status ?? 'planned',
        scheduledFor,
        JSON.stringify(delivery.asset_ids ?? []),
        JSON.stringify(delivery.strategic_positioning ?? {}),
        JSON.stringify(delivery.visual_and_prompt_specs ?? {}),
        JSON.stringify(delivery.exact_content ?? {}),
        JSON.stringify(delivery.human_quality_evaluation ?? {}),
        stamp,
        stamp
      );
      if (existed) diff.publishes.updated++;
      else diff.publishes.added++;

      /* seed the three snapshot rows so the insights room always has a target */
      for (const w of ['24h', '7d', '30d']) {
        db.prepare('INSERT OR IGNORE INTO snapshot (delivery_id, window_key, source) VALUES (?,?,?)').run(
          delivery.delivery_id,
          w,
          'manual'
        );
      }
    }

    /* ── optional hard replace ── */
    if (replace) {
      const ids = new Set(plan.content_ideas.map((i) => i.content_id));
      const stale = db.prepare('SELECT content_id FROM idea WHERE batch_id = ?').all(batchId).filter((r) => !ids.has(r.content_id));
      for (const row of stale) {
        db.prepare('DELETE FROM idea WHERE content_id = ?').run(row.content_id);
        diff.removed++;
      }
    }

    db.prepare(
      `INSERT INTO puzzle_block (period_code, batch_id, month, week, part, status, ideas_count, deliveries_count, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(period_code) DO UPDATE SET
         batch_id=excluded.batch_id, status='ingested',
         ideas_count=excluded.ideas_count, deliveries_count=excluded.deliveries_count, updated_at=excluded.updated_at`
    ).run(
      batchId.replace(/^ATZ-B-/, ''),
      batchId,
      Number(batchId.match(/-M(\d+)/)?.[1] ?? 1),
      Number(batchId.match(/-W(\d+)/)?.[1] ?? 1),
      Number(batchId.match(/-P(\d+)/)?.[1] ?? 1),
      'ingested',
      plan.content_ideas.length,
      plan.deliveries.length,
      stamp
    );

    logEvent(
      'INFO',
      'plan',
      `پلن ${batchId} ثبت شد: ${diff.ideas.added} ایده جدید، ${diff.publishes.added} انتشار جدید`
    );
    return diff;
  });
}

const PILLAR_SECTION = {
  1: 'Library',
  2: 'Magazine',
  3: 'AI',
  4: 'Calculators',
  5: 'Solutions',
  6: 'Academy',
};

const PLATFORM_FROM_KEY = {
  IG: 'instagram',
  TG: 'telegram',
  YT: 'youtube',
  WEB: 'website',
};

export const PLATFORM_TO_CODE = { instagram: 'IG', telegram: 'TG', youtube: 'YT', website: 'WEB' };

/* ────────────────────────── queries ────────────────────────── */

export function listIdeas({ batchId, status, limit = 500 } = {}) {
  const where = [];
  const args = [];
  if (batchId) {
    where.push('batch_id = ?');
    args.push(batchId);
  }
  if (status) {
    where.push('status = ?');
    args.push(status);
  }
  const sql = `SELECT * FROM idea ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY content_id ASC LIMIT ?`;
  return db
    .prepare(sql)
    .all(...args, limit)
    .map(rowToIdea);
}

export function getIdea(contentId) {
  const row = db.prepare('SELECT * FROM idea WHERE content_id = ?').get(contentId);
  if (!row) return null;
  const idea = rowToIdea(row);
  idea.publishes = listPublishes({ contentId });
  idea.planAssets = listPlanAssets(contentId);
  idea.rendered = db.prepare('SELECT * FROM asset WHERE content_id = ? ORDER BY created_at DESC').all(contentId);
  idea.editDocs = db
    .prepare('SELECT target, revision, updated_at FROM edit_doc WHERE content_id = ?')
    .all(contentId)
    .map((r) => ({ target: r.target, revision: r.revision, updatedAt: r.updated_at }));
  return idea;
}

export function listPublishes({ batchId, contentId, platform, status, from, to, limit = 800 } = {}) {
  const where = [];
  const args = [];
  if (batchId) {
    where.push('batch_id = ?');
    args.push(batchId);
  }
  if (contentId) {
    where.push('content_id = ?');
    args.push(contentId);
  }
  if (platform) {
    where.push('platform = ?');
    args.push(platform);
  }
  if (status) {
    where.push('publish_status = ?');
    args.push(status);
  }
  if (from) {
    where.push('scheduled_for >= ?');
    args.push(from);
  }
  if (to) {
    where.push('scheduled_for <= ?');
    args.push(to);
  }
  const sql = `SELECT * FROM publish ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY scheduled_for IS NULL, scheduled_for ASC LIMIT ?`;
  return db
    .prepare(sql)
    .all(...args, limit)
    .map(rowToPublish);
}

export function getPublish(deliveryId) {
  const row = db.prepare('SELECT * FROM publish WHERE delivery_id = ?').get(deliveryId);
  if (!row) return null;
  const publish = rowToPublish(row);
  publish.snapshots = listSnapshots(deliveryId);
  return publish;
}

export function listPlanAssets(contentId = null) {
  const rows = contentId
    ? db.prepare('SELECT * FROM plan_asset WHERE content_id = ? ORDER BY asset_id').all(contentId)
    : db.prepare('SELECT * FROM plan_asset ORDER BY asset_id').all();
  return rows.map(rowToPlanAsset);
}

/* ────────────────────────── scheduling ────────────────────────── */

export function schedulePublish(deliveryId, { date, timeSlot } = {}) {
  const row = db.prepare('SELECT * FROM publish WHERE delivery_id = ?').get(deliveryId);
  if (!row) throw Object.assign(new Error('انتشار پیدا نشد'), { status: 404, code: 'NOT_FOUND' });

  let iso = row.scheduled_for;
  if (date) {
    const key = parseScheduleKey(row.schedule_key);
    iso = resolveScheduledFor({
      scheduleKey: row.schedule_key,
      weekStartIso: weekStartOf(new Date(`${date}T12:00:00`)),
      timeSlot: timeSlot ?? row.time_slot,
    });
    if (!iso) throw Object.assign(new Error('تاریخ نامعتبر است'), { status: 400, code: 'INVALID_DATE' });
    /* rewriting the day segment keeps the key and the date in agreement */
    if (key) {
      const dow = new Date(`${date}T12:00:00`).getDay();
      const dayNum = ((dow + 1) % 7) + 1; // Saturday=1 .. Friday=7
      const newKey = row.schedule_key.replace(/-D\d{2}-/, `-D${String(dayNum).padStart(2, '0')}-`);
      db.prepare('UPDATE publish SET schedule_key = ?, scheduled_for = ?, updated_at = ? WHERE delivery_id = ?').run(
        newKey,
        iso,
        nowIso(),
        deliveryId
      );
      return getPublish(deliveryId);
    }
  }
  db.prepare('UPDATE publish SET scheduled_for = ?, time_slot = ?, updated_at = ? WHERE delivery_id = ?').run(
    iso,
    timeSlot ?? row.time_slot,
    nowIso(),
    deliveryId
  );
  return getPublish(deliveryId);
}

/** Move a publish by N days, keeping schedule_key and date consistent. */
export function rolloverPublish(deliveryId, days = 1) {
  const row = db.prepare('SELECT * FROM publish WHERE delivery_id = ?').get(deliveryId);
  if (!row) throw Object.assign(new Error('انتشار پیدا نشد'), { status: 404, code: 'NOT_FOUND' });
  const base = row.scheduled_for ? new Date(row.scheduled_for) : new Date();
  base.setDate(base.getDate() + days);
  const key = parseScheduleKey(row.schedule_key);
  const dow = base.getDay();
  const dayNum = ((dow + 1) % 7) + 1;
  const newKey = key ? row.schedule_key.replace(/-D\d{2}-/, `-D${String(dayNum).padStart(2, '0')}-`) : row.schedule_key;
  db.prepare(
    `UPDATE publish SET scheduled_for = ?, schedule_key = ?, rollover_count = rollover_count + 1,
       publish_status = CASE WHEN publish_status = 'published' THEN publish_status ELSE 'scheduled' END,
       updated_at = ? WHERE delivery_id = ?`
  ).run(base.toISOString(), newKey, nowIso(), deliveryId);
  return getPublish(deliveryId);
}

export function publishNow(deliveryId, platformPostId = null) {
  const row = db.prepare('SELECT * FROM publish WHERE delivery_id = ?').get(deliveryId);
  if (!row) throw Object.assign(new Error('انتشار پیدا نشد'), { status: 404, code: 'NOT_FOUND' });
  db.prepare(
    `UPDATE publish SET publish_status='published', platform_post_id=?, published_at=?, updated_at=? WHERE delivery_id=?`
  ).run(platformPostId || `MANUAL-${Date.now()}`, nowIso(), nowIso(), deliveryId);
  return getPublish(deliveryId);
}

export function setPublishStatus(deliveryId, status) {
  const allowed = ['planned', 'scheduled', 'producing', 'ready', 'published', 'failed', 'skipped'];
  if (!allowed.includes(status)) {
    throw Object.assign(new Error(`وضعیت نامعتبر: ${status}`), { status: 400, code: 'VALIDATION' });
  }
  db.prepare('UPDATE publish SET publish_status = ?, updated_at = ? WHERE delivery_id = ?').run(status, nowIso(), deliveryId);
  return getPublish(deliveryId);
}

/** Update the editable content of a publish (caption, slides, timeline). */
export function updatePublishContent(deliveryId, patch) {
  const row = db.prepare('SELECT * FROM publish WHERE delivery_id = ?').get(deliveryId);
  if (!row) throw Object.assign(new Error('انتشار پیدا نشد'), { status: 404, code: 'NOT_FOUND' });
  const current = parseJson(row.content_json, {});
  const merged = { ...current, ...patch };
  db.prepare('UPDATE publish SET content_json = ?, updated_at = ? WHERE delivery_id = ?').run(
    JSON.stringify(merged),
    nowIso(),
    deliveryId
  );
  return getPublish(deliveryId);
}

/* ────────────────────────── performance & quality ────────────────────────── */

/**
 * Compute KPIs from raw metrics. This is the only place these formulas exist;
 * the client can never submit a KPI value.
 */
export function computeKpis(raw = {}) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const ratio = (a, b) => {
    const na = num(a);
    const nb = num(b);
    if (na == null || nb == null || nb === 0) return null;
    return Math.round((na / nb) * 10000) / 100; // percent, 2dp
  };
  const reach = num(raw.reach);
  const likes = num(raw.likes) ?? 0;
  const comments = num(raw.comments) ?? 0;
  const saves = num(raw.saves) ?? 0;
  const shares = num(raw.shares) ?? 0;
  const engagement = reach ? likes + comments + saves + shares : null;
  return {
    save_rate: ratio(raw.saves, reach),
    share_rate: ratio(raw.shares, reach),
    ctr: ratio(raw.clicks, reach),
    engagement_rate_by_reach: engagement != null ? ratio(engagement, reach) : null,
    avg_watch_ratio: ratio(raw.avg_watch_time_sec, raw.video_duration_sec),
    story_reply_rate: ratio(raw.replies_and_sticker_taps, reach),
    web_asset_conversion: ratio(raw.asset_downloads_or_tool_runs, raw.unique_page_views),
  };
}

export function listSnapshots(deliveryId) {
  const rows = db.prepare('SELECT * FROM snapshot WHERE delivery_id = ?').all(deliveryId);
  const byWindow = Object.fromEntries(
    rows.map((r) => [
      r.window_key,
      {
        window: r.window_key,
        capturedAt: r.captured_at,
        raw: parseJson(r.raw_json, {}),
        kpis: parseJson(r.kpis_json, {}),
        source: r.source,
      },
    ])
  );
  return ['24h', '7d', '30d'].map(
    (w) => byWindow[w] ?? { window: w, capturedAt: null, raw: {}, kpis: {}, source: 'manual' }
  );
}

export function recordSnapshot(deliveryId, window, rawMetrics, { source = 'manual' } = {}) {
  const exists = db.prepare('SELECT 1 FROM publish WHERE delivery_id = ?').get(deliveryId);
  if (!exists) throw Object.assign(new Error('انتشار پیدا نشد'), { status: 404, code: 'NOT_FOUND' });
  if (!['24h', '7d', '30d'].includes(window)) {
    throw Object.assign(new Error('بازه نامعتبر است'), { status: 400, code: 'VALIDATION' });
  }
  const kpis = computeKpis(rawMetrics);
  db.prepare(
    `INSERT INTO snapshot (delivery_id, window_key, captured_at, raw_json, kpis_json, source)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(delivery_id, window_key) DO UPDATE SET
       captured_at=excluded.captured_at, raw_json=excluded.raw_json,
       kpis_json=excluded.kpis_json, source=excluded.source`
  ).run(deliveryId, window, nowIso(), JSON.stringify(rawMetrics), JSON.stringify(kpis), source);
  return listSnapshots(deliveryId);
}

export function recordQuality(deliveryId, evaluation) {
  const row = db.prepare('SELECT quality_json FROM publish WHERE delivery_id = ?').get(deliveryId);
  if (!row) throw Object.assign(new Error('انتشار پیدا نشد'), { status: 404, code: 'NOT_FOUND' });

  const scores = evaluation.scores_1_to_5 ?? {};
  const values = Object.values(scores).filter((v) => typeof v === 'number');
  /* equal-weighted mean of whatever axes were actually scored */
  const index = values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : null;

  const merged = {
    ...parseJson(row.quality_json, {}),
    ...evaluation,
    scores_1_to_5: { ...(parseJson(row.quality_json, {}).scores_1_to_5 ?? {}), ...scores },
    weighted_quality_index: index,
    evaluated_at: nowIso(),
  };
  db.prepare('UPDATE publish SET quality_json = ?, updated_at = ? WHERE delivery_id = ?').run(
    JSON.stringify(merged),
    nowIso(),
    deliveryId
  );
  return merged;
}

/* ────────────────────────── analytics ────────────────────────── */

/**
 * The dashboard aggregate. Every number here is derived, never stored.
 * `window` selects which snapshot feeds the KPI analysis.
 */
const PLATFORM_LABEL_FOR = (p) => ({ instagram: 'اینستاگرام', telegram: 'تلگرام', youtube: 'یوتیوب', website: 'وب‌سایت' })[p] ?? p;

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);

export function analyticsOverview({ batchId = null, window = '7d' } = {}) {
  const publishes = listPublishes({ batchId });
  const rows = db
    .prepare('SELECT delivery_id, raw_json, kpis_json FROM snapshot WHERE window_key = ?')
    .all(window);
  const snapByDelivery = new Map(rows.map((r) => [r.delivery_id, r]));

  const sum = {};
  const byPlatform = {};
  const byFunnel = {};
  const byFormat = {};
  let measured = 0;

  for (const publish of publishes) {
    const snap = snapByDelivery.get(publish.deliveryId);
    const raw = parseJson(snap?.raw_json, {});
    const hasData = Object.values(raw).some((v) => typeof v === 'number' && v > 0);
    if (hasData) measured++;

    const platform = publish.platformLabel;
    const funnel = publish.funnelStage;
    const format = publish.formatLabel;
    const emptyBucket = () => ({ publishes: 0, published: 0, reach: 0, saves: 0, clicks: 0, engagement: 0, measured: 0 });
    byPlatform[platform] ??= { ...emptyBucket(), platform: publish.platform, label: PLATFORM_LABEL_FOR(publish.platform) };
    byFunnel[funnel] ??= { ...emptyBucket(), stage: funnel };
    byFormat[format] ??= { ...emptyBucket(), format: publish.formatCode, label: format, engagementSum: 0 };

    /* engagement here is the sum of the four interaction metrics, because the
       per-bucket rate needs a numerator and a denominator that both aggregate */
    const engagement = (raw.likes ?? 0) + (raw.comments ?? 0) + (raw.saves ?? 0) + (raw.shares ?? 0);
    const published = publish.publishStatus === 'published' ? 1 : 0;

    for (const bucket of [byPlatform[platform], byFunnel[funnel], byFormat[format]]) {
      bucket.publishes++;
      bucket.published += published;
      bucket.reach += raw.reach ?? 0;
      bucket.saves += raw.saves ?? 0;
      bucket.clicks += raw.clicks ?? 0;
      bucket.engagement += engagement;
      if (hasData) bucket.measured++;
    }
    byFormat[format].engagementSum += engagement;

    for (const key of ['reach', 'likes', 'comments', 'saves', 'shares', 'clicks', 'views']) {
      sum[key] = (sum[key] ?? 0) + (raw[key] ?? 0);
    }
    sum.engagement = (sum.engagement ?? 0) + engagement;
  }

  const quality = db
    .prepare('SELECT quality_json FROM publish')
    .all()
    .map((r) => parseJson(r.quality_json, {}))
    .filter((q) => typeof q.weighted_quality_index === 'number');

  const topPublishes = publishes
    .map((p) => {
      const snap = snapByDelivery.get(p.deliveryId);
      const raw = parseJson(snap?.raw_json, {});
      return { deliveryId: p.deliveryId, title: p.content?.ready_caption?.slice(0, 80) ?? p.positioning.topic ?? '', reach: raw.reach ?? 0, saves: raw.saves ?? 0, platform: p.platformLabel };
    })
    .filter((p) => p.reach > 0)
    .sort((a, b) => b.reach - a.reach)
    .slice(0, 8);

  return {
    window,
    totals: {
      ideas: db.prepare('SELECT COUNT(*) AS n FROM idea').get().n,
      planAssets: db.prepare('SELECT COUNT(*) AS n FROM plan_asset').get().n,
      publishes: publishes.length,
      published: publishes.filter((p) => p.publishStatus === 'published').length,
      measured,
      ...sum,
    },
    rates: {
      /* percentages, rounded to one decimal: what a marketer reads */
      save_rate: pct(sum.saves, sum.reach),
      share_rate: pct(sum.shares, sum.reach),
      ctr: pct(sum.clicks, sum.reach),
      engagement_rate_by_reach: pct(sum.engagement, sum.reach),
      measured_share: publishes.length ? Math.round((measured / publishes.length) * 1000) / 10 : 0,
    },
    quality: {
      evaluated: quality.length,
      average: quality.length
        ? Math.round((quality.reduce((a, q) => a + q.weighted_quality_index, 0) / quality.length) * 100) / 100
        : null,
      pending: publishes.filter((p) => !p.quality || p.quality.evaluation_status === 'pending').length,
    },
    byPlatform: Object.values(byPlatform),
    byFunnel: Object.values(byFunnel),
    byFormat: Object.values(byFormat)
      .map(({ engagementSum, ...rest }) => ({ ...rest, avgEngagement: pct(rest.engagement, rest.reach) }))
      .sort((a, b) => (b.avgEngagement ?? -1) - (a.avgEngagement ?? -1)),
    topPublishes: topPublishes.map((p) => ({
      ...p,
      platformLabel: p.platform,
      engagement: 0,
      kpis: snapByDelivery.get(p.deliveryId) ? parseJson(snapByDelivery.get(p.deliveryId).kpis_json, {}) : {},
    })),
  };
}

/** Calendar board for the publish table, Saturday-first. */
export function publishBoard({ from, to } = {}) {
  const start = from ? new Date(from) : new Date();
  if (Number.isNaN(start.getTime())) throw Object.assign(new Error('تاریخ نامعتبر است'), { status: 400, code: 'INVALID_DATE' });
  const weekStart = new Date(`${weekStartOf(start)}T00:00:00`);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  const dayIso = days.map((d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  const publishes = listPublishes({
    from: `${dayIso[0]}T00:00:00`,
    to: `${dayIso[6]}T23:59:59`,
  });

  /* Days are richer than a bare date: the UI needs the weekday label, the count
     and the per-platform split to draw the week without recomputing it. */
  const WEEKDAYS = ['شنبه', 'یک‌شنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنج‌شنبه', 'جمعه'];
  const richDays = dayIso.map((date, i) => {
    const dayPublishes = publishes.filter((p) => (p.scheduledFor ?? '').slice(0, 10) === date);
    const byPlatform = {};
    for (const p of dayPublishes) byPlatform[p.platform] = (byPlatform[p.platform] ?? 0) + 1;
    return {
      date,
      weekday: WEEKDAYS[i],
      label: date.slice(5).replace('-', '/'),
      count: dayPublishes.length,
      byPlatform,
      isToday: date === todayIso(),
    };
  });

  /* anything scheduled outside this week (e.g. a rollover) must not vanish */
  const inWeek = new Set(dayIso);
  const outside = publishes.filter((p) => !inWeek.has((p.scheduledFor ?? '').slice(0, 10)));

  return { weekStart: dayIso[0], days: richDays, publishes, outsideWeek: outside };
}

/** Distinct batches with counts, for the batch switcher. */
export function listBatches() {
  const rows = db
    .prepare(
      `SELECT batch_id,
              COUNT(DISTINCT content_id) AS ideas,
              COUNT(*) AS publishes,
              SUM(CASE WHEN publish_status = 'published' THEN 1 ELSE 0 END) AS published,
              MIN(scheduled_for) AS starts,
              MAX(scheduled_for) AS ends
       FROM publish GROUP BY batch_id ORDER BY batch_id`
    )
    .all();
  const ideaRows = db.prepare('SELECT batch_id, COUNT(*) AS n FROM idea GROUP BY batch_id').all();
  const ideaCount = Object.fromEntries(ideaRows.map((r) => [r.batch_id, r.n]));
  return rows.map((r) => ({
    batchId: r.batch_id,
    ideas: ideaCount[r.batch_id] ?? r.ideas,
    publishes: r.publishes,
    published: r.published,
    starts: r.starts,
    ends: r.ends,
    planAssets: db.prepare('SELECT COUNT(*) AS n FROM plan_asset a JOIN idea i ON i.content_id = a.content_id WHERE i.batch_id = ?').get(r.batch_id).n,
  }));
}

export function deleteBatch(batchId) {
  return tx(() => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM idea WHERE batch_id = ?').get(batchId).n;
    db.prepare('DELETE FROM idea WHERE batch_id = ?').run(batchId);
    db.prepare('DELETE FROM puzzle_block WHERE batch_id = ?').run(batchId);
    logEvent('WARN', 'plan', `پلن ${batchId} حذف شد (${before} ایده)`);
    return { removed: before };
  });
}
