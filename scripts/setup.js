#!/usr/bin/env node
/**
 * `npm run setup` — verify the machine can run the studio, and tell the truth.
 *
 * Everything here is a *check*, never a hard requirement: the studio is designed
 * to boot with zero network, zero API keys and zero TTS engine. This script
 * prints exactly what is available so the user knows which quality tier they
 * are in, and creates the storage layout + fonts index if missing.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const G = '\x1b[32m';
const Y = '\x1b[33m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const X = '\x1b[0m';

const ok = (label, detail = '') => console.log(`  ${G}✔${X} ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
const warn = (label, detail = '') => console.log(`  ${Y}!${X} ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
const bad = (label, detail = '') => console.log(`  ${R}✘${X} ${label}${detail ? ` ${D}${detail}${X}` : ''}`);

console.log(`\n  AtoZ Content Studio v6 — setup check\n`);

/* ─────────────── 1. node & built-ins ─────────────── */

const [major, minor] = process.versions.node.split('.').map(Number);
const nodeOk = major > 22 || (major === 22 && minor >= 5);
(nodeOk ? ok : bad)(
  `Node ${process.versions.node}`,
  nodeOk ? '(node:sqlite available)' : '— Node 22.5+ is required for the built-in SQLite driver'
);

try {
  await import('node:sqlite');
  ok('node:sqlite bundled driver');
} catch (err) {
  bad('node:sqlite', `— ${err.message}`);
}

/* ─────────────── 2. npm dependencies ─────────────── */

for (const [id, label] of [
  ['@resvg/resvg-js', 'SVG rasteriser (resvg)'],
  ['@ffmpeg-installer/ffmpeg', 'bundled ffmpeg binary'],
  ['zod', 'schema validation'],
]) {
  try {
    const resolved = require.resolve(id, { paths: [ROOT] });
    ok(label, path.relative(ROOT, resolved));
  } catch {
    bad(label, '— run `npm install`');
  }
}

/* ─────────────── 3. ffmpeg / ffprobe ─────────────── */

function probeBinary(cmd, args = ['-version']) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n')[0].trim();
  } catch {
    return null;
  }
}

const bundledFfmpeg = (() => {
  try {
    return require('@ffmpeg-installer/ffmpeg').path;
  } catch {
    return null;
  }
})();

if (bundledFfmpeg && fs.existsSync(bundledFfmpeg)) {
  ok('ffmpeg', `bundled → ${path.relative(ROOT, bundledFfmpeg)}`);
} else {
  const system = probeBinary('ffmpeg');
  (system ? ok : bad)('ffmpeg', system ?? '— video rendering will be unavailable (stills still work)');
}

/* ─────────────── 4. fonts ─────────────── */

const FONT_DIR = path.join(ROOT, 'app', 'web', 'public', 'fonts');
const fonts = fs.existsSync(FONT_DIR) ? fs.readdirSync(FONT_DIR).filter((f) => f.endsWith('.woff2')) : [];
if (fonts.length >= 5) ok(`Vazirmatn fonts`, `${fonts.length} woff2 files in app/web/public/fonts`);
else if (fonts.length) warn(`Vazirmatn fonts`, `only ${fonts.length} files — Persian shaping may look wrong`);
else bad('Vazirmatn fonts', '— missing; text will fall back to a system font');

/* ─────────────── 5. offline engines ─────────────── */

