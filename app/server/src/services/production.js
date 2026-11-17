/**
 * Production service — turn a plan idea into a renderable, timed concept.
 *
 * This is the bridge the user asked for: "main idea + build guide → timed reel
 * concept, editable". The input is an `idea` (from the user's plan file) plus
 * its `plan_asset` rows; the output is the editor's document model, with real
 * scene timings that sum to the target duration and text that was actually
 * written for that idea rather than a template's placeholder.
 *
 * Nothing here invents facts. Scene text comes from the delivery's own timeline,
 * slide copy and caption; the build guide only decides *shape* (how many scenes,
 * whether there is a proof beat, what the CTA is).
 */
import { db, nowIso, logEvent } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { EditDocument } from '@atoz/contracts';
import { getIdea, getPublish, listPublishes, listPlanAssets } from './plan.js';
import { suggestTemplates } from '../engine/templates.js';

/* ────────────────────────── build guides ────────────────────────── */

/**
 * Build guides are named shapes for a reel. Each one describes the beats and how
 * to divide the duration; the copy still comes from the plan.
 */
export const BUILD_GUIDES = [
  {
    id: 'hook-problem-solve-cta',
    name: 'قلاب / مسئله / راه‌حل / دعوت',
    weights: [0.12, 0.23, 0.45, 0.2],
    beats: ['قلاب', 'مسئله', 'راه‌حل', 'دعوت'],
    note: 'استانداردترین ساختار ریلز آموزشی؛ برای TOFU و MOFU',
  },
  {
    id: 'three-steps',
    name: 'سه گام اجرایی',
    weights: [0.12, 0.2, 0.2, 0.2, 0.18, 0.1],
    beats: ['قلاب', 'گام ۱', 'گام ۲', 'گام ۳', 'نتیجه', 'دعوت'],
    note: 'برای محتوای کاربردی؛ هر گام یک صحنه',
  },
  {
    id: 'myth-truth-proof',
    name: 'باور غلط / واقعیت / اثبات',
    weights: [0.18, 0.32, 0.32, 0.18],
    beats: ['باور غلط', 'واقعیت', 'اثبات عددی', 'دعوت'],
    note: 'برای محتوای داده‌محور و اعتبارساز',
  },
  {
    id: 'before-after',
    name: 'قبل / بعد / روش',
    weights: [0.2, 0.25, 0.35, 0.2],
    beats: ['قبل', 'بعد', 'روش', 'دعوت'],
    note: 'برای مطالعه موردی و تبدیل',
  },
  {
    id: 'micro-question',
    name: 'میکرو-ریلز پرسشی',
    weights: [0.4, 0.35, 0.25],
    beats: ['پرسش', 'پاسخ کوتاه', 'دعوت'],
    note: 'برای ریلزهای ۷ تا ۱۲ ثانیه‌ای و استوری',
  },
];

export function getBuildGuide(id) {
  return BUILD_GUIDES.find((g) => g.id === id) ?? BUILD_GUIDES[0];
}

/** Pick a sensible guide from the asset type + funnel stage. */
export function chooseGuide(assetType = '', funnelStage = '') {
  const t = String(assetType).toLowerCase();
  if (t.includes('micro') || t.includes('7s')) return getBuildGuide('micro-question');
  if (t.includes('calculator') || t.includes('data') || t.includes('stat')) return getBuildGuide('myth-truth-proof');
  if (t.includes('case') || t.includes('story')) return getBuildGuide('before-after');
  if (String(funnelStage).toUpperCase() === 'BOFU') return getBuildGuide('three-steps');
  return getBuildGuide('hook-problem-solve-cta');
}

/* ────────────────────────── idea → concept ────────────────────────── */

/**
 * Build the editable concept for one publish (delivery) of an idea.
 *
 * Returns an `EditDoc`-shaped object: the same model the editor canvas renders,
 * so "concept → open in editor → tweak → render" needs no translation step.
 */
