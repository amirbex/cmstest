/**
 * @atoz/contracts — single source of truth for every data shape in the system.
 *
 * Derived from the v5.0 domain model but hardened: every boundary (HTTP body,
 * AI model output, uploaded JSON, job payload) is parsed with these schemas.
 * Zero runtime dependencies beyond zod so it can be imported by server,
 * web client and tests alike.
 */
import { z } from 'zod';

/* ────────────────────────── primitives ────────────────────────── */

export const ContentId = z
  .string()
  .regex(/^ATZ-C-\d{6}$/, 'content_id must look like ATZ-C-000123');

export const DeliveryId = z
  .string()
  .regex(/^ATZ-D-\d{6}$/, 'delivery_id must look like ATZ-D-000123');

/**
 * Asset id. Accepts the bare id and the versioned sub-file form:
 *   ATZ-A-000001
 *   ATZ-A-000001-CVR-V1
 *   ATZ-A-000007-REEL-INS-V2
 * The middle segment is one or more uppercase code groups, always terminated by
 * a `V<n>` version, which is what keeps the id unambiguous to split.
 */
export const AssetId = z
  .string()
  .regex(
    /^ATZ-A-\d{6}(?:-[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-V\d+)?$/,
    'asset id must look like ATZ-A-000001 or ATZ-A-000001-CVR-V1'
  );

/** Persian-first slug: keeps letters, digits, ZWNJ and dashes. */
export const Slug = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[\p{L}\p{N}\u200c\-_]+$/u, 'slug contains unsupported characters');

export const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/* ────────────────────────── enums ────────────────────────── */

export const SUBBRANDS = ['AI', 'Library', 'Magazine', 'Calculators', 'Solutions', 'Academy'] as const;
export const Subbrand = z.enum(SUBBRANDS);
export type Subbrand = z.infer<typeof Subbrand>;

export const FUNNEL_STAGES = ['TOFU', 'MOFU', 'BOFU'] as const;
export const FunnelStage = z.enum(FUNNEL_STAGES);
export type FunnelStage = z.infer<typeof FunnelStage>;

export const DELIVERABLE_TYPES = ['reel', 'carousel', 'cover', 'post', 'article', 'youtube'] as const;
export const DeliverableType = z.enum(DELIVERABLE_TYPES);
export type DeliverableType = z.infer<typeof DeliverableType>;

export const PLATFORMS = ['instagram', 'telegram', 'youtube', 'website'] as const;
export const Platform = z.enum(PLATFORMS);
export type Platform = z.infer<typeof Platform>;

/**
 * The production state machine. v5.0 leaked these as raw strings all over the
 * codebase; here they are the only legal values and transitions are enforced
 * in the service layer.
 */
export const CONTENT_STATUS = [
  'draft',                  // being authored by a human in the studio
  'blueprint_pending',      // generated, waiting for human approval
  'approved_for_production',// approved, eligible for the render queue
  'queued',                 // a render job exists for it
  'rendering',
  'produced',               // assets rendered and verified
  'scheduled',              // placed on the jalali calendar
  'published',
  'failed',
  'archived',
] as const;
export const ContentStatus = z.enum(CONTENT_STATUS);
export type ContentStatus = z.infer<typeof ContentStatus>;

export const JOB_STATUS = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const JobStatus = z.enum(JOB_STATUS);
export type JobStatus = z.infer<typeof JobStatus>;

export const JOB_KINDS = ['cover', 'carousel', 'reel', 'pack'] as const;
export const JobKind = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof JobKind>;

/* ────────────────────────── brand ────────────────────────── */

export const SectionTheme = z.object({
  id: Subbrand,
  pillarCode: z.string(),
  subbrandName: z.string(),
  name: z.string(),
  accent: HEX,
  mode: z.enum(['dark', 'light']),
  bg: HEX,
  onAccent: HEX.default('#FFFFFF'),
});
export type SectionTheme = z.infer<typeof SectionTheme>;

export const BrandConfig = z.object({
  brandName: z.string(),
  domain: z.string(),
  handle: z.string(),
  essence: z.string(),
  promise: z.string(),
  cta: z.string().default('مشاهده در وب‌سایت'),
  colors: z.record(z.string(), HEX),
  sectionThemes: z.record(Subbrand, SectionTheme),
  typography: z
    .object({
      family: z.string().default('Vazirmatn'),
      weights: z.array(z.number()).default([400, 600, 700, 800, 900]),
    })
    .default({}),
});
export type BrandConfig = z.infer<typeof BrandConfig>;

/* ────────────────────────── creative plan ────────────────────────── */

export const ChartDatum = z.object({
  label: z.string().max(48),
  value: z.number(),
  color: HEX.optional(),
});
export type ChartDatum = z.infer<typeof ChartDatum>;

/** A single beat of a reel: what is on screen and what the narrator says. */
export const Scene = z.object({
  id: z.number().int().nonnegative().default(0),
  eyebrow: z.string().max(40).default(''),
  cardTitle: z.string().max(120),
  metric: z.string().max(12).default(''),
  metricCaption: z.string().max(60).default(''),
  items: z.array(z.string().max(120)).max(4).default([]),
  chartData: z.array(ChartDatum).max(8).default([]),
  narration: z.string().max(600).default(''),
  /** seconds; filled by the timeline planner */
  durationSec: z.number().positive().default(4),
  /** optional motion preset key, resolved by the render engine */
  motion: z.string().default('fade-up'),
});
export type Scene = z.infer<typeof Scene>;

