/**
 * Typed API client. Every call is validated on the server; here we only shape
 * the envelope and turn failures into a single `ApiError` the UI can render.
 */

export type ApiOk<T> = { success: true; data: T };
export type ApiErr = { success: false; error: string; code?: string };

export class ApiError extends Error {
  code: string;
  constructor(message: string, code = 'ERROR') {
    super(message);
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError('ارتباط با سرور برقرار نشد', 'NETWORK');
  }

  const text = await res.text();
  let payload: ApiOk<T> | ApiErr | null = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError('پاسخ سرور قابل خواندن نیست', 'BAD_RESPONSE');
  }

  if (!res.ok || !payload || payload.success === false) {
    const err = payload as ApiErr | null;
    throw new ApiError(err?.error ?? `خطای ${res.status}`, err?.code ?? String(res.status));
  }
  return (payload as ApiOk<T>).data;
}

const get = <T>(p: string) => request<T>(p);
const post = <T>(p: string, body?: unknown) => request<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) });
const patch = <T>(p: string, body?: unknown) => request<T>(p, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
const put = <T>(p: string, body?: unknown) => request<T>(p, { method: 'PUT', body: JSON.stringify(body ?? {}) });
const del = <T>(p: string) => request<T>(p, { method: 'DELETE' });

/* ────────────────────────── types ────────────────────────── */

export type Subbrand = 'AI' | 'Library' | 'Magazine' | 'Calculators' | 'Solutions' | 'Academy';
export type ContentStatus =
  | 'draft'
  | 'blueprint_pending'
  | 'approved_for_production'
  | 'queued'
  | 'rendering'
  | 'produced'
  | 'scheduled'
  | 'published'
  | 'failed'
  | 'archived';

export interface ChartDatum {
  label: string;
  value: number;
  color?: string;
}

export interface Scene {
  id: number;
  eyebrow: string;
  cardTitle: string;
  metric: string;
  metricCaption: string;
  items: string[];
  chartData: ChartDatum[];
  narration: string;
  durationSec: number;
  motion: string;
}

export interface CarouselSlide {
  slideNumber: number;
  templateType: 'cover' | 'blueprint' | 'comparison' | 'stat' | 'quote' | 'cta';
  badge: string;
  heading: string;
  body: string;
  highlightMetric: string;
  items: string[];
  chartData: ChartDatum[];
}

export interface Social {
  instagramCaption: string;
  telegramPost: string;
  hashtags: string[];
  youtubeTitle: string;
  youtubeDescription: string;
  seoTitle: string;
  seoDescription: string;
}

export interface Plan {
  title: string;
  subtitle: string;
  sectionCode: Subbrand;
  funnelStage: 'TOFU' | 'MOFU' | 'BOFU';
  voiceoverScript: string;
  articleHtml: string;
  scenes: Scene[];
  carouselSlides: CarouselSlide[];
  social: Social;
  layout: {
    logoX: number;
    logoY: number;
    titleY: number;
    cardY: number;
    logoMotion: string;
    theme: 'auto' | 'dark' | 'light';
    showSafeZones: boolean;
  };
  audio: { file: string; durationSec: number; engine: string; words: { text: string; start: number; end: number }[] };
}

export interface Content {
  contentId: string;
  batchId: string;
  title: string;
  sectionCode: Subbrand;
  deliverableType: string;
  status: ContentStatus;
  funnelStage: string;
  scheduleKey: string;
  plan: Plan;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Delivery {
  deliveryId: string;
  contentId: string;
  platform: string;
  scheduleKey: string;
  scheduledFor: string | null;
  status: ContentStatus;
  rolloverCount: number;
  metrics: Record<string, number>;
  kpis: { saveRate: number; shareRate: number; ctr: number; avgWatchRatio: number };
  publishedAt: string | null;
}

export interface Asset {
  assetId: string;
  contentId: string;
  kind: 'video' | 'image' | 'audio' | 'document' | 'archive';
  file: string;
  url: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  createdAt: string;
}

export interface Job {
  jobId: string;
  kind: 'cover' | 'carousel' | 'reel' | 'pack';
  contentId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
  step: string;
  error: string | null;
  result: { url: string; file: string; bytes: number; kind: string }[];
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface SectionTheme {
  id: Subbrand;
  subbrandName: string;
  name: string;
  accent: string;
  mode: 'dark' | 'light';
  bg: string;
  pillarCode: string;
}

export interface Brand {
  brandName: string;
  domain: string;
  handle: string;
  essence: string;
  promise: string;
  cta: string;
  colors: Record<string, string>;
  sectionThemes: Record<Subbrand, SectionTheme>;
}

export interface Stats {
  pending: number;
  approved: number;
  produced: number;
  published: number;
  failed: number;
  assets: number;
  jobsQueued: number;
  counters: Record<string, number>;
}

export interface JalaliDay {
  iso: string;
  weekday: string;
  weekdayShort: string;
  jalali: string;
  jalaliShort: string;
  jalaliDigits: string;
  year: number;
  month: number;
  monthName: string;
  day: number;
}

export interface CalendarItem extends Delivery {
  title: string;
  sectionCode: Subbrand;
}

export interface WeekBoard {
  startIso: string;
  today: JalaliDay;
  days: (JalaliDay & { isToday: boolean; items: CalendarItem[]; count: number })[];
}

export interface MonthBoard {
  label: string;
  monthName: string;
  year: number;
  weekdays: string[];
  cells: ({ empty?: boolean; isToday?: boolean; items?: Delivery[]; count?: number } & Partial<JalaliDay>)[];
}

export interface AppState {
  stats: Stats;
  notifications: { id: number; level: string; message: string; created_at: string }[];
  system: {
    cpuPct: number;
    ramUsedMb: number;
    ramTotalMb: number;
    platform: string;
    queueDepth: number;
    ai: { mode: string; hasKey: boolean; chain: string[]; demoted: { model: string; until: number }[] };
    today: JalaliDay;
  };
  brand: Brand;
}

export interface Concept {
  angleTitle: string;
  summary: string;
  recommendedFunnel: 'TOFU' | 'MOFU' | 'BOFU';
  keyMetric: string;
  hook: string;
}

export interface ConceptsResult {
  topicAnalysis: string;
  concepts: Concept[];
  mode: 'local' | 'cloud';
  source: string;
}

export interface AiRun {
  id: number;
  agentId: string;
  model: string;
  status: string;
  tokens: number;
  latencyMs: number;
  detail: string | null;
  createdAt: string;
}

export interface Quota {
  model: string;
  used: number;
  tokens: number;
  costUsd: number;
  limit: number;
  rpm: number;
}

export interface VoiceResult {
  ok: boolean;
  engine: string;
  file: string;
  url: string;
  durationSec: number;
  words: { text: string; start: number; end: number }[];
  estimatedCaptions: boolean;
}

export interface VoiceEngine {
  id: string;
  label: string;
  available: boolean;
}

export interface DamFolder {
  id: string;
  title: string;
  dir: string;
  count: number;
  bytes: number;
  files: { name: string; url: string; dir: string; bytes: number; mtime: number }[];
}

export interface MotionPreset {
  key: string;
  label: string;
}

/* ────────────────────────── endpoints ────────────────────────── */

export const api = {
  health: () => get<{ ok: boolean; version: string; uptimeSec: number }>('/api/health'),
  state: () => get<AppState>('/api/state'),

  brand: () => get<Brand>('/api/brand'),
  motions: () => get<{ presets: MotionPreset[]; transitions: MotionPreset[] }>('/api/motions'),

  contents: (params?: { status?: string; batchId?: string; section?: string }) => {
    const q = new URLSearchParams();
    if (params?.status) q.set('status', params.status);
    if (params?.batchId) q.set('batchId', params.batchId);
    if (params?.section) q.set('section', params.section);
    const suffix = q.toString() ? `?${q}` : '';
    return get<Content[]>(`/api/contents${suffix}`);
  },
  content: (id: string) => get<{ content: Content; deliveries: Delivery[]; assets: Asset[] }>(`/api/contents/${id}`),
  updatePlan: (id: string, plan: Partial<Plan>) => patch<Content>(`/api/contents/${id}/plan`, { plan }),
  setStatus: (id: string, status: ContentStatus) => patch<Content>(`/api/contents/${id}/status`, { status }),
  duplicate: (id: string) => post<{ contentId: string }>(`/api/contents/${id}/duplicate`),
  bulkStatus: (ids: string[], status: ContentStatus) => post<Content[]>('/api/contents/bulk-status', { ids, status }),

  approve: (contentIds?: string[], periodCode?: string) =>
    post<{ approvedCount: number; contentIds: string[] }>('/api/blueprints/approve', { contentIds, periodCode }),
  ingest: (puzzle: unknown) => post<{ periodCode: string; contentsCreated: number; warnings: string[] }>('/api/puzzle/ingest', { puzzle }),
  blocks: () => get<{ periodCode: string; batchId: string; month: number; week: number; part: number; phaseTitle: string; daysLabel: string; status: string; ideasCount: number; deliveriesCount: number }[]>('/api/puzzle/blocks'),

  concepts: (rawIdea: string, sectionCode: Subbrand, useWebSearch = false) =>
    post<ConceptsResult>('/api/ai/concepts', { rawIdea, sectionCode, useWebSearch }),
  generate: (payload: { conceptTitle: string; conceptSummary: string; sectionCode: Subbrand; counts: Record<string, number> }) =>
    post<{ records: { contentId: string; type: string; title: string }[]; mode: string }>('/api/ai/generate', payload),

  chat: (message: string, confirmedAction = false) =>
    post<{ reply: string; action: string; requiresConfirmation: boolean; targetRoom?: string; records?: unknown[] }>(
      '/api/atooz/chat',
      { message, confirmedAction }
    ),

  voiceEngines: () => get<VoiceEngine[]>('/api/voice/engines'),
  synthesize: (scriptText: string, engine: string, contentId?: string) =>
    post<VoiceResult>('/api/voice/synthesize', { scriptText, engine, contentId }),

  render: (contentId: string, kinds: string[]) => post<{ jobs: string[] }>('/api/render', { contentId, kinds }),
  jobs: () => get<Job[]>('/api/render/jobs'),
  cancelJob: (id: string) => post<Job>(`/api/render/jobs/${id}/cancel`),
  preview: (plan: Plan, timeSec: number, contentId?: string) => post<{ url: string }>('/api/preview', { plan, timeSec, contentId }),

  week: (date?: string) => get<WeekBoard>(`/api/calendar/week${date ? `?date=${date}` : ''}`),
  month: (date?: string) => get<MonthBoard>(`/api/calendar/month${date ? `?date=${date}` : ''}`),
  schedule: (deliveryId: string, date: string | null) => post<Delivery>('/api/calendar/schedule', { deliveryId, date }),
  rollover: (deliveryId: string, days = 1) => post<Delivery>('/api/calendar/rollover', { deliveryId, days }),
  publish: (deliveryId: string) => post<Delivery>('/api/calendar/publish', { deliveryId }),
  metrics: (deliveryId: string, payload: Record<string, number>) => post<Delivery>('/api/metrics', { deliveryId, ...payload }),

  assets: (contentId?: string) => get<Asset[]>(`/api/assets${contentId ? `?contentId=${contentId}` : ''}`),
  dam: () => get<DamFolder[]>('/api/dam'),

  logs: (level = 'ALL') => get<{ id: number; level: string; source: string; message: string; details: string | null; created_at: string }[]>(`/api/logs?level=${level}`),
  clearLogs: () => request<{ success: boolean }>('/api/logs', { method: 'DELETE' }),
  quotas: () => get<{ quotas: Quota[]; runs: AiRun[] }>('/api/quotas'),

  prompts: () => get<Record<string, string>>('/api/prompts'),
  savePrompts: (patchBody: Record<string, string>) => post<Record<string, string>>('/api/prompts', patchBody),

  agents: () => get<AgentRoster>('/api/agents'),
  skills: () => get<SkillsIndex>('/api/skills'),
  skill: (id: string) => get<SkillDetail>(`/api/skills/${encodeURIComponent(id)}`),
  reloadSkills: () => post<{ skills: number; knowledge: number }>('/api/skills/reload'),
  contextPreview: (agentId: string) => get<ContextPreview>(`/api/skills/preview/${encodeURIComponent(agentId)}`),

  seedDemo: () => post<{ seeded: boolean }>('/api/demo/seed'),
};


/* ────────────────────────── agents & skills ────────────────────────── */

export interface AgentDef {
  id: string;
  label: string;
  role: string;
  promptKey: string;
  schema: string;
  canAct: boolean;
  model: string;
  skills: string[];
  contextChars: number;
  runs: number;
  lastRunAt: string | null;
  lastLatencyMs: number | null;
}

/* ══════════════════════════ v7.0 model ══════════════════════════ */

/** One publish event: a single platform delivery of one idea. */
export interface PlanPublish {
  deliveryId: string;
  contentId: string;
  batchId: string;
  scheduleKey: string;
  schedule: { month: number; week: number; day: number; platform: string; format: string; sequence: number } | null;
  platform: 'instagram' | 'telegram' | 'youtube' | 'website';
  platformLabel: string;
  formatCode: string;
  formatLabel: string;
  formatType: string | null;
  dayOfWeek: string;
  timeSlot: string;
  funnelStage: string;
  contentPillar: string;
  ctaTargetId: string | null;
  platformPostId: string | null;
  publishStatus: string;
  scheduledFor: string | null;
  assetIds: string[];
  positioning: Record<string, unknown>;
  visual: {
    accent_hex?: string;
    highlight_hex?: string;
    overall_format?: string;
    visual_idea?: string;
    visual_instruction?: string;
    banner_style?: string;
    cover_prompt_json?: unknown;
    video_prompt_json?: unknown;
  };
  content: {
    ready_caption?: string;
    page_copy?: string;
    cta?: string;
    hashtags?: string[];
    timeline?: { time: string; on_screen_text: string; narration_script: string }[];
    slides?: {
      slide_number: number;
      role: string;
      title: string;
      body_text: string;
      visual_instruction: string;
      icon_prompt: string;
    }[];
  };
  quality: QualityEvaluation | null;
  rolloverCount: number;
  publishedAt: string | null;
  isVideo: boolean;
  isCarousel: boolean;
}

export interface QualityEvaluation {
  evaluation_status: 'pending' | 'in_review' | 'approved' | 'rejected';
  evaluated_by: string | null;
  evaluated_at: string | null;
  scores_1_to_5: Partial<Record<QualityAxis, number | null>>;
  weighted_quality_index: number | null;
  ideation_feedback_tag: string | null;
  reviewer_notes: string;
}

export type QualityAxis =
  | 'factual_and_domain_accuracy'
  | 'brand_tone_and_visual_alignment'
  | 'clarity_and_structure'
  | 'actionability_for_persona';

export const QUALITY_AXES: { key: QualityAxis; label: string }[] = [
  { key: 'factual_and_domain_accuracy', label: 'صحت علمی و تخصصی' },
  { key: 'brand_tone_and_visual_alignment', label: 'تناسب با لحن و هویت بصری' },
  { key: 'clarity_and_structure', label: 'وضوح پیام و ساختار' },
  { key: 'actionability_for_persona', label: 'کاربردی‌بودن برای پرسونا' },
];

export interface RawMetrics {
  reach?: number | null;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  saves?: number | null;
  shares?: number | null;
  clicks?: number | null;
  replies_and_sticker_taps?: number | null;
  avg_watch_time_sec?: number | null;
  video_duration_sec?: number | null;
  unique_page_views?: number | null;
  asset_downloads_or_tool_runs?: number | null;
  newsletter_signups?: number | null;
  avg_time_on_page_sec?: number | null;
}

export interface Snapshot {
  window: '24h' | '7d' | '30d';
  capturedAt: string | null;
  raw: RawMetrics;
  kpis: Record<string, number | null>;
  source: string;
}

export interface PlanIdea {
  contentId: string;
  batchId: string;
  title: string;
  pillar: string;
  thread: string;
  personas: string[];
  linkedAssetIds: string[];
  publishCount: number;
  publishedCount: number;
}

export interface PlanAssetRow {
  assetId: string;
  contentId: string;
  assetType: string;
  name: string;
  storageLocation: string;
  subfileCodes: string[];
}

export interface BoardDay {
  date: string;
  weekday: string;
  label: string;
  count: number;
  byPlatform: Record<string, number>;
  isToday?: boolean;
}

export interface PublishBoard {
  weekStart: string;
  days: BoardDay[];
  publishes: PlanPublish[];
  /** publishes scheduled outside the displayed week (e.g. after a rollover) */
  outsideWeek?: PlanPublish[];
}

export interface PlanBatch {
  batchId: string;
  ideas: number;
  publishes: number;
  published: number;
  starts: string | null;
  ends: string | null;
  planAssets: number;
}

export interface IngestDiff {
  batchId: string;
  weekStart: string;
  ideas: { added: number; updated: number };
  assets: { added: number; updated: number };
  publishes: { added: number; updated: number };
  removed: number;
  warnings: string[];
}

export interface AnalyticsOverview {
  window: string;
  totals: Record<string, number>;
  rates: Record<string, number | null>;
  quality: { evaluated: number; average: number | null; pending: number };
  byPlatform: { platform: string; label: string; publishes: number; published: number; reach: number; engagement: number }[];
  byFunnel: { stage: string; publishes: number; published: number }[];
  byFormat: { format: string; label: string; publishes: number; avgEngagement: number | null }[];
  topPublishes: { deliveryId: string; title: string; platformLabel: string; reach: number; engagement: number; kpis: Record<string, number | null> }[];
}

/* ── templates ── */

export interface Template {
  id: string;
  name: string;
  category: string;
  family: string;
  description: string;
  aspect: string;
  durationSec: number | null;
  motions: string[];
  tags: string[];
  accent: string;
  sceneKind: string;
}

export interface TemplatePage {
  total: number;
  catalogueSize: number;
  page: number;
  pageSize: number;
  pages: number;
  items: Template[];
}

export interface TemplateFacets {
  total: number;
  categories: { name: string; count: number }[];
  families: { id: string; name: string; note: string; count: number }[];
  aspects: { name: string; count: number }[];
  motions: { name: string; count: number }[];
  styles: { name: string; count: number }[];
  layouts: { name: string; count: number }[];
  presets: { key: string; label: string }[];
  transitions: { key: string; label: string }[];
  familiesMeta: { id: string; name: string; note: string }[];
}

/* ── media & subtitles ── */

export interface MediaItem {
  mediaId: string;
  kind: 'video' | 'audio' | 'image' | 'document';
  file: string;
  url: string;
  originalName: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  folder: string;
  contentId: string | null;
  parentId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  transcript?: Transcript | null;
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence?: number | null;
}

export interface TranscriptCue {
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

export interface Transcript {
  language: string;
  duration_sec: number;
  cues: TranscriptCue[];
  source: 'gemini' | 'local' | 'estimated' | 'edited';
  engine?: string;
  model?: string;
  issues?: string[];
}

export interface SubtitleStyle {
  fontSize?: number;
  color?: string;
  outline?: string;
  outlineWidth?: number;
  position?: 'bottom' | 'center' | 'top';
  pill?: boolean;
  uppercase?: boolean;
  karaoke?: boolean;
}

/* ── production ── */

export interface ConceptScene {
  index: number;
  beat: string;
  cardTitle: string;
  narration: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  onScreenText: string;
  visual: string;
  iconPrompt: string | null;
  accent: string;
  transition: string;
}

export interface Concept {
  kind: 'reel' | 'carousel' | 'post';
  title: string;
  durationSec: number;
  aspect: string;
  guide: { id: string; name: string; note: string };
  templateIds: string[];
  meta: {
    deliveryId: string;
    contentId: string;
    batchId: string;
    scheduleKey: string;
    platform: string;
    platformLabel: string;
    formatLabel: string;
    scheduledFor: string | null;
    funnelStage: string;
    cta: string | null;
    ctaTargetId: string | null;
    caption: string;
    hashtags: string[];
    personaList: string[];
    accentHex: string;
    highlightHex: string;
  };
  scenes: ConceptScene[];
}

export interface BuildGuide {
  id: string;
  name: string;
  weights: number[];
  beats: string[];
  note: string;
}

export interface QueueItem {
  deliveryId: string;
  contentId: string;
  title: string;
  platform: string;
  platformLabel: string;
  formatLabel: string;
  scheduleKey: string;
  scheduledFor: string | null;
  funnelStage: string;
  status: string;
  isVideo: boolean;
  isCarousel: boolean;
  assetType: string | null;
  suggestedGuide: { id: string; name: string };
  suggestedTemplates: { id: string; name: string }[];
  editDoc: { docId: string; status: string; updatedAt: string } | null;
  readiness: {
    checks: { key: string; ok: boolean; label: string }[];
    done: number;
    total: number;
    percent: number;
    ready: boolean;
  };
}

export interface ProductionQueue {
  total: number;
  grouped: Record<string, number>;
  items: QueueItem[];
}

export interface EditDocRecord {
  docId: string;
  deliveryId: string;
  kind: string;
  title: string;
  aspect: string;
  durationSec: number;
  status: string;
  doc: Concept | null;
  createdAt: string;
  updatedAt: string;
}

/* ── API surface ── */

const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') q.set(k, String(v));
  }
  return q.toString() ? `?${q}` : '';
};

export const planApi = {
  batches: () => get<PlanBatch[]>('/api/plan/batches'),
  ingest: (plan: unknown, weekStartIso?: string) => post<IngestDiff>('/api/plan/ingest', { plan, weekStartIso }),
  deleteBatch: (batchId: string) => del<{ removed: boolean }>(`/api/plan/batches/${batchId}`),

  ideas: (params: { batchId?: string; status?: string } = {}) => get<PlanIdea[]>(`/api/plan/ideas${qs(params)}`),
  idea: (id: string) => get<PlanIdea & { publishes: PlanPublish[]; assets: PlanAssetRow[] }>(`/api/plan/ideas/${id}`),

  publishes: (params: { batchId?: string; contentId?: string; platform?: string; status?: string; from?: string; to?: string; limit?: number } = {}) =>
    get<PlanPublish[]>(`/api/plan/publishes${qs(params)}`),
  publish: (id: string) => get<PlanPublish & { snapshots: Snapshot[] }>(`/api/plan/publishes/${id}`),
  updateContent: (id: string, content: Partial<PlanPublish['content']>) =>
    patch<PlanPublish>(`/api/plan/publishes/${id}/content`, { content }),
  schedule: (id: string, date: string | null, timeSlot?: string) =>
    post<PlanPublish>(`/api/plan/publishes/${id}/schedule`, { date, timeSlot }),
  rollover: (id: string, days = 1) => post<PlanPublish>(`/api/plan/publishes/${id}/rollover`, { days }),
  markPublished: (id: string, platformPostId?: string) =>
    post<PlanPublish>(`/api/plan/publishes/${id}/publish`, { platformPostId }),
  setStatus: (id: string, status: string) => post<PlanPublish>(`/api/plan/publishes/${id}/status`, { status }),

  snapshots: (id: string) => get<Snapshot[]>(`/api/plan/publishes/${id}/snapshots`),
  addSnapshot: (id: string, window: string, raw: RawMetrics) =>
    post<Snapshot[]>(`/api/plan/publishes/${id}/snapshots`, { window, raw }),
  scoreQuality: (id: string, evaluation: Partial<QualityEvaluation>) =>
    post<QualityEvaluation>(`/api/plan/publishes/${id}/quality`, { evaluation }),

  planAssets: (contentId?: string) => get<PlanAssetRow[]>(`/api/plan/assets${qs({ contentId })}`),
  board: (from?: string, to?: string) => get<PublishBoard>(`/api/plan/board${qs({ from, to })}`),
  analytics: (params: { batchId?: string; window?: string } = {}) =>
    get<AnalyticsOverview>(`/api/plan/analytics${qs(params)}`),
};

export const templateApi = {
  query: (params: {
    q?: string;
    category?: string;
    family?: string;
    tag?: string;
    aspect?: string;
    motion?: string;
    page?: number;
    pageSize?: number;
  } = {}) => get<TemplatePage>(`/api/templates${qs(params)}`),
  facets: () => get<TemplateFacets>('/api/templates/facets'),
  one: (id: string) => get<Template>(`/api/templates/${encodeURIComponent(id)}`),
  suggest: (intent: string, limit = 6) => get<Template[]>(`/api/templates/suggest/${encodeURIComponent(intent)}?limit=${limit}`),
};

export const mediaApi = {
  list: (params: { folder?: string; kind?: string; contentId?: string; limit?: number } = {}) =>
    get<MediaItem[]>(`/api/media${qs(params)}`),
  stats: () => get<{ total: { n: number; bytes: number }; byFolder: { folder: string; kind: string; n: number; bytes: number }[] }>('/api/media/stats'),
  folders: () => get<{ folder: string; path: string; exists: boolean; files: number }[]>('/api/media/folders'),
  one: (id: string) => get<MediaItem>(`/api/media/${id}`),
  remove: (id: string) => del<{ removed: boolean }>(`/api/media/${id}`),
  importFolder: (path: string, folder?: string) => post<{ imported: number; skipped: number }>('/api/media/import', { path, folder }),

  /** Upload with progress: XHR because fetch has no upload progress events. */
  upload: (
    file: File,
    opts: { folder?: string; compress?: boolean; onProgress?: (pct: number) => void } = {}
  ) =>
    new Promise<{ media: MediaItem; compressed: MediaItem | null }>((resolve, reject) => {
      const url = `/api/media/upload${qs({
        name: file.name,
        folder: opts.folder ?? 'incoming',
        compress: opts.compress ? 1 : undefined,
      })}`;
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress?.(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        try {
          const payload = JSON.parse(xhr.responseText);
          if (payload.success) resolve(payload.data);
          else reject(new ApiError(payload.error ?? 'آپلود ناموفق', payload.code ?? 'UPLOAD'));
        } catch {
          reject(new ApiError('پاسخ آپلود قابل خواندن نیست', 'BAD_RESPONSE'));
        }
      };
      xhr.onerror = () => reject(new ApiError('آپلود قطع شد', 'NETWORK'));
      xhr.send(file);
    }),

  probe: (id: string) => post<Record<string, unknown>>(`/api/media/${id}/probe`),
  compress: (id: string, opts: { crf?: number; maxWidth?: number } = {}) =>
    post<{ savedPct: number; beforeBytes: number; afterBytes: number; media: MediaItem }>(`/api/media/${id}/compress`, opts),

  transcribe: (id: string, opts: { mode?: 'auto' | 'gemini' | 'estimate'; scriptText?: string } = {}) =>
    post<Transcript>(`/api/media/${id}/transcribe`, opts),
  transcript: (id: string) => get<Transcript>(`/api/media/${id}/transcript`),
  saveTranscript: (id: string, body: { cues: TranscriptCue[]; language?: string; duration_sec?: number }) =>
    put<Transcript>(`/api/media/${id}/transcript`, body),
  burnSubtitles: (id: string, style: SubtitleStyle, cues?: TranscriptCue[]) =>
    post<{ media: MediaItem; srt: string; vtt: string }>(`/api/media/${id}/subtitles`, { style, cues }),
};

export const productionApi = {
  queue: (params: { batchId?: string; status?: string; from?: string; to?: string } = {}) =>
    get<ProductionQueue>(`/api/production/queue${qs(params)}`),
  guides: () => get<BuildGuide[]>('/api/production/guides'),
  concept: (deliveryId: string, params: { guide?: string; duration?: number } = {}) =>
    get<Concept>(`/api/production/concept/${deliveryId}${qs(params)}`),
  rebuildConcept: (deliveryId: string, body: { guideId?: string; durationSec?: number }) =>
    post<Concept>(`/api/production/concept/${deliveryId}`, body),

  edits: (params: { deliveryId?: string; status?: string } = {}) => get<EditDocRecord[]>(`/api/edits${qs(params)}`),
  edit: (docId: string) => get<EditDocRecord>(`/api/edits/${docId}`),
  createEdit: (deliveryId: string, opts: { guideId?: string; durationSec?: number; force?: boolean } = {}) =>
    post<{ created: boolean; doc: EditDocRecord; concept: Concept }>('/api/edits', { deliveryId, ...opts }),
  saveEdit: (docId: string, patchBody: Partial<Concept> & { status?: string }) =>
    put<EditDocRecord>(`/api/edits/${docId}`, patchBody),
  deleteEdit: (docId: string) => del<{ removed: boolean }>(`/api/edits/${docId}`),
};

export interface AiStatus {
  mode: 'cloud' | 'local-llm' | 'local' | string;
  primary: string;
  provider: 'gemini' | 'local' | 'template' | string;
  hasKey: boolean;
  sdkReady: boolean;
  sdkError: string | null;
  localFallback: boolean;
  localUrl: string | null;
  localModel: string | null;
  chain: string[];
  agents: number;
  skills: number;
  demoted: { model: string; until: number }[];
  lastRunAt: string | null;
}

export interface AgentRoster {
  agents: AgentDef[];
  status: AiStatus;
}

export interface SkillSummary {
  id: string;
  title: string;
  capability: string;
  agents: string[];
  inject: boolean;
  tags: string[];
  file: string;
  chars: number;
  preview: string;
}

export interface SkillsIndex {
  loadedAt: string;
  skills: SkillSummary[];
  knowledge: Omit<SkillSummary, 'agents' | 'inject' | 'tags' | 'title' | 'capability'>[];
}

export interface SkillDetail {
  id: string;
  title?: string;
  capability?: string;
  agents?: string[];
  inject?: boolean;
  tags?: string[];
  file: string;
  body: string;
}

export interface ContextPreview {
  agentId: string;
  text: string;
  applied: string[];
  chars: number;
}

export const mediaUrl = (url: string) => url;