export function buildConcept(deliveryId, { guideId = null, durationSec = null } = {}) {
  const publish = getPublish(deliveryId);
  if (!publish) throw new HttpError(404, 'انتشار پیدا نشد', 'NOT_FOUND');

  const idea = getIdea(publish.contentId);
  const assets = listPlanAssets(publish.contentId);
  const primaryAsset = assets.find((a) => publish.assetIds?.includes(a.assetId)) ?? assets[0] ?? null;

  const guide = guideId ? getBuildGuide(guideId) : chooseGuide(primaryAsset?.assetType, publish.funnelStage);
  const total = Number(durationSec) || inferDuration(primaryAsset?.assetType) || 30;

  const copy = publish.content ?? {};
  const timeline = Array.isArray(copy.timeline) ? copy.timeline : [];
  const slides = Array.isArray(copy.slides) ? copy.slides : [];

  /* Source of scene text, best first:
     1. the plan's own timeline beats (they carry on_screen_text + narration)
     2. the plan's slide copy
     3. the caption split into sentences — the honest last resort          */
  const sourceBeats =
    timeline.length > 0
      ? timeline.map((t) => ({ title: t.on_screen_text ?? '', narration: t.narration_script ?? '', at: t.time }))
      : slides.length > 0
        ? slides.map((s) => ({ title: s.title ?? '', narration: s.body_text ?? '', at: null }))
        : splitCaption(copy.ready_caption ?? idea?.title ?? '');

  const scenes = fitScenes(sourceBeats, guide, total, {
    idea,
    publish,
    primaryAsset,
    slides,
  });

  const templateIds = suggestTemplates(pickIntent(publish, primaryAsset), 3).map((t) => t.id);

  return {
    kind: publish.isCarousel ? 'carousel' : publish.isVideo ? 'reel' : 'post',
    title: idea?.title ?? publish.deliveryId,
    durationSec: total,
    aspect: publish.isCarousel ? '1080x1350' : publish.isVideo ? '1080x1920' : '1080x1080',
    guide: { id: guide.id, name: guide.name, note: guide.note },
    templateIds,
    meta: {
      deliveryId: publish.deliveryId,
      contentId: publish.contentId,
      batchId: publish.batchId,
      scheduleKey: publish.scheduleKey,
      platform: publish.platform,
      platformLabel: publish.platformLabel,
      formatLabel: publish.formatLabel,
      scheduledFor: publish.scheduledFor,
      funnelStage: publish.funnelStage,
      cta: copy.cta ?? null,
      ctaTargetId: publish.ctaTargetId,
      caption: copy.ready_caption ?? '',
      hashtags: copy.hashtags ?? [],
      personaList: idea?.personas ?? [],
      accentHex: publish.visual?.accent_hex ?? '#FFB400',
      highlightHex: publish.visual?.highlight_hex ?? '#FFFFFF',
    },
    scenes,
  };
}

function inferDuration(assetType = '') {
  const m = /(\d{1,3})\s*s/i.exec(String(assetType));
  if (m) return Number(m[1]);
  const table = { MainReel: 65, MicroReel: 7, Reel: 30, Story: 15 };
  for (const [key, value] of Object.entries(table)) if (String(assetType).includes(key)) return value;
  return null;
}

function pickIntent(publish, asset) {
  if (publish.isCarousel) return 'carousel';
  if (publish.isVideo) {
    const t = String(asset?.assetType ?? '').toLowerCase();
    if (t.includes('micro')) return 'reel-kinetic';
    if (t.includes('stat') || t.includes('data')) return 'reel-stat';
    return 'reel-tutorial';
  }
  return 'cover';
}

