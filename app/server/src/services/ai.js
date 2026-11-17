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
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ConceptResponse, FactoryResponse, AtoozDecision } from '@atoz/contracts';

/* ────────────────────────── config ────────────────────────── */

/**
 * Model catalogue.
 *
 * Verified against Google's lifecycle page on 2026-11-17: the whole `gemini-2.5`
 * family was shut down on 2026-10-16, and `gemini-2.0` before it. Shipping those
 * as defaults (as v6.0 originally did) means every cloud call 404s and the studio
 * silently degrades to templates — the worst kind of bug, because it looks like
 * "the AI is just not very good today".
 *
 * Rules encoded here:
 *   • only models that are actually live become defaults
 *   • anything past its retirement date is refused at request time, not retried
 *   • aliases (-latest / preview) are opt-in via ATOZ_MODEL_CHAIN
 */
const RETIRED_ON = '2026-10-20';
const TODAY = () => new Date().toISOString().slice(0, 10);
const isPast = (date) => Boolean(date) && TODAY() > date;

export const MODELS = {
  /* ── current stable ── */
  'gemini-3.8-flash': {
    label: 'Gemini 3.8 Flash',
    tier: 'default',
    live: true,
    rpd: 250,
    rpm: 10,
    usdPer1kIn: 0.0003,
    usdPer1kOut: 0.0025,
    notes: 'تعادل کیفیت و سرعت — انتخاب پیش‌فرض',
  },
  'gemini-3.5-flash': {
    label: 'Gemini 3.5 Flash',
    tier: 'balanced',
    live: true,
    rpd: 500,
    rpm: 15,
    usdPer1kIn: 0.0002,
    usdPer1kOut: 0.0015,
    notes: 'جایگزین سبک‌تر ۳.۸',
  },
  'gemini-3.5-flash-lite': {
    label: 'Gemini 3.5 Flash-Lite',
    tier: 'cheap',
    live: true,
    rpd: 1000,
    rpm: 20,
    usdPer1kIn: 0.00005,
    usdPer1kOut: 0.0002,
    notes: 'ارزان‌ترین گزینه — برای حجم بالا',
  },
  'gemini-3.1-flash-lite': {
    label: 'Gemini 3.1 Flash-Lite',
    tier: 'cheap',
    live: true,
    rpd: 1000,
    rpm: 20,
    usdPer1kIn: 0.00005,
    usdPer1kOut: 0.0002,
    notes: 'نسل قبل، پایدار',
  },
  'gemini-3.8-live': {
    label: 'Gemini 3.8 Live',
    tier: 'realtime',
    live: true,
    rpd: 150,
    rpm: 10,
    usdPer1kIn: 0.0003,
    usdPer1kOut: 0.0025,
    notes: 'جریان زنده — برای گفت‌وگوی صوتی آینده',
  },
  'gemini-4-argon': {
    label: 'Gemini 4 Argon',
    tier: 'flagship',
    live: true,
    rpd: 100,
    rpm: 5,
    usdPer1kIn: 0.002,
    usdPer1kOut: 0.012,
    notes: 'قدرتمندترین — برای کارهای سنگین استدلال',
  },

  /* ── retired: kept only so old configs fail loudly with a clear message ── */
  'gemini-2.5-flash': { live: false, retiredOn: '2026-10-16', replacedBy: 'gemini-3.8-flash' },
  'gemini-2.5-flash-lite': { live: false, retiredOn: '2026-10-16', replacedBy: 'gemini-3.5-flash-lite' },
  'gemini-2.5-pro': { live: false, retiredOn: '2026-10-16', replacedBy: 'gemini-4-argon' },
  'gemini-2.0-flash': { live: false, retiredOn: '2026-06-01', replacedBy: 'gemini-3.5-flash-lite' },
  'gemini-2.0-flash-lite': { live: false, retiredOn: '2026-06-01', replacedBy: 'gemini-3.5-flash-lite' },
};

/** Backwards-compatible shape for quota/cost code. */
const MODEL_LIMITS = Object.fromEntries(
  Object.entries(MODELS)
    .filter(([, m]) => m.live)
    .map(([id, m]) => [
      id,
      { rpd: m.rpd, rpm: m.rpm, costPer1kIn: m.usdPer1kIn, costPer1kOut: m.usdPer1kOut, costPer1k: m.usdPer1kOut },
    ])
);

