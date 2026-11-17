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

export interface AiStatus {
  mode: 'cloud' | 'local-llm' | 'local' | string;
  hasKey: boolean;
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
