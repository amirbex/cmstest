/**
 * AI service — schema-validated model calls with a working offline fallback.
 *
 * Design rules learned from v5.0's failures:
 *  • Never trust `JSON.parse(modelText)`. Every response is zod-parsed; a bad
 *    response is retried once with the validation error, then discarded.
 *  • Never hard-code fictional model names. The chain is configurable and only
 *    real identifiers are used; a 404 demotes the model for the session.
 *  • Never leave the product dead when there is no API key. `local` mode
 *    produces deterministic, genuinely usable Persian copy from templates so
 *    the whole studio → render → gallery pipeline runs with zero cloud.
 *  • Every call is metered (tokens, latency, cost) into `quota_usage` +
 *    `agent_run` so the monitor room tells the truth.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, nowIso, logEvent, getMeta, setMeta } from '../lib/db.js';
import { ConceptResponse, FactoryResponse, AtoozDecision } from '@atoz/contracts';

/* ────────────────────────── config ────────────────────────── */

const MODEL_LIMITS = {
  'gemini-2.5-flash': { rpd: 250, rpm: 10, costPer1k: 0.0003 },
  'gemini-2.5-flash-lite': { rpd: 1000, rpm: 15, costPer1k: 0.0001 },
  'gemini-2.0-flash': { rpd: 1500, rpm: 15, costPer1k: 0.0001 },
  'gemini-2.5-pro': { rpd: 100, rpm: 5, costPer1k: 0.0025 },
};