export const CarouselSlide = z.object({
  slideNumber: z.number().int().min(1),
  templateType: z.enum(['cover', 'blueprint', 'comparison', 'stat', 'quote', 'cta']).default('blueprint'),
  badge: z.string().max(24).default(''),
  heading: z.string().max(120),
  body: z.string().max(500).default(''),
  highlightMetric: z.string().max(24).default(''),
  items: z.array(z.string().max(120)).max(5).default([]),
  chartData: z.array(ChartDatum).max(8).default([]),
});
export type CarouselSlide = z.infer<typeof CarouselSlide>;

export const SocialCopy = z.object({
  instagramCaption: z.string().max(2200).default(''),
  telegramPost: z.string().max(4096).default(''),
  hashtags: z.array(z.string()).max(30).default([]),
  youtubeTitle: z.string().max(100).default(''),
  youtubeDescription: z.string().max(5000).default(''),
  seoTitle: z.string().max(70).default(''),
  seoDescription: z.string().max(170).default(''),
});
export type SocialCopy = z.infer<typeof SocialCopy>;

/**
 * The creative plan is the contract between AI, the layer editor, the motion
 * engine and the renderer. Everything downstream reads only this.
 */
export const CreativePlan = z.object({
  title: z.string().min(1).max(140),
  subtitle: z.string().max(200).default(''),
  sectionCode: Subbrand.default('Library'),
  funnelStage: FunnelStage.default('MOFU'),
  voiceoverScript: z.string().max(6000).default(''),
  articleHtml: z.string().max(60_000).default(''),
  scenes: z.array(Scene).max(24).default([]),
  carouselSlides: z.array(CarouselSlide).max(12).default([]),
  social: SocialCopy.default({}),
  /** per-layer pixel nudges coming from the studio drag surface */
  layout: z
    .object({
      logoX: z.number().default(0),
      logoY: z.number().default(0),
      titleY: z.number().default(0),
      cardY: z.number().default(0),
      logoMotion: z.string().default('kinetic-az'),
      theme: z.enum(['auto', 'dark', 'light']).default('auto'),
      showSafeZones: z.boolean().default(true),
    })
    .default({}),
  audio: z
    .object({
      file: z.string().default(''),
      durationSec: z.number().nonnegative().default(0),
      engine: z.string().default(''),
      /** word-level captions for karaoke */
      words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })).default([]),
    })
    .default({}),
});
export type CreativePlan = z.infer<typeof CreativePlan>;

/* ────────────────────────── records ────────────────────────── */

