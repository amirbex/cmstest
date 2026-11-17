/**
 * Repository layer — the only place that touches SQL for domain entities.
 * Services call this; routes call services. No SQL leaks upward.
 */
import { db, tx, nowIso, nextCounter, peekCounter, notify, logEvent } from '../lib/db.js';
import {
  CreativePlan,
  SocialCopy,
  Subbrand,
  FunnelStage,
  DeliverableType,
  ContentStatus,
  PuzzleBlock,
  CreativePlan as PlanSchema,
} from '@atoz/contracts';

/* ────────────────────────── mapping ────────────────────────── */

function safeJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const DEFAULT_METRICS = {
  reach: 0,
  views: 0,
  saves: 0,
  shares: 0,
  clicks: 0,
  avgWatchTimeSec: 0,
  videoDurationSec: 30,
};
const DEFAULT_KPIS = { saveRate: 0, shareRate: 0, ctr: 0, avgWatchRatio: 0 };

export function rowToContent(row) {
  const parsed = PlanSchema.safeParse(safeJson(row.plan_json, {}));
  return {
    contentId: row.content_id,
    batchId: row.batch_id,
    title: row.title,
    sectionCode: row.section_code,
    deliverableType: row.deliverable_type,
    status: row.status,
    funnelStage: row.funnel_stage,
    scheduleKey: row.schedule_key,
    plan: parsed.success ? parsed.data : PlanSchema.parse({ title: row.title }),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToDelivery(row) {
  return {
    deliveryId: row.delivery_id,
    contentId: row.content_id,
    platform: row.platform,
    scheduleKey: row.schedule_key,
    scheduledFor: row.scheduled_for,
    status: row.status,
    platformPostId: row.platform_post_id,
    rolloverCount: row.rollover_count,
    metrics: { ...DEFAULT_METRICS, ...safeJson(row.metrics_json, {}) },
    kpis: { ...DEFAULT_KPIS, ...safeJson(row.kpis_json, {}) },
    publishedAt: row.published_at,
  };
}

export function rowToAsset(row) {
  return {
    assetId: row.asset_id,
    contentId: row.content_id,
    kind: row.kind,
    file: row.file,
    url: row.url,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    durationSec: row.duration_sec,
    createdAt: row.created_at,
  };
}

const pad6 = (n) => String(n).padStart(6, '0');

/* ────────────────────────── queries ────────────────────────── */

export function listContents({ status, batchId, section, limit = 500 } = {}) {
  const where = [];
  const args = [];
  if (status) {
    const list = Array.isArray(status) ? status : [status];
    where.push(`status IN (${list.map(() => '?').join(',')})`);
    args.push(...list);
  }
  if (batchId) {
    where.push('batch_id = ?');
    args.push(batchId);
  }
  if (section) {
    where.push('section_code = ?');
    args.push(section);
  }
  const sql = `SELECT * FROM content ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
  return db
    .prepare(sql)
    .all(...args, limit)
    .map(rowToContent);
}

export function getContent(contentId) {
  const row = db.prepare('SELECT * FROM content WHERE content_id = ?').get(contentId);
  return row ? rowToContent(row) : null;
}

export function listDeliveries({ from, to, status } = {}) {
  const where = [];
  const args = [];
  if (from) {
    where.push('scheduled_for >= ?');
    args.push(from);
  }
  if (to) {
    where.push('scheduled_for <= ?');
    args.push(to);
  }
  if (status) {
    const list = Array.isArray(status) ? status : [status];
    where.push(`status IN (${list.map(() => '?').join(',')})`);
    args.push(...list);
  }
  const sql = `SELECT * FROM delivery ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY scheduled_for IS NULL, scheduled_for ASC`;
  return db
    .prepare(sql)
    .all(...args)
    .map(rowToDelivery);
}

export function getDelivery(deliveryId) {
  const row = db.prepare('SELECT * FROM delivery WHERE delivery_id = ?').get(deliveryId);
  return row ? rowToDelivery(row) : null;
}

export function listAssets({ contentId } = {}) {
  const sql = contentId
    ? 'SELECT * FROM asset WHERE content_id = ? ORDER BY created_at DESC'
    : 'SELECT * FROM asset ORDER BY created_at DESC LIMIT 500';
  return (contentId ? db.prepare(sql).all(contentId) : db.prepare(sql).all()).map(rowToAsset);
}

export function listNotifications(limit = 20) {
  return db.prepare('SELECT * FROM notification ORDER BY id DESC LIMIT ?').all(limit);
}

export function listEvents({ level = 'ALL', limit = 200 } = {}) {
  const rows =
    level && level !== 'ALL'
      ? db.prepare('SELECT * FROM event_log WHERE level = ? ORDER BY id DESC LIMIT ?').all(level, limit)
      : db.prepare('SELECT * FROM event_log ORDER BY id DESC LIMIT ?').all(limit);
  return rows;
}

/* ────────────────────────── writes ────────────────────────── */

/**
 * Create (or update) a content+delivery pair.
 *
 * BUGFIX v5.0 → v6: the old implementation minted a new delivery for every
 * call and also burned a counter even when an explicit id was supplied, which
 * made `ingestWeeklyPuzzleJson` produce two deliveries per idea. Here ids are
 * allocated only when missing, and the upsert path reuses existing rows.
 */
export function upsertBlueprint({
  contentId = null,
  deliveryId = null,
  batchId = 'ATZ-B-CUSTOM',
  title,
  sectionCode = 'Library',
  deliverableType = 'reel',
  funnelStage = 'MOFU',
  scheduleKey = '',
  plan,
  status = 'blueprint_pending',
  platform = 'instagram',
  scheduledFor = null,
}) {
  const section = Subbrand.safeParse(sectionCode).success ? sectionCode : 'Library';
  const type = DeliverableType.safeParse(deliverableType).success ? deliverableType : 'reel';
  const funnel = FunnelStage.safeParse(funnelStage).success ? funnelStage : 'MOFU';
  const parsedPlan = CreativePlan.safeParse({ ...plan, title, sectionCode: section, funnelStage: funnel });
  const safePlan = parsedPlan.success
    ? parsedPlan.data
    : CreativePlan.parse({ title, sectionCode: section, funnelStage: funnel });

  return tx(() => {
    const existing = contentId
      ? db.prepare('SELECT content_id, revision FROM content WHERE content_id = ?').get(contentId)
      : null;

    /* honour an explicit id — v5.0 silently burned a counter and minted a new
       id here, which broke every externally-referenced content_id */
    const finalContentId =
      existing?.content_id ?? (contentId ? contentId : `ATZ-C-${pad6(nextCounter('content'))}`);
    const stamp = nowIso();

    if (existing) {
      db.prepare(
        `UPDATE content SET title=?, section_code=?, deliverable_type=?, funnel_stage=?, schedule_key=?,
         plan_json=?, updated_at=?, revision=revision+1 WHERE content_id=?`
      ).run(title, section, type, funnel, scheduleKey, JSON.stringify(safePlan), stamp, finalContentId);
    } else {
      db.prepare(
        `INSERT INTO content (content_id, batch_id, title, section_code, deliverable_type, status,
          funnel_stage, schedule_key, plan_json, revision, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`
      ).run(
        finalContentId,
        batchId,
        title,
        section,
        type,
        status,
        funnel,
        scheduleKey,
        JSON.stringify(safePlan),
        stamp,
        stamp
      );
    }

    let finalDeliveryId = deliveryId;
    if (!finalDeliveryId) {
      const known = db.prepare('SELECT delivery_id FROM delivery WHERE content_id = ?').get(finalContentId);
      finalDeliveryId = known?.delivery_id ?? `ATZ-D-${pad6(nextCounter('delivery'))}`;
    }

    const existingDelivery = db.prepare('SELECT delivery_id FROM delivery WHERE delivery_id = ?').get(finalDeliveryId);
    if (existingDelivery) {
      db.prepare(
        'UPDATE delivery SET platform=?, schedule_key=?, scheduled_for=?, status=? WHERE delivery_id=?'
      ).run(platform, scheduleKey, scheduledFor, status, finalDeliveryId);
    } else {
      db.prepare(
        `INSERT INTO delivery (delivery_id, content_id, platform, schedule_key, scheduled_for, status,
          platform_post_id, rollover_count, metrics_json, kpis_json, created_at)
         VALUES (?,?,?,?,?,?,NULL,0,?,?,?)`
      ).run(
        finalDeliveryId,
        finalContentId,
        platform,
        scheduleKey,
        scheduledFor,
        status,
        JSON.stringify(DEFAULT_METRICS),
        JSON.stringify(DEFAULT_KPIS),
        stamp
      );
    }

    return { contentId: finalContentId, deliveryId: finalDeliveryId };
  });
}

export function updatePlan(contentId, patch) {
  return tx(() => {
    const row = db.prepare('SELECT * FROM content WHERE content_id = ?').get(contentId);
    if (!row) return null;
    const current = PlanSchema.safeParse(safeJson(row.plan_json, {}));
    const base = current.success ? current.data : PlanSchema.parse({ title: row.title });
    const merged = CreativePlan.parse({ ...base, ...patch });
    db.prepare('UPDATE content SET plan_json=?, title=?, section_code=?, updated_at=?, revision=revision+1 WHERE content_id=?').run(
      JSON.stringify(merged),
      merged.title,
      merged.sectionCode,
      nowIso(),
      contentId
    );
    return getContent(contentId);
  });
}

export function setContentStatus(contentId, status, { cascadeDeliveries = true } = {}) {
  const parsed = ContentStatus.safeParse(status);
  if (!parsed.success) throw new Error(`invalid status: ${status}`);
  return tx(() => {
    db.prepare('UPDATE content SET status=?, updated_at=? WHERE content_id=?').run(status, nowIso(), contentId);
    if (cascadeDeliveries) {
      db.prepare('UPDATE delivery SET status=? WHERE content_id=?').run(status, contentId);
    }
    const row = db.prepare('SELECT * FROM content WHERE content_id = ?').get(contentId);
    return row ? rowToContent(row) : null;
  });
}

/**
 * Approve blueprints. v5.0 accepted arbitrary contentIds with no validation and
 * happily "approved" ids that did not exist, reporting a fake count.
 */
export function approveBlueprints({ contentIds = null, periodCode = null } = {}) {
  return tx(() => {
    let batchId = null;
    if (periodCode) {
      const block = db.prepare('SELECT * FROM puzzle_block WHERE period_code = ?').get(periodCode);
      if (!block) throw new Error(`بلوک ${periodCode} پیدا نشد`);
      batchId = block.batch_id;
      db.prepare('UPDATE puzzle_block SET status=?, updated_at=? WHERE period_code=?').run(
        'approved_for_production',
        nowIso(),
        periodCode
      );
    }

    const targets = [];
    if (!batchId && !Array.isArray(contentIds)) {
      targets.push(...db.prepare("SELECT content_id FROM content WHERE status = 'blueprint_pending'").all());
    }
    if (batchId) {
      targets.push(...db.prepare("SELECT content_id FROM content WHERE batch_id = ? AND status = 'blueprint_pending'").all(batchId));
    }
    if (Array.isArray(contentIds)) {
      const stmt = db.prepare("SELECT content_id FROM content WHERE content_id = ? AND status = 'blueprint_pending'");
      for (const id of contentIds) {
        const row = stmt.get(id);
        if (row) targets.push(row);
      }
    }

    const ids = [...new Set(targets.map((t) => t.content_id))];
    const stamp = nowIso();
    const updC = db.prepare("UPDATE content SET status='approved_for_production', updated_at=? WHERE content_id=?");
    const updD = db.prepare("UPDATE delivery SET status='approved_for_production' WHERE content_id=?");
    for (const id of ids) {
      updC.run(stamp, id);
      updD.run(id);
    }
    if (ids.length) notify('success', `${ids.length} الگو تأیید و به صف تولید منتقل شد.`);
    return { approvedCount: ids.length, contentIds: ids };
  });
}

export function recordMetrics(deliveryId, raw) {
  const delivery = getDelivery(deliveryId);
  if (!delivery) throw new Error('تحویل موردنظر پیدا نشد');
  const reach = Math.max(1, Number(raw.reach) || 1);
  const saves = Number(raw.saves) || 0;
  const shares = Number(raw.shares) || 0;
  const clicks = Number(raw.clicks) || 0;
  const watch = Number(raw.avgWatchTimeSec) || 0;
  const duration = Math.max(1, Number(raw.videoDurationSec) || 30);
  const metrics = {
    reach,
    views: Number(raw.views) || reach,
    saves,
    shares,
    clicks,
    avgWatchTimeSec: watch,
    videoDurationSec: duration,
  };
  const kpis = {
    saveRate: +((saves / reach) * 100).toFixed(2),
    shareRate: +((shares / reach) * 100).toFixed(2),
    ctr: +((clicks / reach) * 100).toFixed(2),
    avgWatchRatio: +((watch / duration) * 100).toFixed(1),
  };
  db.prepare('UPDATE delivery SET metrics_json=?, kpis_json=? WHERE delivery_id=?').run(
    JSON.stringify(metrics),
    JSON.stringify(kpis),
    deliveryId
  );
  return getDelivery(deliveryId);
}

export function markPublished(deliveryId, platformPostId = null) {
  return tx(() => {
    db.prepare("UPDATE delivery SET status='published', platform_post_id=?, published_at=? WHERE delivery_id=?").run(
      platformPostId || `POST-${Date.now()}`,
      nowIso(),
      deliveryId
    );
    const delivery = getDelivery(deliveryId);
    if (delivery) {
      const remaining = db
        .prepare("SELECT COUNT(*) AS n FROM delivery WHERE content_id = ? AND status != 'published'")
        .get(delivery.contentId);
      if (remaining.n === 0) {
        db.prepare("UPDATE content SET status='published', updated_at=? WHERE content_id=?").run(
          nowIso(),
          delivery.contentId
        );
      }
    }
    return delivery;
  });
}

export function insertAsset(asset) {
  db.prepare(
    `INSERT OR REPLACE INTO asset (asset_id, content_id, kind, file, url, bytes, width, height, duration_sec, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    asset.assetId,
    asset.contentId,
    asset.kind,
    asset.file,
    asset.url,
    asset.bytes ?? 0,
    asset.width ?? null,
    asset.height ?? null,
    asset.durationSec ?? null,
    nowIso()
  );
  return asset;
}

export function nextAssetId() {
  return `ATZ-A-${pad6(nextCounter('asset'))}`;
}

/* ────────────────────────── puzzle blocks ────────────────────────── */

const MONTH_TITLES = {
  1: 'فونداسیون، بوم کسب‌وکار و سیستم‌سازی پایه',
  2: 'مهندسی سود، عملیات پیشرفته و بهینه‌سازی',
  3: 'مقیاس‌پذیری، تجربه مشتری و رهبری بازار',
};

export function listPuzzleBlocks() {
  return db.prepare('SELECT * FROM puzzle_block ORDER BY month, week, part').all().map((r) => ({
    periodCode: r.period_code,
    batchId: r.batch_id,
    month: r.month,
    week: r.week,
    part: r.part,
    phaseTitle: MONTH_TITLES[r.month] ?? '',
    daysLabel: r.part === 1 ? 'شنبه تا سه‌شنبه (روزهای ۱ تا ۴)' : 'چهارشنبه تا جمعه (روزهای ۵ تا ۷)',
    status: r.status,
    ideasCount: r.ideas_count,
    deliveriesCount: r.deliveries_count,
    updatedAt: r.updated_at,
  }));
}

export function ensurePuzzleBlocks() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM puzzle_block').get().n;
  if (count === 24) return;
  tx(() => {
    db.prepare('DELETE FROM puzzle_block').run();
    const stmt = db.prepare(
      `INSERT INTO puzzle_block (period_code, batch_id, month, week, part, status, ideas_count, deliveries_count, updated_at)
       VALUES (?,?,?,?,?,'waiting_upload',0,0,NULL)`
    );
    for (let m = 1; m <= 3; m++) {
      for (let w = 1; w <= 4; w++) {
        for (let p = 1; p <= 2; p++) {
          stmt.run(`M0${m}-W0${w}-PART${p}`, `ATZ-B-M0${m}-W0${w}-P${p}`, m, w, p);
        }
      }
    }
  });
}

/* ────────────────────────── ingest (the v5.0 double-insert bug) ────────────────────────── */

const PILLAR_TO_SECTION = {
  P1: 'Library',
  P2: 'Solutions',
  P3: 'AI',
  P4: 'Calculators',
  P5: 'Magazine',
  P6: 'Academy',
};

export function pillarToSection(pillar = '') {
  const code = String(pillar).match(/P[1-6]/)?.[0] ?? 'P1';
  return PILLAR_TO_SECTION[code] ?? 'Library';
}

/** Convert `M01-W01-PART1` → `M01-W01-P1` style batch ids, tolerating both. */
export function normaliseBatchId(periodCode, explicit) {
  if (explicit) return explicit;
  const cleaned = String(periodCode).replace(/PART\s*([12])/i, 'P$1');
  return `ATZ-B-${cleaned}`;
}

export function formatToPlatform(format = '') {
  const f = String(format).toLowerCase();
  if (f.includes('yt') || f.includes('youtube')) return 'youtube';
  if (f.includes('web') || f.includes('article') || f.includes('mag')) return 'website';
  if (f.includes('tg') || f.includes('telegram')) return 'telegram';
  return 'instagram';
}

export function recordPuzzleIngest(periodCode, batchId, ideasCount, deliveriesCount) {
  tx(() => {
    db.prepare(
      `INSERT INTO puzzle_block (period_code, batch_id, month, week, part, status, ideas_count, deliveries_count, updated_at)
       VALUES (?,?,?,?,?,'blueprint_pending',?,?,?)
       ON CONFLICT(period_code) DO UPDATE SET batch_id=excluded.batch_id, status='blueprint_pending',
         ideas_count=excluded.ideas_count, deliveries_count=excluded.deliveries_count, updated_at=excluded.updated_at`
    ).run(
      periodCode,
      batchId,
      1,
      1,
      1,
      ideasCount,
      deliveriesCount,
      nowIso()
    );
  });
  notify('info', `بلوک ${periodCode}: ${ideasCount} ایده و ${deliveriesCount} تحویل ثبت شد (بدون مصرف توکن).`);
}

export function stats() {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  return {
    pending: one("SELECT COUNT(*) n FROM content WHERE status='blueprint_pending'").n,
    approved: one("SELECT COUNT(*) n FROM content WHERE status IN ('approved_for_production','queued','rendering')").n,
    produced: one("SELECT COUNT(*) n FROM content WHERE status IN ('produced','scheduled')").n,
    published: one("SELECT COUNT(*) n FROM content WHERE status='published'").n,
    failed: one("SELECT COUNT(*) n FROM content WHERE status='failed'").n,
    assets: one('SELECT COUNT(*) n FROM asset').n,
    jobsQueued: one("SELECT COUNT(*) n FROM job WHERE status='queued'").n,
    counters: {
      content: peekCounter('content'),
      delivery: peekCounter('delivery'),
      asset: peekCounter('asset'),
    },
  };
}

export { notify, logEvent, tx };
export const DEFAULT_SOCIAL = SocialCopy.parse({});
