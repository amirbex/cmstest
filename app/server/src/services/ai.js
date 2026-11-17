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

/**
 * Local model provider — an OpenAI-compatible endpoint, which covers Ollama
 * (`http://localhost:11434/v1`), LM Studio, llama.cpp server, vLLM and Jan.
 * This is the offline brain: no key, no network egress, no per-token cost.
 * Enable with ATOZ_LOCAL_AI_URL; model name via ATOZ_LOCAL_AI_MODEL.
 */
const LOCAL_AI_URL = (process.env.ATOZ_LOCAL_AI_URL || '').replace(/\/+$/, '');
const LOCAL_AI_MODEL = process.env.ATOZ_LOCAL_AI_MODEL || 'qwen2.5:7b-instruct';

/** `cloud` (key present) → `local-llm` (Ollama reachable) → `local` (templates). */
export const AI_MODE = API_KEY
  ? 'cloud'
  : LOCAL_AI_URL
    ? 'local-llm'
    : process.env.ATOZ_AI_MODE || 'local';

const demoted = new Map(); // model -> unix ms until which it is skipped

/* ────────────────────────── metering ────────────────────────── */

const today = () => new Date().toISOString().slice(0, 10);

export function quotaSnapshot() {
  const day = today();
  const rows = db.prepare('SELECT * FROM quota_usage WHERE day = ?').all(day);
  const usage = Object.fromEntries(rows.map((r) => [r.model, r]));
  /* In local-llm mode the chain is irrelevant — report the model actually used.
     Local models also have no per-request cost, so the figure reads 0 by design
     rather than by accident. */
  const models = LOCAL_AI_URL && !API_KEY ? [LOCAL_AI_MODEL] : CHAIN;
  return models.map((model) => ({
    model,
    used: usage[model]?.requests ?? 0,
    tokens: usage[model]?.tokens ?? 0,
    costUsd: +(usage[model]?.cost_usd ?? 0).toFixed(4),
    limit: MODEL_LIMITS[model]?.rpd ?? 500,
    rpm: MODEL_LIMITS[model]?.rpm ?? 10,
    local: !MODEL_LIMITS[model],
  }));
}

function meter(model, tokens, latencyMs, agentId, status, promptLen, outputLen, detail = null) {
  const day = today();
  /* A local model has no marginal cost; charging it would make the monitor lie. */
  const cost = MODEL_LIMITS[model] ? (MODEL_LIMITS[model].costPer1k * tokens) / 1000 : 0;
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

/**
 * Skills + knowledge loader.
 *
 * A "skill" is a markdown file under `skills/<id>/SKILL.md` with YAML-ish
 * front-matter. It is not documentation — it is *injected context*: the body is
 * concatenated into the prompt of every agent listed in `agents`, so editing a
 * file changes model behaviour with no code change.
 *
 *   ---
 *   id: persian-copy
 *   title: نگارش فارسی
 *   agents: ATOOZ_CORE, SCRIPT_DIR
 *   inject: true
 *   ---
 *   …rules…
 *
 * `knowledge-base/**\/*.md` is always-on brand truth and has no front-matter.
 *
 * v5.0 walked only the top level and ignored front-matter entirely; here we walk
 * three levels deep, and each skill is addressable by id so a prompt can pull
 * just the skills it needs.
 */
const ROOTS = { skills: 'skills', knowledge: 'knowledge-base' };
const MAX_SKILL_CHARS = 2400;
const MAX_TOTAL_CHARS = 14_000;

/** Parse the small front-matter subset we use: `key: value` lines. */
function parseFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep < 1) continue;
    const key = line.slice(0, sep).trim();
    const raw = line.slice(sep + 1).trim();
    if (!key || !raw) continue;
    meta[key] = /^(true|false)$/i.test(raw) ? raw.toLowerCase() === 'true' : raw;
  }
  return { meta, body: text.slice(match[0].length) };
}

let skillCache = null;