export const ContentRecord = z.object({
  contentId: ContentId,
  batchId: z.string(),
  title: z.string(),
  sectionCode: Subbrand,
  deliverableType: DeliverableType,
  status: ContentStatus,
  funnelStage: FunnelStage,
  scheduleKey: z.string(),
  plan: CreativePlan,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ContentRecord = z.infer<typeof ContentRecord>;

export const DeliveryRecord = z.object({
  deliveryId: DeliveryId,
  contentId: ContentId,
  platform: Platform,
  scheduleKey: z.string(),
  /** ISO date (Gregorian) — the jalali view is a pure presentation concern */
  scheduledFor: z.string().nullable(),
  status: ContentStatus,
  platformPostId: z.string().nullable(),
  rolloverCount: z.number().int().nonnegative(),
  metrics: z.object({
    reach: z.number().nonnegative().default(0),
    views: z.number().nonnegative().default(0),
    saves: z.number().nonnegative().default(0),
    shares: z.number().nonnegative().default(0),
    clicks: z.number().nonnegative().default(0),
    avgWatchTimeSec: z.number().nonnegative().default(0),
    videoDurationSec: z.number().positive().default(30),
  }),
  kpis: z.object({
    saveRate: z.number(),
    shareRate: z.number(),
    ctr: z.number(),
    avgWatchRatio: z.number(),
  }),
  publishedAt: z.string().nullable(),
});
export type DeliveryRecord = z.infer<typeof DeliveryRecord>;

export const AssetRecord = z.object({
  assetId: AssetId,
  contentId: ContentId,
  kind: z.enum(['video', 'image', 'audio', 'document', 'archive']),
  file: z.string(),
  url: z.string(),
  bytes: z.number(),
  width: z.number().nullable().default(null),
  height: z.number().nullable().default(null),
  durationSec: z.number().nullable().default(null),
  createdAt: z.string(),
});
export type AssetRecord = z.infer<typeof AssetRecord>;

/* ────────────────────────── pipeline input ────────────────────────── */

/**
 * The "weekly block" upload contract. v5.0 accepted anything and silently
 * corrupted the database; here it is strict and normalised.
 */
export const PuzzleIdea = z.object({
  content_id: z.string().optional(),
  title: z.string().min(2).max(200),
  thread: z.string().max(400).default(''),
  pillar: z.string().default('P1'),
  funnel_stage: FunnelStage.optional(),
});

export const PuzzleSlide = z.object({
  slide_number: z.number().int().min(1).optional(),
  title: z.string().default(''),
  body_text: z.string().default(''),
});

export const PuzzleScene = z.object({
  time: z.string().default(''),
  on_screen_text: z.string().default(''),
  narration_script: z.string().default(''),
});

export const PuzzleExactContent = z
  .object({
    ready_caption: z.string().default(''),
    ready_post_text: z.string().default(''),
    article_outline: z.string().default(''),
    page_copy: z.string().default(''),
    slides: z.array(PuzzleSlide).default([]),
    timeline: z.array(PuzzleScene).default([]),
  })
  .default({});

export const PuzzleDelivery = z.object({
  content_id: z.string().min(1),
  delivery_id: z.string().optional(),
  format_type: z.string().default('reel'),
  schedule_key: z.string().default(''),
  funnel_stage: FunnelStage.default('MOFU'),
  content_pillar: z.string().default('P1'),
  strategic_positioning: z.object({ topic: z.string().default('') }).default({}),
  exact_content: PuzzleExactContent,
});

export const PuzzleBlock = z.object({
  schema_metadata: z.object({
    period_code: z.string().min(3),
    batch_id: z.string().optional(),
    month: z.number().int().min(1).max(12).optional(),
    week: z.number().int().min(1).max(5).optional(),
  }),
  content_ideas: z.array(PuzzleIdea).min(1, 'a block needs at least one idea'),
  deliveries: z.array(PuzzleDelivery).default([]),
});
export type PuzzleBlock = z.infer<typeof PuzzleBlock>;

/* ────────────────────────── AI output contracts ────────────────────────── */

export const ConceptOption = z.object({
  angleTitle: z.string().max(140),
  summary: z.string().max(600),
  recommendedFunnel: FunnelStage.default('MOFU'),
  keyMetric: z.string().max(12).default(''),
  hook: z.string().max(200).default(''),
});

export const ConceptResponse = z.object({
  topicAnalysis: z.string().max(900),
  concepts: z.array(ConceptOption).min(1).max(5),
});
export type ConceptResponse = z.infer<typeof ConceptResponse>;

export const FactoryDeliverable = z.object({
  type: DeliverableType,
  title: z.string().max(140),
  subtitle: z.string().max(200).default(''),
  voiceoverScript: z.string().max(2500).default(''),
  articleHtml: z.string().max(40_000).default(''),
  scenes: z.array(Scene.omit({ durationSec: true, motion: true })).max(12).default([]),
  carouselSlides: z.array(CarouselSlide.omit({ slideNumber: true })).max(10).default([]),
  social: SocialCopy.default({}),
});

export const FactoryResponse = z.object({
  deliverables: z.array(FactoryDeliverable).min(1).max(12),
});
export type FactoryResponse = z.infer<typeof FactoryResponse>;

export const AtoozDecision = z.object({
  reply: z.string().max(1500),
  action: z
    .enum(['NONE', 'CREATE_IDEA', 'APPROVE_ALL_BLUEPRINTS', 'RENDER', 'OPEN_ROOM', 'MOVE_TO_EDIT'])
    .default('NONE'),
  requiresConfirmation: z.boolean().default(false),
  ideaTopic: z.string().nullable().default(null),
  sectionCode: Subbrand.default('Library'),
  targetRoom: z.string().nullable().default(null),
  targetContentId: z.string().nullable().default(null),
  mcpToolCalled: z.string().nullable().default(null),
});
export type AtoozDecision = z.infer<typeof AtoozDecision>;

/* ────────────────────────── API envelopes ────────────────────────── */

export const RenderRequest = z.object({
  contentId: ContentId,
  kinds: z.array(JobKind).min(1).default(['cover']),
});
export type RenderRequest = z.infer<typeof RenderRequest>;

export const VoiceRequest = z.object({
  contentId: ContentId.optional(),
  scriptText: z.string().min(1).max(4000),
  engine: z.enum(['auto', 'piper', 'edge', 'espeak', 'system']).default('auto'),
});
export type VoiceRequest = z.infer<typeof VoiceRequest>;

export const ok = <T>(data: T) => ({ success: true as const, data });
export const fail = (error: string, code = 'ERROR') => ({ success: false as const, error, code });
export type ApiResult<T> = ReturnType<typeof ok<T>> | ReturnType<typeof fail>;

/* ═══════════════════════════════════════════════════════════════════════════
 * AtoZ.FnB schema v3.0 — the real content-ops model
 *
 * Derived from docs/reference/atoz-schema-v3.md and the production plan
 * ATZ-B-M01-W01-P1 (19 ideas, 25 assets, 48 deliveries). The v6 model was a
 * simplification: one delivery per idea, no assets, no schedule-key grammar,
 * no funnel CTA graph, no 3-window performance snapshots, no human quality
 * evaluation. This section replaces it.
 *
 * Six identifiers, each with a distinct lifetime:
 *   batch_id      fixed per plan file        ATZ-B-M01-W01-P1
 *   content_id    immutable idea             ATZ-C-000001
 *   delivery_id   one publish event          ATZ-D-000001
 *   schedule_key  movable calendar address   M01-W01-D01-IG-CAR-01
 *   asset_id      versioned file             ATZ-A-000001-CVR-V1
 *   platform_post_id  assigned after publish 1804928...
 * ═══════════════════════════════════════════════════════════════════════════ */

export const BatchId = z.string().regex(/^ATZ-B-M\d{2}-W\d{2}-P\d+$/, 'batch_id must look like ATZ-B-M01-W01-P1');

/** Asset ids may carry a versioned sub-file suffix: ATZ-A-000001-CVR-V1 */
export const VersionedAssetId = z
  .string()
  .regex(
    /^ATZ-A-\d{6}(-[A-Z0-9]{2,12}(?:-[A-Z0-9]{2,12})*-V\d+)?$/,
    'asset id must look like ATZ-A-000001 or ATZ-A-000001-CVR-V1'
  );

/** PLT codes and FMT codes from the schema document. */
export const PLATFORM_CODES = ['IG', 'TG', 'YT', 'WEB'] as const;
export const PlatformCode = z.enum(PLATFORM_CODES);

export const FORMAT_CODES = [
  'CAR', // carousel 6-10 slides
  'REL', // main reel 45-90s talking head / storytelling
  'MNR', // mini reel 15-30s
  'MCR', // micro reel 5-10s
  'ANM', // animated voiceover reel
  'SNG', // single post / infographic / quote
  'STR', // story
  'MAG', // magazine long article
  'LIB', // library / SOP resource
  'PRM', // prompt bank card
  'CLC', // calculator tool
  'SOL', // solutions page
  'ACD', // academy course
  'CHN', // telegram channel post
  'VID', // long youtube video
  'SHT', // youtube short
  'FEED', // generic feed post
] as const;
export const FormatCode = z.enum(FORMAT_CODES);
export type FormatCode = z.infer<typeof FormatCode>;

/** M01-W01-D01-IG-CAR-01 — six hyphen-separated parts, exactly as documented. */
export const ScheduleKey = z
  .string()
  .regex(
    /^M\d{2}-W\d{2}-D\d{2}-(IG|TG|YT|WEB)-[A-Z]{2,4}-\d{2}$/,
    'schedule_key must look like M01-W01-D01-IG-CAR-01'
  );

export const PLATFORM_LABEL: Record<PlatformCode, string> = {
  IG: 'اینستاگرام',
  TG: 'تلگرام',
  YT: 'یوتیوب',
  WEB: 'وب‌سایت',
};

/** Human-readable format names, used by the UI and the calendar. */
export const FORMAT_LABEL: Record<FormatCode, string> = {
  CAR: 'کاروسل',
  REL: 'ریلز اصلی',
  MNR: 'مینی‌ریلز',
  MCR: 'میکروریلز',
  ANM: 'ریلز انیمیشن',
  SNG: 'پست تکی',
  STR: 'استوری',
  MAG: 'مقاله مجله',
  LIB: 'منبع کتابخانه',
  PRM: 'کارت پرامپت',
  CLC: 'ماشین‌حساب',
  SOL: 'صفحه راهکار',
  ACD: 'دوره آکادمی',
  CHN: 'پست کانال',
  VID: 'ویدیوی بلند',
  SHT: 'شورت یوتیوب',
  FEED: 'پست فید',
};

/** Whether a format is renderable by the local engine (vs. authored by hand). */
export const RENDERABLE_FORMATS: FormatCode[] = ['CAR', 'REL', 'MNR', 'MCR', 'ANM', 'SNG', 'STR', 'SHT'];

export const ASSET_SUFFIXES = [
  'CVR', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', // carousel
  'BG', 'FINAL', // background, final
  'RAW', 'BROLL', 'ANIM', 'VO', 'UI', 'EDIT', // video
  'BOOK-EN', 'BOOK-FA', 'TMPL-PDF', 'TMPL-XLSX', 'CARD-JSON', // documents
] as const;
export const AssetSuffix = z.enum(ASSET_SUFFIXES);

/* ────────────────────────── asset record ────────────────────────── */

export const PlanAsset = z.object({
  asset_id: VersionedAssetId,
  content_id: ContentId,
  asset_type: z.string().max(60),
  name: z.string().max(300),
  storage_location: z.string().max(300).default(''),
  version_and_subfile_codes: z.array(VersionedAssetId).max(20).default([]),
});
export type PlanAsset = z.infer<typeof PlanAsset>;

/* ────────────────────────── performance & quality ────────────────────────── */

export const SnapshotWindow = z.enum(['24h', '7d', '30d']);
export type SnapshotWindow = z.infer<typeof SnapshotWindow>;

/**
 * Raw metrics are stored exactly as reported by the platform; KPIs are always
 * derived, never entered. That separation is what keeps the analytics honest.
 */
export const RawMetrics = z
  .object({
    reach: z.number().nonnegative().nullable().default(null),
    views: z.number().nonnegative().nullable().default(null),
    likes: z.number().nonnegative().nullable().default(null),
    comments: z.number().nonnegative().nullable().default(null),
    saves: z.number().nonnegative().nullable().default(null),
    shares: z.number().nonnegative().nullable().default(null),
    clicks: z.number().nonnegative().nullable().default(null),
    replies_and_sticker_taps: z.number().nonnegative().nullable().default(null),
    avg_watch_time_sec: z.number().nonnegative().nullable().default(null),
    video_duration_sec: z.number().nonnegative().nullable().default(null),
    unique_page_views: z.number().nonnegative().nullable().default(null),
    asset_downloads_or_tool_runs: z.number().nonnegative().nullable().default(null),
    newsletter_signups: z.number().nonnegative().nullable().default(null),
    avg_time_on_page_sec: z.number().nonnegative().nullable().default(null),
  })
  .partial()
  .default({});
export type RawMetrics = z.infer<typeof RawMetrics>;

export const CalculatedKpis = z
  .object({
    save_rate: z.number().nullable().default(null),
    share_rate: z.number().nullable().default(null),
    ctr: z.number().nullable().default(null),
    engagement_rate_by_reach: z.number().nullable().default(null),
    avg_watch_ratio: z.number().nullable().default(null),
    story_reply_rate: z.number().nullable().default(null),
    web_asset_conversion: z.number().nullable().default(null),
  })
  .partial()
  .default({});
export type CalculatedKpis = z.infer<typeof CalculatedKpis>;

export const PerformanceSnapshot = z.object({
  window: SnapshotWindow,
  captured_at: z.string().nullable().default(null),
  raw_metrics: RawMetrics,
  calculated_kpis: CalculatedKpis,
  /** who or what produced the numbers: manual, csv, api */
  source: z.enum(['manual', 'csv', 'api']).default('manual'),
});
export type PerformanceSnapshot = z.infer<typeof PerformanceSnapshot>;

export const QUALITY_AXES = [
  'factual_and_domain_accuracy',
  'brand_tone_and_visual_alignment',
  'clarity_and_structure',
  'actionability_for_persona',
] as const;
export const QualityAxis = z.enum(QUALITY_AXES);
export type QualityAxis = z.infer<typeof QualityAxis>;

export const QUALITY_AXIS_LABEL: Record<QualityAxis, string> = {
  factual_and_domain_accuracy: 'صحت علمی و تخصصی',
  brand_tone_and_visual_alignment: 'تناسب با لحن و هویت بصری',
  clarity_and_structure: 'وضوح پیام و ساختار',
  actionability_for_persona: 'کاربردی‌بودن برای پرسونا',
};

export const QualityEvaluation = z.object({
  evaluation_status: z.enum(['pending', 'in_review', 'approved', 'rejected']).default('pending'),
  evaluated_by: z.string().nullable().default(null),
  evaluated_at: z.string().nullable().default(null),
  scores_1_to_5: z
    .object({
      factual_and_domain_accuracy: z.number().int().min(1).max(5).nullable().default(null),
      brand_tone_and_visual_alignment: z.number().int().min(1).max(5).nullable().default(null),
      clarity_and_structure: z.number().int().min(1).max(5).nullable().default(null),
      actionability_for_persona: z.number().int().min(1).max(5).nullable().default(null),
    })
    .default({}),
  /** equal-weighted mean of the four axes, computed by the server */
  weighted_quality_index: z.number().min(1).max(5).nullable().default(null),
  ideation_feedback_tag: z.string().max(80).nullable().default(null),
  reviewer_notes: z.string().max(2000).default(''),
});
export type QualityEvaluation = z.infer<typeof QualityEvaluation>;

/* ────────────────────────── prompt spec (for the image engine) ────────────────────────── */

export const ImagePromptSpec = z.object({
  prompt_details: z.object({ prompt_name: z.string().default(''), goal: z.string().default(''), content_pillar: z.string().default('') }).default({}),
  prompt_engine: z.object({ thematic_prompt_variable: z.string().default('') }).default({}),
  execution_prompt: z.object({ positive_prompt: z.string().default(''), negative_prompt: z.string().default('') }).default({}),
  parameters: z.object({ aspect_ratio: z.string().default('9:16'), steps: z.number().default(30), cfg_scale: z.number().default(7.5) }).default({}),
});
export type ImagePromptSpec = z.infer<typeof ImagePromptSpec>;

/* ────────────────────────── normalisation ────────────────────────── */

/**
 * Plan files authored by hand (or by an earlier agent) use display names:
 * "Instagram_Feed", "Telegram", "Website". The database wants the canonical
 * enum. Normalising here means a real-world file ingests without editing,
 * while anything genuinely unknown still fails loudly.
 */
const PLATFORM_ALIASES: Record<string, 'instagram' | 'telegram' | 'youtube' | 'website'> = {
  instagram: 'instagram',
  instagram_feed: 'instagram',
  instagram_story: 'instagram',
  instagram_reel: 'instagram',
  ig: 'instagram',
  اینستاگرام: 'instagram',
  telegram: 'telegram',
  telegram_channel: 'telegram',
  tg: 'telegram',
  تلگرام: 'telegram',
  youtube: 'youtube',
  youtube_video: 'youtube',
  youtube_shorts: 'youtube',
  yt: 'youtube',
  یوتیوب: 'youtube',
  website: 'website',
  web: 'website',
  site: 'website',
  وب‌سایت: 'website',
  وبسایت: 'website',
};

export function normalisePlatform(value: unknown): 'instagram' | 'telegram' | 'youtube' | 'website' | null {
  const key = String(value ?? '').trim().toLowerCase().replace(/-/g, '_');
  return PLATFORM_ALIASES[key] ?? null;
}

/** Coerce `platform` and `publish_status` before strict parsing. */
function normalisePlan(raw: unknown) {
  if (!raw || typeof raw !== 'object') return raw;
  const plan = raw as Record<string, unknown>;
  const deliveries = Array.isArray(plan.deliveries) ? plan.deliveries : [];
  return {
    ...plan,
    deliveries: deliveries.map((d) => {
      if (!d || typeof d !== 'object') return d;
      const entry = d as Record<string, unknown>;
      const platform = normalisePlatform(entry.platform) ?? entry.platform;
      const status = String(entry.publish_status ?? 'planned').toLowerCase().replace(/\s+/g, '_');
      return { ...entry, platform, publish_status: PUBLISH_STATUS.has(status) ? status : 'planned' };
    }),
  };
}

const PUBLISH_STATUS = new Set(['planned', 'scheduled', 'producing', 'ready', 'published', 'failed', 'skipped']);

/* ────────────────────────── delivery (publish event) ────────────────────────── */

export const PlanDelivery = z.object({
  delivery_id: DeliveryId,
  content_id: ContentId,
  batch_id: BatchId,
  asset_ids: z.array(VersionedAssetId).max(12).default([]),
  schedule_key: ScheduleKey,
  day_of_week: z.string().max(20).default(''),
  time_slot: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'time_slot must be HH:MM')
    .default('09:00'),
  platform: Platform,
  format_type: z.string().max(60).default(''),
  content_pillar: z.string().max(80).default(''),
  funnel_stage: FunnelStage.default('MOFU'),
  cta_target_id: DeliveryId.nullable().default(null),
  platform_post_id: z.string().nullable().default(null),
  publish_status: z.enum(['planned', 'scheduled', 'producing', 'ready', 'published', 'failed', 'skipped']).default('planned'),
  strategic_positioning: z
    .object({
      topic: z.string().max(300).default(''),
      strategic_goal: z.string().max(400).default(''),
      web_section: z.string().max(160).default(''),
      target_personas: z.array(z.string().max(40)).max(6).default([]),
      cross_links: z.array(z.string().max(60)).max(12).default([]),
    })
    .default({}),
  visual_and_prompt_specs: z
    .object({
      theme: z.string().max(160).default(''),
      accent_hex: HEX.nullable().default(null),
      highlight_hex: HEX.nullable().default(null),
      overall_format: z.string().max(300).default(''),
      visual_idea: z.string().max(1200).default(''),
      visual_instruction: z.string().max(600).default(''),
      banner_style: z.string().max(300).default(''),
      cover_prompt_json: ImagePromptSpec.nullable().default(null),
      video_prompt_json: ImagePromptSpec.nullable().default(null),
    })
    .default({}),
  exact_content: z
    .object({
      ready_caption: z.string().max(6000).default(''),
      page_copy: z.string().max(6000).default(''),
      cta: z.string().max(600).default(''),
      timeline: z
        .array(
          z.object({
            time: z.string().max(40).default(''),
            on_screen_text: z.string().max(400).default(''),
            narration_script: z.string().max(2000).default(''),
          })
        )
        .max(30)
        .default([]),
      slides: z
        .array(
          z.object({
            slide_number: z.number().int().min(1).default(1),
            role: z.string().max(60).default(''),
            title: z.string().max(300).default(''),
            body_text: z.string().max(3000).default(''),
            visual_instruction: z.string().max(600).default(''),
            icon_prompt: z.string().max(600).default(''),
          })
        )
        .max(20)
        .default([]),
    })
    .default({}),
  performance_tracking: z
    .object({
      primary_kpis: z.array(z.string().max(40)).max(6).default([]),
      snapshots: z
        .object({
          '24h': PerformanceSnapshot.omit({ window: true }).default({}),
          '7d': PerformanceSnapshot.omit({ window: true }).default({}),
          '30d': PerformanceSnapshot.omit({ window: true }).default({}),
        })
        .default({}),
    })
    .default({}),
  human_quality_evaluation: QualityEvaluation.default({}),
});
export type PlanDelivery = z.infer<typeof PlanDelivery>;

/* ────────────────────────── content idea ────────────────────────── */

export const PlanIdea = z.object({
  content_id: ContentId,
  title: z.string().min(3).max(300),
  pillar: z.string().max(80).default(''),
  thread: z.string().max(160).default(''),
  personas: z.array(z.string().max(40)).max(6).default([]),
  linked_assets: z.array(VersionedAssetId).max(20).default([]),
});
export type PlanIdea = z.infer<typeof PlanIdea>;

export const SchemaMetadata = z.object({
  schema_version: z.string().max(40).default('3.0.0'),
  batch_id: BatchId,
  batch_sequence: z.number().int().nonnegative().default(1),
  parent_week_code: z.string().max(20).default(''),
  period_title: z.string().max(200).default(''),
  brand: z.string().max(120).default('AtoZ.FnB (atozfnb.info)'),
  founder: z.string().max(120).default(''),
});
export type SchemaMetadata = z.infer<typeof SchemaMetadata>;

/**
 * The full plan file. `schema_metadata` carries extra governance blocks in real
 * files (id_conventions, kpi formulas); they are preserved by passing through
 * rather than rejected, because the plan files are authored by hand.
 */
export const ContentPlanFile = z.preprocess(
  normalisePlan,
  z.object({
    schema_metadata: SchemaMetadata.passthrough(),
    content_ideas: z.array(PlanIdea).min(1),
    assets: z.array(PlanAsset).default([]),
    deliveries: z.array(PlanDelivery).default([]),
  })
);
export type ContentPlanFile = z.infer<typeof ContentPlanFile>;

/* ────────────────────────── schedule-key helpers ────────────────────────── */

export interface ParsedScheduleKey {
  month: number;
  week: number;
  day: number;
  platform: PlatformCode;
  format: FormatCode;
  seq: number;
  raw: string;
}

/** Parse M01-W01-D01-IG-CAR-01. Returns null for anything malformed. */
export function parseScheduleKey(key: string): ParsedScheduleKey | null {
  const m = /^M(\d{2})-W(\d{2})-D(\d{2})-([A-Z]{2,3})-([A-Z]{2,4})-(\d{2})$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const platform = PlatformCode.safeParse(m[4]);
  const format = FormatCode.safeParse(m[5]);
  if (!platform.success || !format.success) return null;

  /* The grammar only fixes the shape; the *ranges* are what stop a typo like
     D08 (there are seven days) or M13 (twelve months) from creating a schedule
     slot that no calendar can resolve. */
  const month = Number(m[1]);
  const week = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  if (week < 1 || week > 5) return null;
  if (day < 1 || day > 7) return null;

  return {
    month,
    week,
    day,
    platform: platform.data,
    format: format.data,
    seq: Number(m[6]),
    raw: key,
  };
}

/** Build a canonical schedule key. */
export function buildScheduleKey(p: {
  month: number;
  week: number;
  day: number;
  platform: PlatformCode;
  format: FormatCode;
  seq?: number;
}): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `M${pad(p.month)}-W${pad(p.week)}-D${pad(p.day)}-${p.platform}-${p.format}-${pad(p.seq ?? 1)}`;
}