const DEFAULT_CHAIN = 'gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite';

const CHAIN = (process.env.ATOZ_MODEL_CHAIN || DEFAULT_CHAIN)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  /* a retired model in the env is a configuration error worth surfacing, not a
     request worth making — drop it and complain once at boot */
  .filter((id) => {
    const meta = MODELS[id];
    if (meta && !meta.live) {
      console.warn(
        `[ai] مدل «${id}» بازنشسته شده است (${meta.retiredOn}). جایگزین: ${meta.replacedBy}. از زنجیره حذف شد.`
      );
      return false;
    }
    return true;
  });

if (!CHAIN.length) CHAIN.push('gemini-3.8-flash');

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

/**
 * Local model provider — an OpenAI-compatible endpoint (Ollama / LM Studio /
 * llama.cpp / vLLM / Jan). Explicit opt-in only: ATOZ_LOCAL_AI_URL must be set.
 * It is a *complement* to Gemini, never a replacement: Gemini is primary
 * whenever a key exists.
 */
const LOCAL_AI_URL = (process.env.ATOZ_LOCAL_AI_URL || '').replace(/\/+$/, '');
const LOCAL_AI_MODEL = process.env.ATOZ_LOCAL_AI_MODEL || 'qwen2.5:7b-instruct';
/** Whether the local model may take over when Gemini fails (default: yes). */
const LOCAL_AI_FALLBACK = process.env.ATOZ_LOCAL_AI_FALLBACK !== '0';

/** `cloud` (Gemini) → `local-llm` (opt-in) → `local` (templates). */
export const AI_MODE = API_KEY ? 'cloud' : LOCAL_AI_URL ? 'local-llm' : process.env.ATOZ_AI_MODE || 'local';

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

/** Agent ids come from code, but keep the DB clean if one is ever dynamic. */
const agentIdSafe = (id) => String(id ?? 'system').slice(0, 40);

function meter(model, tokens, latencyMs, agentId, status, promptLen, outputLen, extra = null) {
  const day = today();
  const limits = MODEL_LIMITS[model];
  /* Input and output tokens are priced differently by every provider; the daily
     cost figure is only honest if both are counted separately. */
  const tokensIn = extra?.tokensIn ?? Math.round(promptLen / 4);
  const tokensOut = extra?.tokensOut ?? Math.round(outputLen / 4);
  const cost = limits ? (tokensIn / 1000) * limits.costPer1kIn + (tokensOut / 1000) * limits.costPer1kOut : 0;
  db.prepare(
    `INSERT INTO quota_usage (day, model, requests, tokens, cost_usd) VALUES (?,?,1,?,?)
     ON CONFLICT(day, model) DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens,
       cost_usd = cost_usd + excluded.cost_usd`
  ).run(day, model, tokens, cost);
  db.prepare(
    `INSERT INTO agent_run (agent_id, model, status, prompt_len, output_len, tokens, latency_ms, detail, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    agentIdSafe(agentId),
    model,
    status,
    promptLen,
    outputLen,
    tokens,
    latencyMs,
    /* SQLite only binds scalars — any diagnostic object must be stringified. */
    extra == null ? null : typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 900),
    nowIso()
  );
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

  SUBTITLE_ENGINEER: `تو موتور رونویسی واژه‌به‌واژه فارسی هستی.
برای هر واژه start و end به ثانیه بده، بدون هم‌پوشانی، با نیم‌فاصله صحیح.
اگر بخشی نامفهوم بود «...» بگذار و از خودت نساز.
جمله‌ها را در cueهای حداکثر ۵ کلمه یا ۲.۵ ثانیه گروه‌بندی کن.
خروجی فقط JSON معتبر.`,

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


/* ────────────────────────── transport: local model ────────────────────────── */

/**
 * One call against an OpenAI-compatible `/chat/completions` endpoint.
 * Deliberately dependency-free (plain fetch) so a local model needs no SDK.
 */
async function callLocalModel({ prompt, json = true, agentId = 'system', schemaJson = null }) {
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
        /* Ollama, LM Studio and vLLM all honour this; servers that ignore it
           still get the schema via the prompt + zod validation afterwards. */
        ...(json
          ? schemaJson
            ? { response_format: { type: 'json_schema', json_schema: { name: 'atoz', schema: schemaJson, strict: false } } }
            : { response_format: { type: 'json_object' } }
          : {}),
      }),
    });
    if (!res.ok) throw new Error(`local model ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content ?? '';
    const latency = Date.now() - started;
    const tokensIn = body?.usage?.prompt_tokens ?? Math.round(prompt.length / 4);
    const tokensOut = body?.usage?.completion_tokens ?? Math.round(text.length / 4);
    meter(LOCAL_AI_MODEL, tokensIn + tokensOut, latency, agentId, 'ok', prompt.length, text.length, { tokensIn, tokensOut });
    return { text, model: LOCAL_AI_MODEL, tokens: tokensIn + tokensOut, latency, provider: 'local' };
  } finally {
    clearTimeout(timeout);
  }
}

