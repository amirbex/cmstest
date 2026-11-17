/**
 * Content pipeline service.
 *
 * The v5.0 flow created one delivery per idea and then *another* delivery per
 * delivery row, so a 2-idea block produced 4 orphans. Here a single pass builds
 * an index by content_id, enriches ideas with their delivery rows, and writes
 * exactly one content + one delivery per logical item.
 */
import {
  PuzzleBlock,
  CreativePlan,
  CarouselSlide,
  Scene,
  Subbrand,
  DeliverableType,
  FunnelStage,
} from '@atoz/contracts';
import {
  upsertBlueprint,
  getContent,
  listContents,
  pillarToSection,
  normaliseBatchId,
  formatToPlatform,
  recordPuzzleIngest,
  updatePlan,
  setContentStatus,
  approveBlueprints,
  notify,
  tx,
  logEvent,
} from './repo.js';
import { db, nowIso } from '../lib/db.js';

/* ────────────────────────── helpers ────────────────────────── */

const PLATFORM_FOR_TYPE = {
  reel: 'instagram',
  carousel: 'instagram',
  post: 'instagram',
  cover: 'instagram',
  article: 'website',
  youtube: 'youtube',
};

function normaliseType(raw = '') {
  const value = String(raw).toLowerCase();
  if (value.includes('carousel') || value.includes('car')) return 'carousel';
  if (value.includes('article') || value.includes('mag') || value.includes('web')) return 'article';
  if (value.includes('youtube') || value.includes('yt')) return 'youtube';
  if (value.includes('post') || value.includes('single') || value.includes('sng')) return 'post';
  if (value.includes('cover')) return 'cover';
  return 'reel';
}

function scheduleToDate(scheduleKey, fallback = null) {
  // schedule keys look like M01-W01-D03-IG-ANM-01 — D01..D07 map to the next
  // seven days from today when no explicit date is supplied.
  const match = String(scheduleKey ?? '').match(/D(\d{2})/);
  if (!match) return fallback;
  const dayIndex = Math.min(7, Math.max(1, Number(match[1]))) - 1;
  const date = new Date();
  date.setHours(9, 0, 0, 0);
  date.setDate(date.getDate() + dayIndex);
  return date.toISOString();
}

/* ────────────────────────── plan building ────────────────────────── */

function planFromPuzzle({ idea, delivery, section }) {
  const exact = delivery?.exact_content ?? {};
  const timeline = exact.timeline ?? [];
  const slides = exact.slides ?? [];

  const scenes = timeline.length
    ? timeline.map((entry, index) =>
        Scene.parse({
          id: index + 1,
          eyebrow: entry.time || `بخش ${index + 1}`,
          cardTitle: (entry.on_screen_text || idea.title).slice(0, 110),
          metric: `۰${index + 1}`,
          metricCaption: '',
          items: [entry.narration_script || entry.on_screen_text].filter(Boolean),
          narration: entry.narration_script ?? '',
        })
      )
    : [
        Scene.parse({
          id: 1,
          eyebrow: section,
          cardTitle: idea.title,
          metric: '—',
          metricCaption: idea.thread ?? '',
          items: [idea.thread || idea.title],
          narration: exact.ready_caption ?? '',
        }),
      ];

  const carouselSlides = slides.length
    ? slides.map((slide, index) =>
        CarouselSlide.parse({
          slideNumber: index + 1,
          templateType: index === 0 ? 'cover' : index === slides.length - 1 ? 'cta' : 'blueprint',
          badge: section,
          heading: slide.title || idea.title,
          body: slide.body_text ?? '',
          highlightMetric: '',
        })
      )
    : [
        CarouselSlide.parse({
          slideNumber: 1,
          templateType: 'cover',
          badge: section,
          heading: idea.title,
          body: idea.thread ?? '',
          highlightMetric: 'AtoZ.FnB',
        }),
      ];

  return CreativePlan.parse({
    title: idea.title,
    subtitle: idea.thread ?? '',
    sectionCode: section,
    funnelStage: delivery?.funnel_stage ?? idea.funnel_stage ?? 'MOFU',
    voiceoverScript: timeline.map((t) => t.narration_script).filter(Boolean).join(' ') || exact.ready_caption || '',
    articleHtml: exact.article_outline || exact.page_copy || '',
    scenes,
    carouselSlides,
    social: {
      instagramCaption: exact.ready_caption ?? '',
      telegramPost: exact.ready_post_text ?? '',
    },
  });
}

/* ────────────────────────── ingest ────────────────────────── */

/**
 * Ingest a weekly puzzle block. Strictly validated; idempotent per content_id;
 * exactly one delivery per content.
 */