/** Read and index every skill + knowledge file. Cached until `invalidateSkills()`. */
export function loadSkillIndex({ force = false } = {}) {
  if (skillCache && !force) return skillCache;
  const skills = [];
  const knowledge = [];

  const walk = (dir, depth = 0) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.md') || entry.name.startsWith('.')) continue;
      const raw = fs.readFileSync(full, 'utf-8');
      const { meta, body } = parseFrontMatter(raw);
      if (full.startsWith(path.resolve(ROOTS.skills))) {
        const id = meta.id || path.basename(path.dirname(full));
        skills.push({
          id,
          title: meta.title || id,
          capability: meta.capability || '',
          agents: String(meta.agents || '')
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean),
          inject: meta.inject !== false,
          tags: String(meta.tags || '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          file: path.relative(process.cwd(), full),
          body: body.trim(),
        });
      } else {
        knowledge.push({
          id: path.basename(full, '.md'),
          file: path.relative(process.cwd(), full),
          body: body.trim(),
        });
      }
    }
  };

  walk(path.resolve(ROOTS.skills));
  walk(path.resolve(ROOTS.knowledge));
  skills.sort((a, b) => a.id.localeCompare(b.id));
  knowledge.sort((a, b) => a.id.localeCompare(b.id));

  skillCache = { skills, knowledge, loadedAt: nowIso() };
  return skillCache;
}

export function invalidateSkills() {
  skillCache = null;
}

/**
 * Build the injectable context for one agent.
 *
 * Includes always-on knowledge plus every skill whose `agents` lists this agent
 * (or that universally applies when `agents` is empty). Budgeted so a runaway
 * knowledge base can never silently blow up a prompt.
 */
export function buildContext(agentId) {
  const { skills, knowledge } = loadSkillIndex();
  const parts = [];
  let used = 0;
  const push = (label, file, body) => {
    const slice = body.slice(0, MAX_SKILL_CHARS);
    if (used + slice.length > MAX_TOTAL_CHARS) return false;
    used += slice.length;
    parts.push(`\n--- [${label} · ${file}] ---\n${slice}`);
    return true;
  };

  for (const doc of knowledge) push(doc.id, doc.file, doc.body);
  const applied = [];
  for (const skill of skills) {
    if (!skill.inject) continue;
    if (skill.agents.length && !skill.agents.includes(agentId)) continue;
    if (push(skill.id, skill.file, skill.body)) applied.push(skill.id);
  }
  return { text: parts.join(''), applied, chars: used };
}

/** Backwards-compatible: the whole knowledge+skills blob, no agent filter. */
export function loadKnowledge() {
  const { skills, knowledge } = loadSkillIndex();
  return [...knowledge.map((k) => ({ ...k, label: 'knowledge' })), ...skills.map((s) => ({ ...s, label: 'skill' }))]
    .map((item) => `\n--- [${item.file}] ---\n${item.body.slice(0, MAX_SKILL_CHARS)}`)
    .join('');
}

/** The skill catalogue, for the Skills room and the API. */
export function listSkills() {
  const { skills, knowledge, loadedAt } = loadSkillIndex();
  return {
    loadedAt,
    skills: skills.map(({ body, ...rest }) => ({ ...rest, chars: body.length, preview: body.slice(0, 260) })),
    knowledge: knowledge.map(({ body, ...rest }) => ({ ...rest, chars: body.length, preview: body.slice(0, 260) })),
  };
}

/** Read one skill's full body (for the editor in the Skills room). */
export function readSkill(id) {
  const { skills, knowledge } = loadSkillIndex();
  return [...skills, ...knowledge].find((item) => item.id === id) ?? null;
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

/**
 * One call against an OpenAI-compatible `/chat/completions` endpoint.
 * Deliberately dependency-free (plain fetch) so no SDK is needed offline.
 */
async function callLocalModel({ prompt, json = true, agentId = 'system' }) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.ATOZ_LOCAL_AI_TIMEOUT_MS || 120_000));
  try {
    const res = await fetch(`${LOCAL_AI_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: LOCAL_AI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`local model ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content ?? '';
    const latency = Date.now() - started;
    const tokens = body?.usage?.total_tokens ?? Math.round((prompt.length + text.length) / 4);
    meter(LOCAL_AI_MODEL, tokens, latency, agentId, 'ok', prompt.length, text.length);
    return { text, model: LOCAL_AI_MODEL, tokens, latency };
  } finally {
    clearTimeout(timeout);
  }
}