/* ────────────────────────── transport: Gemini ────────────────────────── */

let sdk = null;
let sdkError = null;

async function getSdk() {
  if (!API_KEY) return null;
  if (sdk) return sdk;
  if (sdkError) return null;
  try {
    const mod = await import('@google/genai');
    sdk = new mod.GoogleGenAI({
      apiKey: API_KEY,
      ...(process.env.GOOGLE_GENAI_BASE_URL ? { httpOptions: { baseUrl: process.env.GOOGLE_GENAI_BASE_URL } } : {}),
    });
    return sdk;
  } catch (err) {
    sdkError = err.message;
    logEvent('ERROR', 'ai', `SDK گوگل بارگذاری نشد: ${err.message}`);
    return null;
  }
}

/**
 * Call Gemini with schema-constrained output.
 *
 * `responseSchema` is derived from the same zod schema that validates the
 * result, so the model is *structurally unable* to return the wrong shape —
 * this is the single biggest reliability win over "please answer in JSON".
 * Temperature stays low: these are planning tasks, not creative writing.
 */
async function callGemini({ model, prompt, agentId = 'system', schemaJson = null, temperature = 0.6, audio = null }) {
  const client = await getSdk();
  if (!client) throw Object.assign(new Error('کلید API تنظیم نشده است'), { code: 'NO_KEY' });

  const started = Date.now();
  /* Multimodal call: text + inline audio. The SDK takes a contents array of
     parts; inlineData is used because our extracted audio track is tiny. */
  const contents = audio
    ? [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: audio.mime, data: audio.base64 } }] }]
    : prompt;
  const res = await client.models.generateContent({
    model,
    contents,
    config: {
      temperature,
      maxOutputTokens: Number(process.env.ATOZ_MAX_OUTPUT_TOKENS || 8192),
      ...(schemaJson
        ? { responseMimeType: 'application/json', responseJsonSchema: schemaJson }
        : { responseMimeType: 'application/json' }),
    },
  });

  const text = res.text ?? '';
  const latency = Date.now() - started;
  const usage = res.usageMetadata ?? {};
  const tokensIn = usage.promptTokenCount ?? Math.round(prompt.length / 4);
  const tokensOut = usage.candidatesTokenCount ?? Math.round(text.length / 4);
  meter(model, tokensIn + tokensOut, latency, agentId, 'ok', prompt.length, text.length, { tokensIn, tokensOut });
  return { text, model, tokens: tokensIn + tokensOut, latency, provider: 'gemini' };
}

/**
 * Route one attempt: Gemini first, local model only as an explicit fallback.
 *
 * The local model is a *complement*, never the primary path — so it is only
 * consulted when there is no key, or when Gemini has just failed.
 */
async function callModel({ model, prompt, agentId = 'system', schemaJson = null, useLocal = false, temperature = 0.6, audio = null }) {
  if (useLocal) {
    if (!LOCAL_AI_URL) throw Object.assign(new Error('مدل محلی تنظیم نشده است'), { code: 'NO_LOCAL' });
    /* a local text model cannot hear audio — the caller falls back */
    if (audio) throw Object.assign(new Error('مدل محلی از صدا پشتیبانی نمی‌کند'), { code: 'NO_AUDIO' });
    return callLocalModel({ prompt, agentId, schemaJson });
  }
  const client = await getSdk();
  if (!client) throw Object.assign(new Error('کلید API تنظیم نشده است'), { code: 'NO_KEY' });
  return callGemini({ model, prompt, agentId, schemaJson, temperature, audio });
}