export function ingestPuzzleBlock(rawBlock) {
  const block = PuzzleBlock.parse(rawBlock);
  const periodCode = block.schema_metadata.period_code;
  const batchId = normaliseBatchId(periodCode, block.schema_metadata.batch_id);

  const deliveriesByContent = new Map();
  for (const d of block.deliveries) {
    if (!deliveriesByContent.has(d.content_id)) deliveriesByContent.set(d.content_id, []);
    deliveriesByContent.get(d.content_id).push(d);
  }

  // content ids that only appear in `deliveries` and not in `content_ideas`
  const orphanDeliveryIds = [...deliveriesByContent.keys()].filter(
    (id) => !block.content_ideas.some((idea) => idea.content_id === id)
  );

  const created = [];
  const seen = new Set();

  const write = ({ contentId, title, thread, section, type, scheduleKey, delivery }) => {
    if (seen.has(contentId)) return;
    seen.add(contentId);
    const result = upsertBlueprint({
      contentId,
      deliveryId: delivery?.delivery_id ?? null,
      batchId,
      title,
      sectionCode: section,
      deliverableType: type,
      funnelStage: delivery?.funnel_stage ?? 'MOFU',
      scheduleKey: scheduleKey ?? '',
      platform: PLATFORM_FOR_TYPE[type] ?? 'instagram',
      scheduledFor: scheduleToDate(scheduleKey),
      status: 'blueprint_pending',
      plan: planFromPuzzle({ idea: { title, thread }, delivery, section }),
    });
    created.push({ ...result, title, type, section });
  };

  tx(() => {
    for (const idea of block.content_ideas) {
      const section = pillarToSection(idea.pillar);
      const linked = deliveriesByContent.get(idea.content_id) ?? [];
      const primary = linked[0] ?? null;
      write({
        contentId: idea.content_id ?? null,
        title: idea.title,
        thread: idea.thread,
        section,
        type: normaliseType(primary?.format_type),
        scheduleKey: primary?.schedule_key ?? '',
        delivery: primary,
      });
    }

    for (const contentId of orphanDeliveryIds) {
      const list = deliveriesByContent.get(contentId);
      for (const delivery of list) {
        const section = pillarToSection(delivery.content_pillar);
        write({
          contentId,
          title: delivery.strategic_positioning?.topic || delivery.format_type,
          thread: '',
          section,
          type: normaliseType(delivery.format_type),
          scheduleKey: delivery.schedule_key,
          delivery,
        });
      }
    }

    recordPuzzleIngest(periodCode, batchId, block.content_ideas.length, created.length);
  });

  logEvent('INFO', 'ingest', `بلوک ${periodCode}: ${created.length} محتوا ثبت شد`);
  return {
    periodCode,
    batchId,
    ideasCount: block.content_ideas.length,
    deliveriesInFile: block.deliveries.length,
    contentsCreated: created.length,
    items: created,
    warnings:
      block.deliveries.length > created.length
        ? ['چند تحویل به یک محتوا تعلق داشتند و طبق قاعده یک محتوا = یک تحویل ادغام شدند.']
        : [],
  };
}

/* ────────────────────────── AI generated batch ────────────────────────── */

export function persistGeneratedBatch({ deliverables, conceptTitle, sectionCode, counts, baseDate = new Date(), source = 'ai' }) {
  const created = [];
  tx(() => {
    deliverables.forEach((item, index) => {
      const type = DeliverableType.safeParse(item.type).success ? item.type : 'reel';
      const section = Subbrand.safeParse(sectionCode).success ? sectionCode : 'Library';
      const date = new Date(baseDate);
      date.setDate(date.getDate() + index);
      date.setHours(10, 0, 0, 0);
      const scheduleKey = `AI-${date.toISOString().slice(0, 10)}-${String(index + 1).padStart(2, '0')}`;

      const plan = CreativePlan.parse({
        title: item.title || `${conceptTitle} ${index + 1}`,
        subtitle: item.subtitle ?? '',
        sectionCode: section,
        funnelStage: FunnelStage.safeParse(item.social?.funnelStage).success ? item.social.funnelStage : 'MOFU',
        voiceoverScript: item.voiceoverScript ?? '',
        articleHtml: item.articleHtml ?? '',
        scenes: (item.scenes ?? []).map((s, i) =>
          Scene.parse({ ...s, id: s.id ?? i + 1, motion: i === 0 ? 'fade-up' : 'fade-up' })
        ),
        carouselSlides: (item.carouselSlides ?? []).map((s, i) =>
          CarouselSlide.parse({ ...s, slideNumber: i + 1 })
        ),
        social: item.social ?? {},
      });

      const record = upsertBlueprint({
        batchId: `ATZ-B-AI-${Date.now().toString(36).toUpperCase()}`,
        title: plan.title,
        sectionCode: section,
        deliverableType: type,
        funnelStage: plan.funnelStage,
        scheduleKey,
        platform: PLATFORM_FOR_TYPE[type],
        scheduledFor: date.toISOString(),
        status: 'blueprint_pending',
        plan,
      });
      created.push({ ...record, type, title: plan.title, source });
    });
  });
  notify('success', `${created.length} الگوی محتوا ساخته شد و منتظر تایید است.`);
  return created;
}