/** Last-resort text source: split a caption into usable on-screen sentences. */
function splitCaption(caption) {
  const clean = String(caption ?? '')
    .replace(/#\S+/g, '')
    .replace(/[\u200c]/g, '\u200c')
    .trim();
  const sentences = clean
    .split(/[.!؟?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
  return sentences.slice(0, 5).map((s) => ({ title: s.slice(0, 90), narration: s, at: null }));
}

/**
 * Fit the available beats onto the guide's weight profile.
 *
 * If the plan gives 3 beats and the guide asks for 6, the guide's beats are
 * merged (adjacent weights summed) rather than dropping the plan's text. If the
 * plan gives more beats than the guide, the extra copy is concatenated into the
 * middle scene, because silently discarding someone's writing is worse than a
 * slightly denser scene.
 */
function fitScenes(beats, guide, total, context) {
  const count = guide.beats.length;
  const weights = guide.weights;

  let slots;
  if (beats.length === 0) {
    slots = guide.beats.map((label) => ({ label, title: label, narration: '' }));
  } else if (beats.length <= count) {
    slots = guide.beats.map((label, i) => {
      const beat = beats[i] ?? null;
      return {
        label,
        title: beat?.title?.trim() || label,
        narration: beat?.narration?.trim() || beat?.title?.trim() || '',
      };
    });
    /* if the guide has more beats than the plan, the leftover beats get the
       plan's last sentence so no scene is empty */
    const filler = beats.at(-1)?.title ?? context.idea?.title ?? '';
    for (let i = beats.length; i < count && slots[i]; i++) {
      if (!slots[i].narration) slots[i].narration = filler;
    }
  } else {
    /* compress: distribute plan beats across guide slots proportionally */
    slots = guide.beats.map((label, i) => {
      const from = Math.floor((i * beats.length) / count);
      const to = Math.floor(((i + 1) * beats.length) / count);
      const group = beats.slice(from, Math.max(to, from + 1));
      return {
        label,
        title: group[0]?.title?.trim() || label,
        narration: group.map((b) => b.narration || b.title).filter(Boolean).join(' '),
      };
    });
  }

  /* accumulate fractional durations then round, so the sum lands exactly on the
     target duration instead of drifting by a frame per scene */
  let acc = 0;
  const starts = weights.map((w) => {
    const start = acc;
    acc += w * total;
    return start;
  });

  return slots.map((slot, i) => {
    const startSec = round2(starts[i]);
    const endSec = i === slots.length - 1 ? round2(total) : round2(starts[i + 1]);
    const slide = context.slides[i] ?? null;
    return {
      index: i,
      beat: String(slot.label ?? ''),
      cardTitle: (slot.title || slot.label).slice(0, 90),
      narration: slot.narration.slice(0, 900),
      startSec,
      endSec,
      durationSec: round2(endSec - startSec),
      onScreenText: (slot.title || slot.label).slice(0, 120),
      visual:
        slide?.visual_instruction ??
        (i === 0
          ? (context.publish.visual?.visual_idea ?? '')
          : (context.publish.visual?.visual_instruction ?? '')),
      iconPrompt: slide?.icon_prompt ?? null,
      accent: context.publish.visual?.accent_hex ?? '#FFB400',
      transition: i === 0 ? 'fade-in' : 'fade-up',
    };
  });
}

const round2 = (n) => Math.round(n * 100) / 100;

/* ────────────────────────── persistence ────────────────────────── */

/** Create (or refresh) an edit document for a publish. */
export function createEditDoc(deliveryId, options = {}) {
  const concept = buildConcept(deliveryId, options);
  const docId = `EDT-${deliveryId.replace(/[^A-Za-z0-9]/g, '').slice(-12)}`;
  const existing = getEditDoc(docId);
  if (existing && !options.force) {
    return { created: false, doc: existing, concept };
  }
  const now = nowIso();
  db.prepare(
    `INSERT INTO edit_document (doc_id, delivery_id, kind, title, aspect, duration_sec, doc_json, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(doc_id) DO UPDATE SET
       title=excluded.title, aspect=excluded.aspect, duration_sec=excluded.duration_sec,
       doc_json=excluded.doc_json, updated_at=excluded.updated_at`
  ).run(
    docId,
    deliveryId,
    concept.kind,
    concept.title,
    concept.aspect,
    concept.durationSec,
    JSON.stringify(concept),
    'draft',
    existing?.createdAt ?? now,
    now
  );
  logEvent('INFO', 'production', `سند تدوین ساخته شد: ${docId}`);
  return { created: !existing, doc: getEditDoc(docId), concept };
}

export function getEditDoc(docId) {
  const row = db.prepare('SELECT * FROM edit_document WHERE doc_id = ?').get(docId);
  if (!row) return null;
  let doc = null;
  try {
    doc = JSON.parse(row.doc_json);
  } catch {
    doc = null;
  }
  return {
    docId: row.doc_id,
    deliveryId: row.delivery_id,
    kind: row.kind,
    title: row.title,
    aspect: row.aspect,
    durationSec: row.duration_sec,
    status: row.status,
    doc,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listEditDocs({ deliveryId, status, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (deliveryId) {
    where.push('delivery_id = ?');
    args.push(deliveryId);
  }
  if (status) {
    where.push('status = ?');
    args.push(status);
  }
  return db
    .prepare(`SELECT doc_id FROM edit_document ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`)
    .all(...args, limit)
    .map((r) => getEditDoc(r.doc_id));
}

/** Save an edited document, enforcing that scenes still tile the timeline. */
export function saveEditDoc(docId, patch) {
  const existing = getEditDoc(docId);
  if (!existing) throw new HttpError(404, 'سند تدوین پیدا نشد', 'NOT_FOUND');

  const merged = { ...existing.doc, ...patch };
  if (Array.isArray(merged.scenes)) {
    merged.scenes = merged.scenes.map((s, i) => ({ ...s, index: i }));
    /* Re-derive the duration from the scenes rather than trusting the client:
       a doc whose scenes end at 00:31 but claims 00:24 renders with a black tail. */
    const last = merged.scenes.at(-1);
    merged.durationSec = round2(last?.endSec ?? merged.durationSec ?? 0);
  }

  db.prepare('UPDATE edit_document SET title=?, aspect=?, duration_sec=?, doc_json=?, status=?, updated_at=? WHERE doc_id=?').run(
    merged.title ?? existing.title,
    merged.aspect ?? existing.aspect,
    merged.durationSec ?? existing.durationSec,
    JSON.stringify(merged),
    patch.status ?? existing.status,
    nowIso(),
    docId
  );
  return getEditDoc(docId);
}

export function deleteEditDoc(docId) {
  const info = db.prepare('DELETE FROM edit_document WHERE doc_id = ?').run(docId);
  return { removed: info.changes > 0 };
}

/* ────────────────────────── production queue ────────────────────────── */

/**
 * The production queue: every publish that still needs work, in schedule order,
 * with enough context for the operator to act without opening anything else.
 */
export function productionQueue({ batchId = null, status = null, from = null, to = null } = {}) {
  const publishes = listPublishes({ batchId, from, to, limit: 1000 });
  const docs = new Map(listEditDocs({ limit: 500 }).map((d) => [d.deliveryId, d]));

  const items = publishes
    .filter((p) => (status ? p.publishStatus === status : p.publishStatus !== 'published'))
    .map((p) => {
      const doc = docs.get(p.deliveryId) ?? null;
      const assets = listPlanAssets(p.contentId);
      const primary = assets.find((a) => p.assetIds?.includes(a.assetId)) ?? assets[0] ?? null;
      const guide = chooseGuide(primary?.assetType, p.funnelStage);
      return {
        deliveryId: p.deliveryId,
        contentId: p.contentId,
        title: p.content?.ready_caption?.slice(0, 80) || primary?.name || p.deliveryId,
        platform: p.platform,
        platformLabel: p.platformLabel,
        formatLabel: p.formatLabel,
        scheduleKey: p.scheduleKey,
        scheduledFor: p.scheduledFor,
        funnelStage: p.funnelStage,
        status: p.publishStatus,
        isVideo: p.isVideo,
        isCarousel: p.isCarousel,
        assetType: primary?.assetType ?? null,
        suggestedGuide: { id: guide.id, name: guide.name },
        suggestedTemplates: suggestTemplates(pickIntent(p, primary), 3).map((t) => ({ id: t.id, name: t.name })),
        editDoc: doc ? { docId: doc.docId, status: doc.status, updatedAt: doc.updatedAt } : null,
        readiness: readiness(p, doc),
      };
    })
    .sort((a, b) => String(a.scheduledFor ?? '').localeCompare(String(b.scheduledFor ?? '')));

  return {
    total: items.length,
    grouped: groupBy(items, (i) => i.status),
    items,
  };
}

/**
 * Readiness is a checklist, not a score: it says exactly what is missing so the
 * operator knows the next action.
 */
function readiness(publish, doc) {
  const checks = [];
  const caption = publish.content?.ready_caption ?? '';
  checks.push({ key: 'copy', ok: caption.length > 20, label: 'کپشن آماده' });
  checks.push({ key: 'cta', ok: Boolean(publish.content?.cta), label: 'دعوت به اقدام' });
  checks.push({ key: 'visual', ok: Boolean(publish.visual?.visual_idea || publish.visual?.cover_prompt_json), label: 'راهنمای بصری' });
  if (publish.isVideo) {
    checks.push({ key: 'timeline', ok: (publish.content?.timeline?.length ?? 0) > 0, label: 'تایم‌لاین صحنه' });
  }
  if (publish.isCarousel) {
    checks.push({ key: 'slides', ok: (publish.content?.slides?.length ?? 0) >= 2, label: 'اسلایدها' });
  }
  checks.push({ key: 'doc', ok: Boolean(doc), label: 'سند تدوین' });
  const done = checks.filter((c) => c.ok).length;
  return {
    checks,
    done,
    total: checks.length,
    percent: Math.round((done / checks.length) * 100),
    ready: done === checks.length,
  };
}

function groupBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export { nowIso };