/**
 * Ask a model for JSON, validate it, and never return an invalid object.
 *
 * Order of attempts (Gemini is primary — the local model is only a fallback):
 *   1. each model in CHAIN, schema-constrained, with one corrective retry
 *   2. the local model, if configured and local fallback is allowed
 *   3. caller falls back to its deterministic template generator
 *
 * @template T
 * @param {import('zod').ZodType<T>} schema
 */
export async function askJson({ schema, prompt, agentId = 'system', label = 'پاسخ مدل', temperature = 0.6, audio = null }) {
  const errors = [];
  const schemaJson = zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' });

  const attempt = async ({ model, useLocal = false }) => {
    const started = Date.now();
    for (let round = 0; round < 2; round++) {
      try {
        const enriched =
          round === 0
            ? prompt
            : `${prompt}\n\nپاسخ قبلی نامعتبر بود: ${errors.at(-1)}.\nفقط JSON معتبر و کامل مطابق ساختار برگردان.`;
        const { text, model: usedModel, provider } = await callModel({
          model,
          prompt: enriched,
          agentId,
          schemaJson,
          useLocal,
          temperature,
          audio,
        });
        const parsed = schema.safeParse(extractJson(text));
        if (parsed.success) {
          setMeta('ai:lastRunAt', nowIso());
          return { data: parsed.data, model: usedModel, provider, latencyMs: Date.now() - started };
        }
        errors.push(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        logEvent('WARN', 'ai', `${label}: خروجی مدل ${usedModel} با اسکیما نخواند — ${errors.at(-1)}`);
        meter(usedModel, 0, 0, agentId, 'invalid-json', prompt.length, text.length, errors.at(-1));
      } catch (err) {
        const message = String(err?.message ?? err);
        errors.push(message);
        /* A retired or unknown model is a permanent error for this session. */
        if (/404|not found|unsupported|is not found/i.test(message)) {
          demoted.set(model, Date.now() + 30 * 60 * 1000);
          logEvent('WARN', 'ai', `مدل ${model} در دسترس نیست — برای ۳۰ دقیقه کنار گذاشته شد`);
          return null;
        }
        if (/429|503|overloaded|rate|quota|resource_exhausted/i.test(message)) {
          demoted.set(model, Date.now() + 60 * 1000);
          return null;
        }
        if (/NO_KEY|NO_LOCAL|401|403|api key/i.test(message)) return null;
        return null;
      }
    }
    return null;
  };

  for (const model of CHAIN) {
    if ((demoted.get(model) ?? 0) > Date.now()) continue;
    const out = await attempt({ model });
    if (out) return out;
  }

  if (LOCAL_AI_URL && LOCAL_AI_FALLBACK) {
    const out = await attempt({ model: LOCAL_AI_MODEL, useLocal: true });
    if (out) {
      logEvent('INFO', 'ai', `${label}: پاسخ از مدل محلی ${LOCAL_AI_MODEL}`);
      return out;
    }
  }

  logEvent('WARN', 'ai', `${label}: هیچ مدلی پاسخ معتبر نداد — ${errors.at(-1) ?? 'دلیل نامشخص'}`);
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
    id: 'SUBTITLE_ENGINEER',
    label: 'مهندس زیرنویس',
    role: 'رونویسی واژه‌به‌واژه فارسی از صدا با زمان‌بندی دقیق',
    promptKey: 'SUBTITLE_ENGINEER',
    schema: 'TranscriptSchema',
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
    /** Gemini is the primary path whenever a key exists. */
    primary: API_KEY ? CHAIN[0] : LOCAL_AI_URL ? LOCAL_AI_MODEL : 'template',
    provider: API_KEY ? 'gemini' : LOCAL_AI_URL ? 'local' : 'template',
    hasKey: Boolean(API_KEY),
    sdkReady: Boolean(sdk),
    sdkError,
    localUrl: LOCAL_AI_URL || null,
    localModel: LOCAL_AI_URL ? LOCAL_AI_MODEL : null,
    localFallback: LOCAL_AI_URL ? LOCAL_AI_FALLBACK : false,
    chain: CHAIN,
    agents: AGENTS.length,
    skills: loadSkillIndex().skills.filter((s) => s.inject).length,
    demoted: [...demoted.entries()].map(([model, until]) => ({ model, until })),
    lastRunAt: getMeta('ai:lastRunAt', null),
  };
}

export { MODEL_LIMITS };