/** Does a format produce a video asset? */
export const isVideoFormat = (f: FormatCode) => ['REL', 'MNR', 'MCR', 'ANM', 'VID', 'SHT'].includes(f);
/** Does a format produce a multi-slide image asset? */
export const isCarouselFormat = (f: FormatCode) => f === 'CAR';
/** Formats the local engine can render without human authoring. */
export const isRenderable = (f: FormatCode) => RENDERABLE_FORMATS.includes(f);

/* ────────────────────────── video / subtitle pipeline ────────────────────────── */

export const UploadRequest = z.object({
  filename: z.string().min(1).max(200),
  /** bytes; enforced against ATOZ_MAX_UPLOAD_MB */
  size: z.number().int().positive().optional(),
});
export type UploadRequest = z.infer<typeof UploadRequest>;

/** One word with exact timing, produced by Gemini from the audio track. */
export const TranscriptWord = z.object({
  word: z.string().min(1).max(60),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  /** 0..1 model confidence, optional */
  confidence: z.number().min(0).max(1).nullable().default(null),
});
export type TranscriptWord = z.infer<typeof TranscriptWord>;

export const TranscriptCue = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string().min(1).max(400),
  words: z.array(TranscriptWord).max(60).default([]),
});
export type TranscriptCue = z.infer<typeof TranscriptCue>;

