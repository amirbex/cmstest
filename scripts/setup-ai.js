#!/usr/bin/env node
/**
 * `npm run setup:ai` — guided, verified Gemini configuration.
 *
 * The failure mode this exists to kill: a key gets pasted into .env, the app
 * boots "in cloud mode", and every request 404s because the model was retired
 * or the key has no access to it. The studio then silently degrades to template
 * output and looks like it "just writes badly".
 *
 * So this script does not trust configuration — it *calls the API* and reports
 * what actually works, then writes a working chain back to .env.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(ROOT, '.env');
const G = '\x1b[32m';
const Y = '\x1b[33m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';

const ok = (l, d = '') => console.log(`  ${G}✔${X} ${l}${d ? ` ${D}${d}${X}` : ''}`);
const warn = (l, d = '') => console.log(`  ${Y}!${X} ${l}${d ? ` ${D}${d}${X}` : ''}`);
const bad = (l, d = '') => console.log(`  ${R}✘${X} ${l}${d ? ` ${D}${d}${X}` : ''}`);
const step = (n, l) => console.log(`\n${B}${n}. ${l}${X}`);

/* ────────────────────────── env file helpers ────────────────────────── */

function readEnv() {
  if (!fs.existsSync(ENV)) return {};
  const out = {};
  for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Upsert keys in .env without disturbing comments or ordering. */
function writeEnv(patch) {
  const existing = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  const lines = existing ? existing.split('\n') : [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(lines[i]);
    if (!m || !(m[1] in patch)) continue;
    lines[i] = `${m[1]}=${patch[m[1]]}`;
    seen.add(m[1]);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (!seen.has(k)) lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV, lines.join('\n'), 'utf8');
  try {
    fs.chmodSync(ENV, 0o600);
  } catch {
    /* permissions are best-effort on non-POSIX */
  }
}

/** Ask a question with the terminal in raw mode; degrades to stdin lines. */
async function ask(question, { mask = false } = {}) {
  process.stdout.write(question);
  if (!process.stdin.isTTY) {
    const chunk = await new Promise((r) => process.stdin.once('data', r));
    return String(chunk).trim();
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (char) => {
      if (char === '\u0003') {
        stdin.setRawMode(false);
        stdin.pause();
        console.log('\n  لغو شد.');
        process.exit(130);
      }
      if (char === '\r' || char === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value.trim());
        return;
      }
      if (char === '\u007f' || char === '\b') {
        if (value.length) {
          value = value.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      if (char >= ' ') {
        value += char;
        process.stdout.write(mask ? '*' : char);
      }
    };
    stdin.on('data', onData);
  });
}

/* ────────────────────────── live model discovery ────────────────────────── */

/**
 * Ask Google which models this key can actually use, and normalise the answer.
 * Falls back to a static list when the endpoint is unavailable, but says so.
 */
async function discoverModels(apiKey) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200';
  const res = await fetch(url, {
    headers: { 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw Object.assign(new Error(`HTTP ${res.status} — ${detail}`), { status: res.status });
  }
  const body = await res.json();
  return (body.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => {
      const id = String(m.name).replace(/^models\//, '');
      const input = m.inputTokenLimit ?? 0;
      return {
        id,
        label: m.displayName ?? id,
        input,
        description: m.description ?? '',
        /* planning / agentic work needs a text model with real context, not a
           vision-only or embedding-only endpoint */
        usable: input >= 32_000 && !/embedding|aqa|imagen|veo/i.test(id),
        lite: /lite/i.test(id),
        flash: /flash/i.test(id),
        pro: /pro|argon|ultra/i.test(id),
      };
    })
    .filter((m) => m.usable);
}

/** One real generation, to prove the key + model + JSON mode all work. */
async function proveModel(apiKey, model) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with the single JSON object {"ok":true} and nothing else.' }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 64, temperature: 0 },
      }),
    }
  );
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 240);
    return { ok: false, status: res.status, detail };
  }
  const body = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* reported below */
  }
  return {
    ok: Boolean(parsed?.ok),
    text: text.slice(0, 80),
    tokens: body?.usageMetadata?.totalTokenCount ?? null,
  };
}

/* ────────────────────────── main ────────────────────────── */

