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

export const AssetId = z.string().regex(/^ATZ-A-\d{6}$/);

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