export const Transcript = z.object({
  language: z.string().max(12).default('fa'),
  duration_sec: z.number().nonnegative(),
  cues: z.array(TranscriptCue).min(1).max(400),
  /** filled by the server: gemini | local-whisper | estimated */
  source: z.enum(['gemini', 'local', 'estimated', 'edited']).default('gemini'),
});
export type Transcript = z.infer<typeof Transcript>;

/** Subtitle burn-in request. */
export const SubtitleStyle = z.object({
  fontSize: z.number().min(12).max(120).default(44),
  color: HEX.default('#FFFFFF'),
  outline: HEX.default('#0A0A0C'),
  outlineWidth: z.number().min(0).max(12).default(3),
  position: z.enum(['bottom', 'center', 'top']).default('bottom'),
  /** show one word at a time (karaoke) vs. full cue */
  karaoke: z.boolean().default(false),
  /** background pill behind text */
  pill: z.boolean().default(true),
  uppercase: z.boolean().default(false),
});
export type SubtitleStyle = z.infer<typeof SubtitleStyle>;

export const SubtitleRequest = z.object({
  assetId: VersionedAssetId.or(z.string().min(1)),
  style: SubtitleStyle.default({}),
  /** optional explicit transcript: skip transcription and use this */
  transcript: Transcript.optional(),
});
export type SubtitleRequest = z.infer<typeof SubtitleRequest>;