const PY = process.env.ATOZ_PYTHON || 'python3';
function pyImport(mod) {
  try {
    execFileSync(PY, ['-c', `import ${mod}`], { timeout: 8000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const piperBin = process.env.ATOZ_PIPER || path.join(ROOT, 'bin', 'piper');
const piperModel = process.env.ATOZ_PIPER_MODEL || path.join(ROOT, 'bin', 'fa_IR-amir-medium.onnx');
if (fs.existsSync(piperBin) && fs.existsSync(piperModel)) {
  ok('Piper TTS', 'offline neural voice ready');
} else {
  warn('Piper TTS', 'optional — drop bin/piper + bin/fa_IR-amir-medium.onnx for offline narration');
}

pyImport('pyttsx3')
  ? ok('pyttsx3', 'offline system voice available')
  : warn('pyttsx3', 'optional — `pip install pyttsx3` for offline system voice');

pyImport('edge_tts')
  ? ok('edge-tts', 'network voice available')
  : warn('edge-tts', 'optional — network voices are off; the app still produces silent-timed reels');

const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ATOZ_AI_KEY;
if (apiKey) ok('AI provider key', 'cloud generation enabled');
else warn('AI provider key', 'absent — cloud agents will fall back');

/* local model reachability decides between local-llm and template mode */
const localUrl = process.env.ATOZ_LOCAL_AI_URL;
if (localUrl) {
  try {
    const res = await fetch(`${localUrl.replace(/\/+$/, '')}/models`, {
      signal: AbortSignal.timeout(4000),
      headers: process.env.ATOZ_LOCAL_AI_KEY ? { authorization: `Bearer ${process.env.ATOZ_LOCAL_AI_KEY}` } : {},
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      const models = (body.data ?? []).map((m) => m.id).slice(0, 3);
      ok('Local LLM', `${localUrl} · ${models.join(', ') || 'reachable'}`);
    } else {
      bad('Local LLM', `${localUrl} responded ${res.status} — check ATOZ_LOCAL_AI_URL`);
    }
  } catch (err) {
    bad('Local LLM', `${localUrl} unreachable — ${err.message}`);
  }
} else {
  warn('Local LLM', 'not configured — set ATOZ_LOCAL_AI_URL for a free offline model');
}

/* skills are the injected prompt context; an empty folder silently degrades output */
const skillDir = path.join(ROOT, 'skills');
const skillCount = fs.existsSync(skillDir)
  ? fs.readdirSync(skillDir, { recursive: true }).filter((f) => String(f).endsWith('SKILL.md')).length
  : 0;
skillCount ? ok('Skills', `${skillCount} SKILL.md files`) : bad('Skills', '— skills/ is empty; prompts get no injected rules');

const kbDir = path.join(ROOT, 'knowledge-base');
const kbCount = fs.existsSync(kbDir) ? fs.readdirSync(kbDir).filter((f) => f.endsWith('.md')).length : 0;
kbCount ? ok('Knowledge base', `${kbCount} documents`) : warn('Knowledge base', 'empty — agents get no brand truth');

/* ─────────────── 6. storage layout ─────────────── */

const dirs = [
  'storage/data',
  'storage/assets',
  'storage/jobs',
  'storage/outputs/covers',
  'storage/outputs/carousels',
  'storage/outputs/reels',
  'storage/outputs/previews',
  'storage/outputs/audio',
];
for (const rel of dirs) fs.mkdirSync(path.join(ROOT, rel), { recursive: true });
ok('storage layout', `${dirs.length} directories`);

/* ─────────────── 7. brand config ─────────────── */

const brandFile = path.join(ROOT, 'brand.json');
if (fs.existsSync(brandFile)) {
  try {
    const brand = JSON.parse(fs.readFileSync(brandFile, 'utf8'));
    ok('brand.json', `${brand.brandName ?? 'unnamed'} · ${Object.keys(brand.sectionThemes ?? {}).length} section themes`);
  } catch (err) {
    bad('brand.json', `— invalid JSON: ${err.message}`);
  }
} else {
  bad('brand.json', '— missing');
}

/* ─────────────── summary ─────────────── */

console.log(`
  ${D}Next:${X}
    npm run seed     ${D}— load the demo batch (2 ideas, ready to render)${X}
    npm run dev      ${D}— API on :4000 + studio on :5173${X}
    npm test         ${D}— engine + domain regression suite${X}
`);