/* ────────────────────────── mutations re-exported ────────────────────────── */

export {
  getContent,
  listContents,
  updatePlan,
  setContentStatus,
  approveBlueprints,
  notify,
};

/** Duplicate a content as a new draft (studio "clone" action). */
export function duplicateContent(contentId) {
  const source = getContent(contentId);
  if (!source) return null;
  const copy = upsertBlueprint({
    batchId: source.batchId,
    title: `${source.title} (کپی)`,
    sectionCode: source.sectionCode,
    deliverableType: source.deliverableType,
    funnelStage: source.funnelStage,
    scheduleKey: source.scheduleKey,
    status: 'draft',
    plan: { ...source.plan, title: `${source.title} (کپی)` },
  });
  return copy;
}

export function archiveContent(contentId) {
  return setContentStatus(contentId, 'archived');
}

export function bulkSetStatus(ids, status) {
  const out = [];
  tx(() => {
    for (const id of ids) out.push(setContentStatus(id, status));
  });
  return out.filter(Boolean);
}

export function seedDemoIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM content').get().n;
  if (count > 0) return { seeded: false, count };
  const demo = {
    schema_metadata: { period_code: 'M01-W01-PART1', batch_id: 'ATZ-B-M01-W01-P1' },
    content_ideas: [
      { content_id: 'ATZ-C-900001', title: 'چگونه ضایعات کافه را ۳۰ درصد کم کنیم', thread: 'مدیریت هزینه مواد اولیه', pillar: 'P1' },
      { content_id: 'ATZ-C-900002', title: 'سه شاخص مالی که هر کافه باید هفتگی ببیند', thread: 'داشبورد مالی ساده', pillar: 'P4' },
    ],
    deliveries: [
      {
        content_id: 'ATZ-C-900001',
        delivery_id: 'ATZ-D-900001',
        format_type: 'reel',
        schedule_key: 'M01-W01-D01-IG-ANM-01',
        funnel_stage: 'TOFU',
        content_pillar: 'P1',
        strategic_positioning: { topic: 'کاهش ضایعات' },
        exact_content: {
          ready_caption: 'سه گام ساده برای کاهش ضایعات کافه — ابزار کامل در atozfnb.info',
          timeline: [
            { time: '۰ تا ۳ ثانیه', on_screen_text: 'ضایعات کجا پنهان می‌شود؟', narration_script: 'اولین قدم این است که هر روز دورریز را ثبت کنید.' },
            { time: '۳ تا ۸ ثانیه', on_screen_text: 'سه نقطه هدررفت', narration_script: 'شیر و خامه، قهوه و میوه سه نقطه اصلی هدررفت هستند.' },
            { time: '۸ تا ۱۵ ثانیه', on_screen_text: 'استانداردسازی ساده', narration_script: 'یک چک‌لیست ساده بنویسید و کنار دستگاه بچسبانید.' },
          ],
        },
      },
      {
        content_id: 'ATZ-C-900002',
        delivery_id: 'ATZ-D-900002',
        format_type: 'carousel',
        schedule_key: 'M01-W01-D02-IG-CAR-01',
        funnel_stage: 'MOFU',
        content_pillar: 'P4',
        strategic_positioning: { topic: 'شاخص‌های مالی هفتگی' },
        exact_content: {
          ready_caption: 'سه شاخصی که هر هفته باید ببینی',
          slides: [
            { slide_number: 1, title: 'سه شاخص مالی هفتگی', body_text: 'داشبورد ساده برای کافه‌های کوچک' },
            { slide_number: 2, title: 'نسبت هزینه مواد', body_text: 'هر هفته هزینه مواد را به فروش تقسیم کن.' },
            { slide_number: 3, title: 'میانگین سبد', body_text: 'روند میانگین سبد را هفته‌به‌هفته مقایسه کن.' },
            { slide_number: 4, title: 'ابزار در وب‌سایت', body_text: 'ماشین‌حساب‌ها در atozfnb.info' },
          ],
        },
      },
    ],
  };
  return { seeded: true, summary: ingestPuzzleBlock(demo) };
}