/* ────────────────────────── professional editor ────────────────────────── */

/**
 * A non-destructive edit document. The renderer always starts from the original
 * asset and replays these operations, so nothing is ever overwritten and undo
 * is free.
 */
export const EditLayerKind = z.enum(['image', 'text', 'shape', 'video', 'audio', 'blur', 'grade']);
export type EditLayerKind = z.infer<typeof EditLayerKind>;

export const EditLayer = z.object({
  id: z.string().min(1).max(40),
  kind: EditLayerKind,
  name: z.string().max(80).default(''),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  /** normalised 0..1 coordinates, so the document is resolution independent */
  x: z.number().default(0.5),
  y: z.number().default(0.5),
  width: z.number().min(0).default(1),
  height: z.number().min(0).default(1),
  rotation: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
  zIndex: z.number().int().default(0),
  /** image/video source: /media/... url or an asset id */
  src: z.string().max(500).nullable().default(null),
  text: z.string().max(4000).nullable().default(null),
  style: z
    .object({
      fontSize: z.number().min(4).max(400).default(48),
      weight: z.number().int().min(100).max(900).default(700),
      color: HEX.default('#FFFFFF'),
      align: z.enum(['right', 'center', 'left']).default('right'),
      lineHeight: z.number().min(0.8).max(3).default(1.4),
      letterSpacing: z.number().min(-10).max(40).default(0),
      background: z.string().max(40).nullable().default(null),
      radius: z.number().min(0).max(500).default(0),
    })
    .default({}),
  /** colour adjustments, applied by the renderer as an SVG filter */
  grade: z
    .object({
      brightness: z.number().min(0).max(3).default(1),
      contrast: z.number().min(0).max(3).default(1),
      saturate: z.number().min(0).max(3).default(1),
      blur: z.number().min(0).max(60).default(0),
      grayscale: z.number().min(0).max(1).default(0),
      sepia: z.number().min(0).max(1).default(0),
      tint: z.string().max(40).nullable().default(null),
    })
    .default({}),
});
export type EditLayer = z.infer<typeof EditLayer>;