async function callModel({ model, prompt, json = true, agentId = 'system' }) {
  const client = await getSdk();
  if (!client) {
    if (LOCAL_AI_URL) return callLocalModel({ prompt, json, agentId });
    throw Object.assign(new Error('کلید API تنظیم نشده است'), { code: 'NO_KEY' });
  }
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
        const { text, model: usedModel } = await callModel({ model, prompt: enriched, agentId });
        const parsed = schema.safeParse(extractJson(text));
        /* Report the model that actually answered, not the slot we asked for:
           the local fallback answers under a different name than the chain. */
        if (parsed.success) return { data: parsed.data, model: usedModel, via: usedModel === model ? 'chain' : 'local' };
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
  const ctx = buildContext('MKT_DIR');
  const knowledge = ctx.text;
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
  if (data) return { ...data, source: model, mode: LOCAL_AI_URL && model === LOCAL_AI_MODEL ? 'local-llm' : 'cloud' };
  return { ...localConcepts(rawIdea, sectionCode), source: 'local-template', mode: 'local', webSearch: false };
}

export async function generateBatch({ conceptTitle, conceptSummary, sectionCode = 'Library', counts = {} }) {
  const prompts = getPrompts();
  const ctx = buildContext('SCRIPT_DIR');
  const knowledge = ctx.text;
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
  if (data) return { ...data, source: model, mode: LOCAL_AI_URL && model === LOCAL_AI_MODEL ? 'local-llm' : 'cloud' };

  // Attempt a local repair of a partially-valid cloud response is out of scope:
  // deterministic template output is always better than a broken pipeline.
  return { ...localDeliverables({ conceptTitle, conceptSummary, sectionCode, counts }), source: 'local-template', mode: 'local' };
}

export async function atoozDecide({ message, context }) {
  const prompts = getPrompts();
  const ctx = buildContext('ATOOZ_CORE');
  const prompt = `${prompts.ATOOZ_CORE}

دانش‌پایه و مهارت‌های فعال:
${ctx.text}

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

/**
 * The agent roster. Each entry is a role with its own prompt key, its own
 * skills, its own output contract and its own quota bucket — not a chat
 * persona. Adding an agent means adding a prompt key + a `skills/` folder.
 */
export const AGENTS = [
  {
    id: 'ATOOZ_CORE',
    label: 'آتوز — دستیار فرماندهی',
    role: 'گفت‌وگو با کاربر، تصمیم‌گیری و پیشنهاد اقدام',
    promptKey: 'ATOOZ_CORE',
    schema: 'AtoozDecision',
    canAct: true,
    model: 'chain',
  },
  {
    id: 'MKT_DIR',
    label: 'مدیر بازاریابی',
    role: 'تحلیل موضوع و ساخت سه کانسپت متمایز',
    promptKey: 'IDEATION_STRATEGY',
    schema: 'ConceptResponse',
    canAct: false,
    model: 'chain',
  },
  {
    id: 'SCRIPT_DIR',
    label: 'کارگردان محتوا',
    role: 'ساخت بسته‌ی کامل: صحنه، نریشن، کاروسل، سوشال',
    promptKey: 'UNIFIED_CONTENT_FACTORY',
    schema: 'FactoryResponse',
    canAct: false,
    model: 'chain',
  },
  {
    id: 'SEO_EDITOR',
    label: 'ویراستار فنی سئو',
    role: 'ساختاردهی HTML معنایی برای مقاله',
    promptKey: 'SEO_EDITOR',
    schema: 'articleHtml (sub-field)',
    canAct: false,
    model: 'chain',
  },
];

/** Roster augmented with live skill bindings and last-run telemetry. */
export function agentRoster() {
  return AGENTS.map((agent) => {
    const ctx = buildContext(agent.id);
    const last = db
      .prepare('SELECT status, latency_ms, tokens, created_at FROM agent_run WHERE agent_id = ? ORDER BY id DESC LIMIT 1')
      .get(agent.id);
    const runs = db.prepare('SELECT COUNT(*) AS n FROM agent_run WHERE agent_id = ?').get(agent.id).n;
    return {
      ...agent,
      skills: ctx.applied,
      contextChars: ctx.chars,
      runs,
      lastRunAt: last?.created_at ?? null,
      lastLatencyMs: last?.latency_ms ?? null,
    };
  });
}

export function aiStatus() {
  return {
    mode: AI_MODE,
    hasKey: Boolean(API_KEY),
    localUrl: LOCAL_AI_URL || null,
    localModel: LOCAL_AI_URL ? LOCAL_AI_MODEL : null,
    chain: CHAIN,
    agents: AGENTS.length,
    skills: loadSkillIndex().skills.filter((s) => s.inject).length,
    demoted: [...demoted.entries()].map(([model, until]) => ({ model, until })),
    lastRunAt: getMeta('ai:lastRunAt', null),
  };
}

export { MODEL_LIMITS };