const CHAIN = (process.env.ATOZ_MODEL_CHAIN || 'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
export const AI_MODE = API_KEY ? 'cloud' : (process.env.ATOZ_AI_MODE || 'local');

const demoted = new Map(); // model -> unix ms until which it is skipped

/* ────────────────────────── metering ────────────────────────── */

const today = () => new Date().toISOString().slice(0, 10);

export function quotaSnapshot() {
  const day = today();
  const rows = db.prepare('SELECT * FROM quota_usage WHERE day = ?').all(day);
  const usage = Object.fromEntries(rows.map((r) => [r.model, r]));
  return CHAIN.map((model) => ({
    model,
    used: usage[model]?.requests ?? 0,
    tokens: usage[model]?.tokens ?? 0,
    costUsd: +(usage[model]?.cost_usd ?? 0).toFixed(4),
    limit: MODEL_LIMITS[model]?.rpd ?? 500,
    rpm: MODEL_LIMITS[model]?.rpm ?? 10,
  }));
}

function meter(model, tokens, latencyMs, agentId, status, promptLen, outputLen, detail = null) {
  const day = today();
  const cost = ((MODEL_LIMITS[model]?.costPer1k ?? 0.0002) * tokens) / 1000;
  db.prepare(
    `INSERT INTO quota_usage (day, model, requests, tokens, cost_usd) VALUES (?,?,1,?,?)
     ON CONFLICT(day, model) DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens,
       cost_usd = cost_usd + excluded.cost_usd`
  ).run(day, model, tokens, cost);
  db.prepare(
    `INSERT INTO agent_run (agent_id, model, status, prompt_len, output_len, tokens, latency_ms, detail, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(agentId, model, status, promptLen, outputLen, tokens, latencyMs, detail, nowIso());
}

/* ────────────────────────── knowledge ────────────────────────── */

/** Recursively load knowledge-base and skills markdown (v5.0 read only top level). */
export function loadKnowledge() {
  const roots = ['knowledge-base', 'skills'];
  const parts = [];
  const walk = (dir, depth = 0) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const text = fs.readFileSync(full, 'utf-8');
        parts.push(`\n--- [${full}] ---\n${text.slice(0, 2400)}`);
      }
    }
  };
  for (const root of roots) walk(path.resolve(root));
  return parts.join('');
}

/* ────────────────────────── prompts ────────────────────────── */

const DEFAULT_PROMPTS = {
  ATOOZ_CORE: `تو «آتوز» هستی؛ دستیار ارشد فرماندهی استودیوی محتوای AtoZ.FnB (صنعت غذا و نوشیدنی ایران).
قواعد:
۱. کوتاه، دقیق، اجرایی و فارسی پاسخ بده.
۲. اگر کاربر خواست ایده‌ای ثبت/بسط شود: action="CREATE_IDEA" و ideaTopic را پر کن و requiresConfirmation=true بگذار.
۳. اگر پرسشی درباره وضعیت بود: action="NONE" و requiresConfirmation=false.
۴. اگر کاربر خواست چیزی رندر شود: action="RENDER".`,

  IDEATION_STRATEGY: `تو سردبیر ارشد و استراتژیست محتوای AtoZ.FnB هستی.
سه کانسپت کاملاً متمایز، غیرکلیشه‌ای و داده‌محور برای صنعت F&B ایران بساز.
هر کانسپت باید یک شاخص عددی کوتاه (حداکثر ۵ کاراکتر) و یک قلاب (hook) داشته باشد.
از کلیشه‌های بی‌ربط پرهیز کن.`,

  UNIFIED_CONTENT_FACTORY: `تو کارخانه تولید محتوای AtoZ.FnB هستی.
برای هر آیتم درخواستی، یک بسته کامل و قابل‌اجرا بساز:
- voiceoverScript: فارسی محاوره‌ای-حرفه‌ای، ۶۵ تا ۷۵ کلمه، بدون حروف لاتین (معادل آوایی بنویس).
- scenes: ۳ تا ۵ صحنه با cardTitle کوتاه، metric عددی کوتاه، و items اجرایی.
- carouselSlides: با تیتر کوتاه و body حداکثر دو جمله.
- social: کپشن اینستاگرام با قلاب سه ثانیه اول، هشتگ‌های مرتبط، و پست تلگرام.`,

  SEO_EDITOR: `تو ویراستار فنی سئو هستی. مقاله را با تگ‌های معنایی HTML5 و dir="rtl" ساختار بده.
بدون استایل درون‌خطی، بدون اسکریپت، فقط h2/h3/p/ul/li/strong.`,
};

export function getPrompts() {
  const rows = db.prepare('SELECT key, value, version, updated_at FROM system_prompt').all();
  if (!rows.length) {
    const stamp = nowIso();
    const stmt = db.prepare('INSERT INTO system_prompt (key, value, version, updated_at) VALUES (?,?,1,?)');
    for (const [key, value] of Object.entries(DEFAULT_PROMPTS)) stmt.run(key, value, stamp);
    return { ...DEFAULT_PROMPTS };
  }
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function savePrompts(patch) {
  const stamp = nowIso();
  const stmt = db.prepare(
    `INSERT INTO system_prompt (key, value, version, updated_at) VALUES (?,?,1,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = version + 1, updated_at = excluded.updated_at`
  );
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    stmt.run(key, value.slice(0, 20_000), stamp);
  }
  return getPrompts();
}

/* ────────────────────────── cloud transport ────────────────────────── */

let sdk = null;
async function getSdk() {
  if (!API_KEY) return null;
  if (sdk) return sdk;
  try {
    const mod = await import('@google/genai');
    sdk = new mod.GoogleGenAI({ apiKey: API_KEY });
    return sdk;
  } catch (err) {
    logEvent('ERROR', 'ai', `SDK بارگذاری نشد: ${err.message}`);
    return null;
  }
}

async function callModel({ model, prompt, json = true, agentId = 'system' }) {
  const client = await getSdk();
  if (!client) throw Object.assign(new Error('کلید API تنظیم نشده است'), { code: 'NO_KEY' });
  const started = Date.now();
  const res = await client.models.generateContent({
    model,
    contents: prompt,
    config: json ? { responseMimeType: 'application/json' } : {},
  });
  const text = res.text ?? '';
  const latency = Date.now() - started;
  const tokens = Math.round((prompt.length + text.length) / 4);
  meter(model, tokens, latency, agentId, 'ok', prompt.length, text.length);
  return { text, model, tokens, latency };
}

/**
 * Ask a model for JSON and validate it. One corrective retry, then throw.
 * @template T
 * @param {import('zod').ZodType<T>} schema
 */
export async function askJson({ schema, prompt, agentId = 'system', label = 'پاسخ مدل' }) {
  const errors = [];
  for (const model of CHAIN) {
    const until = demoted.get(model) ?? 0;
    if (Date.now() < until) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const enriched =
          attempt === 0
            ? prompt
            : `${prompt}\n\nپاسخ قبلی نامعتبر بود: ${errors.at(-1)}.\nفقط و فقط JSON معتبر مطابق ساختار بخواه برگردان.`;
        const { text } = await callModel({ model, prompt: enriched, agentId });
        const parsed = schema.safeParse(extractJson(text));
        if (parsed.success) return { data: parsed.data, model };
        errors.push(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        meter(model, 0, 0, agentId, 'invalid-json', prompt.length, text.length, errors.at(-1));
      } catch (err) {
        const message = String(err?.message ?? err);
        errors.push(message);
        if (/404|not found|unsupported/i.test(message)) {
          demoted.set(model, Date.now() + 10 * 60 * 1000);
          break;
        }
        if (/429|503|overloaded|quota/i.test(message)) {
          demoted.set(model, Date.now() + 60 * 1000);
          break;
        }
        break;
      }
    }
  }
  logEvent('WARN', 'ai', `${label}: مدل ابری در دسترس نبود — ${errors.slice(-1)[0] ?? 'دلیل نامشخص'}`);
  return { data: null, model: null, errors };
}

/** Pull the first JSON object out of a model reply (handles ``` fences). */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/* ────────────────────────── offline generators ────────────────────────── */

const METRIC_POOL = ['+۴۰٪', '۲.۵x', '۳ گام', '-۳۰٪', '+۱۸٪', '۷ روز'];
const ANGLES = [
  { title: 'اقتصاد پنهان هر بشقاب', funnel: 'TOFU', hook: 'کجا پول از دست می‌رود؟' },
  { title: 'سیستم سه‌لایه کنترل هزینه', funnel: 'MOFU', hook: 'سه لایه‌ای که سود را برمی‌گرداند' },
  { title: 'چک‌لیست اجرایی هفتگی', funnel: 'BOFU', hook: 'همین هفته اجرا کن' },
];

function localConcepts(rawIdea, sectionCode) {
  const topic = String(rawIdea || 'سیستم‌سازی کسب‌وکار F&B').trim();
  return ConceptResponse.parse({
    topicAnalysis: `موضوع «${topic}» در زیربرند ${sectionCode} پتانسیل بالایی برای محتوای داده‌محور دارد. تمرکز پیشنهادی: تبدیل یک مسئله‌ی روزمره‌ی کافه/رستوران به یک سیستم قابل اندازه‌گیری.`,
    concepts: ANGLES.map((angle, i) => ({
      angleTitle: `${angle.title} — ${topic}`,
      summary: `${angle.hook} این زاویه برای مخاطب ${['سینا (مالک کافه)', 'مریم (قنادی)', 'کیان (سرمایه‌گذار)'][i]} نوشته می‌شود و با داده‌های قابل اندازه‌گیری شروع می‌شود.`,
      recommendedFunnel: angle.funnel,
      keyMetric: METRIC_POOL[i],
      hook: angle.hook,
    })),
  });
}

function localDeliverables({ conceptTitle, conceptSummary, sectionCode, counts }) {
  const spec = [];
  for (let i = 0; i < (counts.article || 0); i++) spec.push('article');
  for (let i = 0; i < (counts.reels || 0); i++) spec.push('reel');
  for (let i = 0; i < (counts.youtube || 0); i++) spec.push('youtube');
  for (let i = 0; i < (counts.carousels || 0); i++) spec.push('carousel');
  for (let i = 0; i < (counts.posts || 0); i++) spec.push('post');
  if (!spec.length) spec.push('reel');

  const deliverables = spec.map((type, index) => {
    const title = `${conceptTitle}${spec.length > 1 ? ` — بخش ${index + 1}` : ''}`;
    const scenes = [
      {
        id: 1,
        eyebrow: 'شروع',
        cardTitle: 'مسئله را اندازه بگیر',
        metric: '-۳۰٪',
        metricCaption: 'در سه ماه',
        items: ['ثبت روزانه داده', 'تعریف یک شاخص', 'مقایسه هفته‌به‌هفته'],
        chartData: [],
      },
      {
        id: 2,
        eyebrow: 'داده',
        cardTitle: 'تصویر واقعی هزینه',
        metric: '۲.۴x',
        metricCaption: 'بهره‌وری',
        items: ['هزینه مواد', 'حاشیه سود'],
        chartData: [
          { label: 'ضایعات', value: 42 },
          { label: 'بهره‌وری', value: 68 },
          { label: 'سود', value: 25 },
        ],
      },
      {
        id: 3,
        eyebrow: 'اجرا',
        cardTitle: 'سیستم سه‌گام',
        metric: '۳ گام',
        metricCaption: 'چک‌لیست',
        items: ['استانداردسازی', 'آموزش تیم', 'بازبینی هفتگی'],
        chartData: [],
      },
    ];
    const slides = [
      {
        templateType: 'cover',
        badge: sectionCode,
        heading: title.slice(0, 90),
        body: conceptSummary.slice(0, 220),
        highlightMetric: '-۳۰٪',
        items: [],
        chartData: [],
      },
      {
        templateType: 'stat',
        badge: 'داده',
        heading: 'کجا هدر می‌رود؟',
        body: 'سه نقطه‌ی اصلی که بیشترین اثر را روی سود دارند.',
        highlightMetric: '',
        items: ['مواد اولیه', 'زمان تیم', 'ظرفیت بلااستفاده'],
        chartData: [
          { label: 'مواد', value: 38 },
          { label: 'زمان', value: 27 },
          { label: 'ظرفیت', value: 19 },
        ],
      },
      {
        templateType: 'blueprint',
        badge: 'اجرا',
        heading: 'سه گام این هفته',
        body: 'از فردا صبح قابل اجراست.',
        highlightMetric: '۳ گام',
        items: ['شاخص را انتخاب کن', 'داده را ثبت کن', 'هفتگی بازبینی کن'],
        chartData: [],
      },
      {
        templateType: 'cta',
        badge: 'گام بعدی',
        heading: 'ابزار کامل در وب‌سایت',
        body: 'فایل اجرایی و ماشین‌حساب‌ها در atozfnb.info',
        highlightMetric: 'ATOZFNB.INFO',
        items: [],
        chartData: [],
      },
    ];
    return {
      type,
      title,
      subtitle: conceptSummary.slice(0, 140),
      voiceoverScript:
        'سلام، امیر هستم. امروز درباره یک تصمیم کوچک حرف می‌زنیم که سود ماهانه را جابه‌جا می‌کند. اول مسئله را اندازه بگیر. یک شاخص انتخاب کن و هر روز ثبت کن. بعد از سه هفته، تصویر واقعی هزینه‌ها را می‌بینی. قدم بعدی این است که یک استاندارد ساده بنویسی و تیم را روی آن آموزش بدهی. هفته‌ای یک بار بازبینی، همان چیزی است که تفاوت می‌سازد.',
      articleHtml: `<h2>${title}</h2><p>${conceptSummary}</p><h3>چرا اندازه‌گیری مهم است؟</h3><p>بدون عدد، هر تصمیمی حدس است. ثبت روزانه‌ی یک شاخص ساده، در سه هفته تصویری دقیق از هدررفت می‌سازد.</p><h3>سه گام اجرایی</h3><ul><li>یک شاخص انتخاب کن.</li><li>هر روز ثبت کن.</li><li>هفتگی بازبینی کن.</li></ul>`,
      scenes,
      carouselSlides: slides,
      social: {
        instagramCaption: `${conceptTitle}\n\n${conceptSummary}\n\nسه گام ساده که همین هفته می‌توانی اجرا کنی 👇\n۱. شاخص را انتخاب کن\n۲. داده را ثبت کن\n۳. هفتگی بازبینی کن\n\nابزار کامل در atozfnb.info`,
        telegramPost: `${conceptTitle}\n\n${conceptSummary}\n\nجزئیات و فایل اجرایی: atozfnb.info`,
        hashtags: ['#کافه', '#رستوران', '#مدیریت_کافه', '#atozfnb', '#غذا_و_نوشیدنی'],
        youtubeTitle: conceptTitle.slice(0, 90),
        youtubeDescription: conceptSummary.slice(0, 400),
        seoTitle: conceptTitle.slice(0, 60),
        seoDescription: conceptSummary.slice(0, 150),
      },
    };
  });

  return FactoryResponse.parse({ deliverables });
}

/* ────────────────────────── public agents ────────────────────────── */

export async function expandConcepts({ rawIdea, sectionCode = 'Library', useWebSearch = false }) {
  const prompts = getPrompts();
  const knowledge = loadKnowledge();
  const prompt = `${prompts.IDEATION_STRATEGY}

دانش‌پایه برند:
${knowledge}

موضوع خام: "${rawIdea}" | زیربرند: ${sectionCode}

خروجی JSON:
{"topicAnalysis":"...","concepts":[{"angleTitle":"...","summary":"...","recommendedFunnel":"TOFU|MOFU|BOFU","keyMetric":"+۴۰٪","hook":"..."}]}`;

  const { data, model } = await askJson({
    schema: ConceptResponse,
    prompt,
    agentId: 'MKT_DIR',
    label: 'ایده‌پردازی',
  });
  if (data) return { ...data, source: model, mode: 'cloud' };
  return { ...localConcepts(rawIdea, sectionCode), source: 'local-template', mode: 'local', webSearch: useWebSearch && false };
}

export async function generateBatch({ conceptTitle, conceptSummary, sectionCode = 'Library', counts = {} }) {
  const prompts = getPrompts();
  const knowledge = loadKnowledge();
  const spec = [];
  for (let i = 0; i < (counts.article || 0); i++) spec.push('article');
  for (let i = 0; i < (counts.reels || 0); i++) spec.push('reel');
  for (let i = 0; i < (counts.youtube || 0); i++) spec.push('youtube');
  for (let i = 0; i < (counts.carousels || 0); i++) spec.push('carousel');
  for (let i = 0; i < (counts.posts || 0); i++) spec.push('post');
  if (!spec.length) spec.push('reel');

  const prompt = `${prompts.UNIFIED_CONTENT_FACTORY}

دانش‌پایه برند:
${knowledge}

کانسپت: ${conceptTitle}
شرح: ${conceptSummary}
زیربرند: ${sectionCode}

دقیقاً ${spec.length} آیتم با این انواع بساز: ${JSON.stringify(spec)}

خروجی JSON:
{"deliverables":[{"type":"reel","title":"...","subtitle":"...","voiceoverScript":"...","articleHtml":"...","scenes":[{"id":1,"eyebrow":"...","cardTitle":"...","metric":"+۴۰٪","metricCaption":"...","items":["..."],"chartData":[{"label":"...","value":42}]}],"carouselSlides":[{"templateType":"cover","badge":"...","heading":"...","body":"...","highlightMetric":"...","items":[],"chartData":[]}],"social":{"instagramCaption":"...","telegramPost":"...","hashtags":[],"youtubeTitle":"","youtubeDescription":"","seoTitle":"","seoDescription":""}}]}`;

  const { data, model } = await askJson({
    schema: FactoryResponse,
    prompt,
    agentId: 'SCRIPT_DIR',
    label: 'کارخانه محتوا',
  });
  if (data) return { ...data, source: model, mode: 'cloud' };

  // Attempt a local repair of a partially-valid cloud response is out of scope:
  // deterministic template output is always better than a broken pipeline.
  return { ...localDeliverables({ conceptTitle, conceptSummary, sectionCode, counts }), source: 'local-template', mode: 'local' };
}

export async function atoozDecide({ message, context }) {
  const prompts = getPrompts();
  const prompt = `${prompts.ATOOZ_CORE}

داده‌ی زنده:
${JSON.stringify(context)}

فرمان کاربر: "${message}"

خروجی JSON:
{"reply":"...","action":"NONE|CREATE_IDEA|APPROVE_ALL_BLUEPRINTS|RENDER|OPEN_ROOM|MOVE_TO_EDIT","requiresConfirmation":true,"ideaTopic":null,"sectionCode":"Library","targetRoom":null,"targetContentId":null,"mcpToolCalled":null}`;

  const { data } = await askJson({ schema: AtoozDecision, prompt, agentId: 'ATOOZ_CORE', label: 'آتوز' });
  if (data) return data;

  return AtoozDecision.parse(localAtoozReply(message, context));
}

function localAtoozReply(message, context) {
  const text = String(message ?? '');
  const wantsIdea = /ایده|موضوع|بساز|تولید کن|ثبت/.test(text);
  const wantsApprove = /تایید|تصویب/.test(text);
  const wantsRender = /رندر|خروجی|ویدئو|ویدیو/.test(text);
  const stats = context?.stats ?? {};

  if (wantsApprove) {
    return {
      reply: `در حالت آفلاین فرمان اجرایی نمی‌سازم. ${stats.pending ?? 0} الگو در انتظار تایید است؛ از اتاق برنامه ۳ ماهه می‌توانی همه را تایید کنی.`,
      action: 'NONE',
      requiresConfirmation: false,
      mcpToolCalled: 'mcp.production.status',
    };
  }
  if (wantsRender) {
    return {
      reply: `${stats.produced ?? 0} محتوا آماده‌ی گالری است. برای رندر، محتوا را در استودیو باز کن و دکمه‌ی رندر را بزن.`,
      action: 'OPEN_ROOM',
      requiresConfirmation: false,
      targetRoom: 'studio',
    };
  }
  if (wantsIdea) {
    return {
      reply: `موضوع را گرفتم. با تایید تو، سه کانسپت و بسته تولید می‌سازم.`,
      action: 'CREATE_IDEA',
      requiresConfirmation: true,
      ideaTopic: text,
      mcpToolCalled: 'mcp.content.create_idea_batch',
    };
  }
  return {
    reply: `الان ${stats.pending ?? 0} الگو در انتظار تایید، ${stats.produced ?? 0} خروجی تولید‌شده و ${stats.jobsQueued ?? 0} جاب در صف داری. بگو چه کاری انجام بدهم.`,
    action: 'NONE',
    requiresConfirmation: false,
    mcpToolCalled: 'mcp.calendar.status',
  };
}

export function listAgentRuns(limit = 60) {
  return db.prepare('SELECT * FROM agent_run ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    model: r.model,
    status: r.status,
    tokens: r.tokens,
    latencyMs: r.latency_ms,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}

export function aiStatus() {
  return {
    mode: AI_MODE,
    hasKey: Boolean(API_KEY),
    chain: CHAIN,
    demoted: [...demoted.entries()].map(([model, until]) => ({ model, until })),
    lastRunAt: getMeta('ai:lastRunAt', null),
  };
}

export { MODEL_LIMITS };