export const EditDocument = z.object({
  version: z.literal(1).default(1),
  contentId: ContentId,
  /** which artifact this document edits */
  target: z.enum(['cover', 'carousel', 'reel', 'post', 'story']).default('cover'),
  canvas: z
    .object({
      width: z.number().int().positive().default(1080),
      height: z.number().int().positive().default(1350),
      background: HEX.default('#0A1931'),
    })
    .default({}),
  layers: z.array(EditLayer).max(120).default([]),
  /** caption band burned into video exports */
  subtitle: SubtitleStyle.optional(),
  updatedAt: z.string().nullable().default(null),
});
export type EditDocument = z.infer<typeof EditDocument>;

/* ────────────────────────── template catalogue ────────────────────────── */

export const TemplateCategory = z.enum([
  'cover',
  'carousel',
  'reel',
  'post',
  'story',
  'chart',
  'kinetic-type',
  'transition',
  'logo-intro',
  'anatomy',
  'web-to-video',
  'outro',
]);
export type TemplateCategory = z.infer<typeof TemplateCategory>;

export const Template = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  category: TemplateCategory,
  /** where the recipe came from */
  family: z.enum(['core', 'opendesign', 'remotion-skills', 'hyperframes', 'anatomy', 'motion-library']),
  description: z.string().max(600).default(''),
  /** 16:9 / 9:16 / 1:1 / 4:5 / 1080x1350 */
  aspect: z.string().max(20).default('9:16'),
  durationSec: z.number().positive().nullable().default(null),
  /** motion preset keys this template uses */
  motions: z.array(z.string().max(40)).max(12).default([]),
  /** tags for the filter UI */
  tags: z.array(z.string().max(30)).max(12).default([]),
  /** accent colour preview */
  accent: HEX.nullable().default(null),
  /** the scene template this expands to, if renderable */
  sceneKind: z.string().max(40).nullable().default(null),
});
export type Template = z.infer<typeof Template>;

/* ────────────────────────── production queue ────────────────────────── */

export const ProductionJobKind = z.enum([
  'plan-to-scenes', // idea + guide -> timed reel storyboard
  'render-cover',
  'render-carousel',
  'render-reel',
  'render-pack',
  'transcribe',
  'subtitles',
  'compress',
  'edit-export',
]);
export type ProductionJobKind = z.infer<typeof ProductionJobKind>;

export const StoryboardBeat = z.object({
  index: z.number().int().nonnegative(),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  onScreenText: z.string().max(300).default(''),
  narration: z.string().max(2000).default(''),
  visual: z.string().max(600).default(''),
  motion: z.string().max(40).default('fade-up'),
  metric: z.string().max(12).default(''),
});
export type StoryboardBeat = z.infer<typeof StoryboardBeat>;

export const Storyboard = z.object({
  title: z.string().max(300),
  durationSec: z.number().positive(),
  aspect: z.string().max(10).default('9:16'),
  beats: z.array(StoryboardBeat).min(1).max(20),
  /** which template family was used */
  templateId: z.string().max(60).nullable().default(null),
  source: z.enum(['gemini', 'local', 'manual']).default('gemini'),
});
export type Storyboard = z.infer<typeof Storyboard>;