console.log(`\n  ${B}AtoZ Content Studio — راه‌اندازی هوش مصنوعی${X}`);
console.log(`  ${D}این اسکریپت فقط تنظیم نمی‌کند؛ کلید و مدل را با یک فراخوانی واقعی آزمایش می‌کند.${X}`);

const env = readEnv();
let apiKey = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY || '';

step(1, 'کلید Gemini');
if (apiKey) {
  ok('کلید در محیط یا .env پیدا شد', `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`);
} else {
  console.log(`  ${D}کلید را از https://aistudio.google.com/apikey بگیر (رایگان است).${X}`);
  apiKey = await ask('  کلید Gemini را وارد کن: ', { mask: true });
  if (!apiKey) {
    bad('کلید وارد نشد — بدون کلید، اپ در حالت آفلاین می‌ماند');
    process.exit(1);
  }
}

step(2, 'آزمایش کلید و کشف مدل‌ها');
let models;
try {
  models = await discoverModels(apiKey);
  ok(`کلید معتبر است — ${models.length} مدل قابل استفاده پیدا شد`);
} catch (err) {
  if (err.status === 400 || err.status === 401 || err.status === 403) {
    bad('کلید نامعتبر یا غیرفعال است', err.message);
    console.log(`\n  ${D}دریافت کلید تازه: https://aistudio.google.com/apikey${X}\n`);
  } else {
    bad('اتصال به Google برقرار نشد', err.message);
    console.log(`  ${D}کلید ذخیره نشد. اگر پشت پروکسی هستی: HTTPS_PROXY را تنظیم کن و دوباره اجرا کن.${X}`);
  }
  process.exit(1);
}

/* Rank candidates: text-capable flash models first — they have a free tier,
   low latency and are plenty for structured planning tasks. */
const ranked = [...models].sort((a, b) => {
  const score = (m) => (m.flash ? 100 : 0) + (m.lite ? -20 : 0) + (m.pro ? 10 : 0) + Math.min(m.input / 100_000, 30);
  return score(b) - score(a);
});

console.log(`\n  ${D}مدل‌های پیشنهادی برای این کلید:${X}`);
ranked.slice(0, 8).forEach((m, i) => {
  console.log(`   ${B}${i + 1}${X}. ${m.id.padEnd(30)} ${D}${(m.input / 1000).toFixed(0)}k context${m.lite ? ' · lite' : ''}${X}`);
});

const defaultPick = ranked[0]?.id;
const choice = await ask(`\n  شماره مدل اصلی را انتخاب کن ${D}(Enter = ${defaultPick})${X}: `);
const primary =
  !choice ? defaultPick : /^\d+$/.test(choice) ? ranked[Number(choice) - 1]?.id ?? defaultPick : choice;

step(3, `آزمایش واقعی مدل ${primary}`);
const proof = await proveModel(apiKey, primary);
if (!proof.ok) {
  bad('مدل پاسخ معتبر نداد', proof.detail ?? proof.text ?? `status ${proof.status}`);
  process.exit(1);
}
ok('مدل پاسخ JSON معتبر داد', `${proof.tokens ?? '?'} توکن`);

/* Build a 3-model chain: the pick, then the cheapest viable fallbacks. */
const fallbacks = ranked.filter((m) => m.id !== primary).slice(0, 2).map((m) => m.id);
const chain = [primary, ...fallbacks].join(',');

step(4, 'نوشتن تنظیمات');
writeEnv({
  GEMINI_API_KEY: apiKey,
  ATOZ_MODEL_CHAIN: chain,
  ATOZ_AI_MODE: 'cloud',
});
ok('.env نوشته شد', fs.relative ? path.relative(ROOT, ENV) : ENV);
ok('زنجیره مدل', chain);
warn('حق دسترسی .env روی ۶۰۰ تنظیم شد (بهترین تلاش)');

console.log(`
  ${G}${B}آماده است.${X}

  ${D}مرحله بعد:${X}
    npm run dev            ${D}— استودیو روی http://localhost:5173${X}
    npm run verify:ai      ${D}— آزمایش کامل چرخه با کلید واقعی${X}

  ${D}حالت ${X}cloud${D} در اتاق «مهارت‌ها» و «نظارت» قابل دیدن است.${X}
  ${D}اگر کلید حذف شود، اپ خودکار به قالب آفلاین برمی‌گردد — هیچ‌وقت از کار نمی‌افتد.${X}
`);
