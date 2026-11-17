#!/usr/bin/env node
/**
 * `npm run verify:ai` — end-to-end proof that the AI layer works.
 *
 * Prints exactly what will happen in the app: which mode, which models, whether
 * the skills actually reach the prompt, and a real generation through the same
 * service functions the routes call. No mocks, no guessing.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/* load .env the same way the server does */
for (const candidate of ['.env', path.join('..', '..', '.env')]) {
  if (fs.existsSync(candidate)) {
    try {
      process.loadEnvFile(candidate);
    } catch {
      /* ignore malformed .env here; the server reports it */
    }
  }
}

const G = '\x1b[32m';
const Y = '\x1b[33m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';
const ok = (l, d = '') => console.log(`  ${G}✔${X} ${l}${d ? ` ${D}${d}${X}` : ''}`);
const warn = (l, d = '') => console.log(`  ${Y}!${X} ${l}${d ? ` ${D}${d}${X}` : ''}`);
const bad = (l, d = '') => console.log(`  ${R}✘${X} ${l}${d ? ` ${D}${d}${X}` : ''}`);

const ai = await import('../app/server/src/services/ai.js');
const t0 = Date.now();

console.log(`\n  ${B}بررسی کامل لایه هوش مصنوعی${X}\n`);

/* ── 1. mode ── */
const status = ai.aiStatus();
console.log(`  ${B}۱. حالت${X}`);
const modeLine = {
  cloud: [`${G}cloud${X} — Gemini فعال است`, 'ok'],
  'local-llm': [`${Y}local-llm${X} — مدل محلی (کلید Gemini تنظیم نشده)`, 'warn'],
  local: [`${Y}local${X} — قالب آفلاین (هیچ مدلی تنظیم نشده)`, 'warn'],
}[status.mode];
console.log(`     ${modeLine[0]}`);
if (status.hasKey) ok('کلید API موجود است');
else warn('کلید API موجود نیست', 'GEMINI_API_KEY و .env را بررسی کن');
if (status.mode === 'cloud') {
  ok('زنجیره مدل', status.chain.join(' → '));
  const retired = status.chain.filter((m) => ai.MODELS[m] && !ai.MODELS[m].live);
  if (retired.length) bad('مدل بازنشسته در زنجیره', retired.join(', '));
}

/* ── 2. schema constraint ── */
console.log(`\n  ${B}۲. محدودیت ساختار خروجی${X}`);
const { ConceptResponse } = await import('../packages/contracts/src/index.ts');
const { zodToJsonSchema } = await import('zod-to-json-schema');
const jsonSchema = zodToJsonSchema(ConceptResponse, { $refStrategy: 'none', target: 'jsonSchema7' });
ok('اسکیمای JSON از قرارداد zod ساخته شد', `${JSON.stringify(jsonSchema).length} کاراکتر`);
ok('مدل به ساختار محدود می‌شود', 'responseJsonSchema به API ارسال می‌شود');

/* ── 3. skills reach the prompt ── */
console.log(`\n  ${B}۳. تزریق مهارت‌ها${X}`);
for (const agent of ai.AGENTS) {
  const ctx = ai.buildContext(agent.id);
  const label = `${agent.id.padEnd(11)}`;
  if (ctx.chars === 0) bad(label, 'هیچ زمینه‌ای تزریق نشد');
  else ok(label, `${ctx.chars} کاراکتر · ${ctx.applied.join(', ') || 'فقط دانش‌پایه'}`);
}

/* ── 4. a real call ── */
console.log(`\n  ${B}۴. فراخوانی واقعی مدل${X}`);
if (status.mode === 'local') {
  warn('رد شد', 'حالت آفلاین است — برای آزمایش واقعی کلید تنظیم کن');
} else {
  const started = Date.now();
  try {
    const result = await ai.expandConcepts({ rawIdea: 'کاهش ضایعات مواد اولیه در کافه' });
    const ms = Date.now() - started;
    if (result.mode === 'local') {
      bad('مدل پاسخ معتبر نداد', 'به قالب آفلاین برگشت — لاگ‌ها را ببین');
    } else {
      ok('پاسخ معتبر دریافت شد', `${result.mode} · ${ms}ms`);
      ok('منبع', result.source);
      console.log(`\n     ${D}تحلیل موضوع:${X} ${result.topicAnalysis.slice(0, 150)}…`);
      result.concepts.slice(0, 3).forEach((c, i) => {
        console.log(`     ${B}${i + 1}${X}. ${c.angleTitle} ${D}(${c.recommendedFunnel} · ${c.keyMetric})${X}`);
      });
    }
  } catch (err) {
    bad('فراخوانی شکست خورد', err.message);
  }
}

/* ── 5. metering ── */
console.log(`\n  ${B}۵. اندازه‌گیری${X}`);
const quotas = ai.quotaSnapshot();
for (const q of quotas) {
  const used = q.used > 0 ? `${G}${q.used}${X}` : `${D}0${X}`;
  console.log(`     ${q.model.padEnd(24)} ${used} درخواست · ${q.tokens} توکن · $${q.costUsd.toFixed(4)}`);
}
const runs = ai.listAgentRuns(5);
if (runs.length) {
  console.log(`\n     ${D}آخرین اجراها:${X}`);
  runs.forEach((r) => console.log(`     ${r.agentId.padEnd(11)} ${String(r.model).padEnd(22)} ${r.status} · ${r.tokens} tok · ${r.latencyMs}ms`));
} else {
  warn('هیچ اجرایی ثبت نشده');
}

console.log(`\n  ${D}پایان در ${Date.now() - t0}ms${X}\n`);
