/**
 * Brand asset resolution.
 *
 * The identity package in `assets/` is the authority for *what the brand looks
 * like*: the real AZ monogram, the six subbrand lockups, per-platform social
 * icons, backgrounds and patterns. This module is the only place that knows the
 * folder layout, so the canvas code can ask for "the AI subbrand lockup on a
 * light background" instead of hard-coding a path.
 *
 * Two rules shape the design:
 *
 *   1. **Never fabricate a mark.** The previous renderer drew the brand name as
 *      text in the corner. A production design tool that cannot place the actual
 *      logo is not a production design tool. If the asset is missing we degrade
 *      honestly (text fallback) instead of inventing a look-alike.
 *   2. **SVG is inlined, raster is embedded.** resvg resolves neither external
 *      files nor relative URLs, so SVG bodies are read and injected into the
 *      document, while PNGs are base64 data URIs. Both are cached because a reel
 *      asks for the same logo 900 times.
 */
import fs from 'node:fs';
import path from 'node:path';

const ASSETS_ROOT = process.env.ATOZ_ASSETS_DIR || path.resolve('assets');

/* Section code -> the folder name used by the identity package. They happen to
   match today, but the map keeps that an explicit fact rather than a guess. */
const BRAND_DIRS = {
  AI: 'AI',
  Library: 'Library',
  Magazine: 'Magazine',
  Calculators: 'Calculators',
  Solutions: 'Solutions',
  Academy: 'Academy',
};

const cache = new Map();
const warned = new Set();

function warnOnce(what) {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(`[assets] نداریم: ${what}`);
}

function abs(rel) {
  return path.join(ASSETS_ROOT, rel);
}

function exists(rel) {
  try {
    return fs.statSync(abs(rel)).isFile();
  } catch {
    return false;
  }
}

/* ────────────────────────── raw loaders ────────────────────────── */

/** Read an SVG file and strip the XML prolog so it can be inlined. */
function readSvgBody(rel) {
  const key = `svg:${rel}`;
  if (cache.has(key)) return cache.get(key);
  let body = null;
  try {
    body = fs.readFileSync(abs(rel), 'utf8')
      .replace(/<\?xml[^>]*\?>/g, '')
      .replace(/<!DOCTYPE[^>]*>/g, '')
      .trim();
  } catch {
    /* candidates are probed speculatively — only the caller that finds nothing
       at all reports a miss, via `miss()` */
    return null;
  }
  cache.set(key, body);
  return body;
}

function readDataUri(rel) {
  const key = `uri:${rel}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const ext = path.extname(rel).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
    const uri = `data:${mime};base64,${fs.readFileSync(abs(rel)).toString('base64')}`;
    cache.set(key, uri);
    return uri;
  } catch {
    return null;
  }
}

/**
 * Pull the intrinsic width/height and viewBox out of an SVG so the caller can
 * fit it into a box without distorting it.
 */
function readSvgGeometry(rel) {
  const body = readSvgBody(rel);
  if (!body) return null;
  const openTag = /<svg[^>]*>/i.exec(body)?.[0] ?? '';
  const num = (attr) => {
    const m = new RegExp(`${attr}\\s*=\\s*["']([\\d.]+)`, 'i').exec(openTag);
    return m ? Number(m[1]) : null;
  };
  const viewBox = /viewBox\s*=\s*["']([^"']+)["']/i.exec(openTag)?.[1];
  const vb = viewBox ? viewBox.trim().split(/[\s,]+/).map(Number) : null;
  const width = num('width') ?? (vb ? vb[2] : null);
  const height = num('height') ?? (vb ? vb[3] : null);
  return {
    body,
    width,
    height,
    viewBox: vb ?? [0, 0, width, height],
    ratio: width && height ? width / height : 1,
  };
}

/* ────────────────────────── logos ────────────────────────── */

/**
 * Pick a parent (AtoZ) logo file.
 * @param {'color'|'white'|'black'|'mono'} variant
 * @param {'horizontal'|'full'|'vertical'|'wordmark'} layout
 * @param {'en'|'fa'} lang
 */
export function parentLogo({ variant = 'color', layout = 'horizontal', lang = 'en' } = {}) {
  const rel = `parent/${lang}/svg/${layout}-${lang === 'en' ? 'latin' : 'fa'}-${variant}.svg`;
  const geometry = readSvgGeometry(rel);
  if (geometry) return { ...geometry, rel, kind: 'svg' };

  /* the fa folder names files with -persian, fall back through the real names */
  const candidates = [
    `parent/${lang}/svg/${layout}-${lang}-${variant}.svg`,
    `parent/en/svg/${layout}-latin-${variant}.svg`,
    `parent/${lang}/png/${layout}-${lang}-${variant}.png`,
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) {
      if (candidate.endsWith('.svg')) return { ...readSvgGeometry(candidate), rel: candidate, kind: 'svg' };
      return { uri: readDataUri(candidate), rel: candidate, kind: 'png' };
    }
  }
  warnOnce(`parent logo ${variant}/${layout}/${lang}`);
  return null;
}

/** Read the real file listing once so we never guess a filename. */
let logoIndexCache = null;
function logoIndex() {
  if (logoIndexCache) return logoIndexCache;
  const index = { parent: {}, subbrands: {} };
  const scan = (dir, bucket) => {
    try {
      for (const file of fs.readdirSync(abs(dir))) {
        const m = /^(full|horizontal|vertical|wordmark)-(.+)\.svg$/.exec(file);
        if (!m) continue;
        const [, layout, rest] = m;
        const variant = rest.replace(/^latin-/, '').replace(/^persian-/, '').replace(/^fa-/, '');
        bucket[`${layout}:${variant}`] = `${dir}/${file}`;
      }
    } catch {
      /* folder may not exist */
    }
  };
  scan('parent/en/svg', index.parent);
  scan('parent/fa/svg', index.parent);
  logoIndexCache = index;
  return index;
}

export function listLogoVariants() {
  return Object.keys(logoIndex().parent).sort();
}

/**
 * The subbrand lockup the identity package ships: a horizontal lockup where the
 * subbrand wordmark baseline sits on the AZ body bottom.
 */
export function subbrandLockup(sectionCode, { variant = 'full', align = 'baseline' } = {}) {
  const dir = BRAND_DIRS[sectionCode];
  if (!dir) return null;
  const rel = `subbrands/${dir}/lockups/lockup-horizontal-${align}-${variant}.svg`;
  const geometry = readSvgGeometry(rel);
  if (geometry) return { ...geometry, rel, kind: 'svg' };
  warnOnce(rel);
  return null;
}

/** Profile/avatar image for a subbrand or the parent. */
export function avatarFor(sectionCode) {
  const dir = BRAND_DIRS[sectionCode];
  const rel = dir ? `subbrands/${dir}/avatar.svg` : 'parent/icons/svg/avatar.svg';
  if (exists(rel)) return { ...readSvgGeometry(rel), rel, kind: 'svg' };
  return null;
}

/* ────────────────────────── social icons ────────────────────────── */

/**
 * Which actions exist per platform in the identity package. Instagram has a
 * like/save/reels vocabulary, Telegram has join/forward/notification, YouTube
 * has like/subscribe/notification. Asking for the wrong pair is a programming
 * error, so it returns null rather than probing the filesystem.
 */
export const PLATFORM_ACTIONS = {
  instagram: ['like-heart', 'comment', 'send', 'save', 'follow', 'reels'],
  telegram: ['join', 'forward', 'notification', 'save', 'send', 'comment'],
  youtube: ['like-heart', 'subscribe', 'notification', 'save', 'comment', 'send'],
};

const SOCIAL_KINDS = Object.values(PLATFORM_ACTIONS).flat();

/**
 * Resolve a social action icon for a platform + section.
 *
 * The identity package ships three weights (`outline`, `soft`, and
 * `-accent`) at three colours (white, navy, blue). We pick the accent weight
 * by default because that is what a CTA banner needs.
 */
export function socialIcon(platform, kind, { sectionCode = null, tone = 'accent', weight = 'outline' } = {}) {
  const plat = String(platform ?? 'instagram').toLowerCase();
  if (!SOCIAL_KINDS.includes(kind)) return null;

  const toneSuffix = tone === 'accent' ? '-accent' : `-${tone}`;

  /* Not every subbrand ships its own social set (Library has identity icons
     only), so the section folder is tried first and the parent set is the
     documented fallback rather than a silent miss. */
  const bases = [];
  if (sectionCode && BRAND_DIRS[sectionCode]) bases.push(`subbrands/${BRAND_DIRS[sectionCode]}/icons/${plat}`);
  bases.push(`parent/social-icons/${plat}`);

  const candidates = [];
  for (const base of bases) {
    candidates.push(`${base}/${weight}-${kind}${toneSuffix}.svg`, `${base}/${weight}-${kind}.svg`);
  }
  for (const rel of candidates) {
    const geometry = readSvgGeometry(rel);
    if (geometry) return { ...geometry, rel, kind: 'svg' };
  }

  /* a missing youtube:reels is expected — aliases cover it */
  const alias = readAliasMap();
  const direct = candidates.find((c) => alias[c]);
  if (direct) {
    const geometry = readSvgGeometry(alias[direct]);
    if (geometry) return { ...geometry, rel: alias[direct], kind: 'svg' };
  }
  return null;
}

let aliasCache = null;
function readAliasMap() {
  if (aliasCache) return aliasCache;
  try {
    const raw = JSON.parse(fs.readFileSync(abs('icon-aliases.json'), 'utf8'));
    aliasCache = raw.aliases ?? {};
  } catch {
    aliasCache = {};
  }
  return aliasCache;
}

/** Every icon the package actually has, for the asset browser. */
/** Report a genuine miss (called once, by whoever needed the asset). */
export function miss(what) {
  warnOnce(what);
}

export function listIcons() {
  try {
    const raw = JSON.parse(fs.readFileSync(abs('icon-index.json'), 'utf8'));
    return raw;
  } catch {
    return { brands: {} };
  }
}

/* ────────────────────────── backgrounds & patterns ────────────────────────── */

/**
 * Section background template (1920x1080 landscape or 1080x1350 portrait).
 * Returned as an inlineable SVG body so the renderer can nest it.
 */
export function backgroundFor(sectionCode, orientation = 'portrait') {
  const dir = BRAND_DIRS[sectionCode];
  if (!dir) return null;
  const rel = `backgrounds/${dir}/${orientation}.svg`;
  return readSvgGeometry(rel) ? { ...readSvgGeometry(rel), rel, kind: 'svg' } : null;
}

/**
 * The base fill a section background paints, i.e. whether the artwork is a light
 * or a dark canvas.
 *
 * This matters more than it looks: the identity package ships six backgrounds,
 * and they are not all dark. `AI` and `Calculators` are navy (#0A1931, #071923)
 * while `Library`, `Academy`, `Magazine` and `Solutions` are light (#F8FAFC,
 * #F9F7F2). Rendering white headlines over a light background produces an
 * invisible cover — which is exactly what happened before this existed. The
 * theme must follow the artwork, not a caller's guess, so this reads the first
 * full-bleed `<rect>` out of the SVG and judges it by relative luminance.
 *
 * @returns {{ lum: number, isDark: boolean, bg: string } | null}
 */
export function backgroundTone(sectionCode, orientation = 'portrait') {
  const bg = backgroundFor(sectionCode, orientation);
  if (!bg?.body) return null;

  /* First rect in document order is the page fill in every shipped background. */
  const m = /<rect[^>]*?fill="(#[0-9A-Fa-f]{3,8})"[^>]*?>/.exec(bg.body);
  const hex = m ? m[1] : null;
  if (!hex) return { lum: 0.5, isDark: false, bg: null };

  const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex.slice(0, 7);
  const r = parseInt(full.slice(1, 3), 16) / 255;
  const g = parseInt(full.slice(3, 5), 16) / 255;
  const b = parseInt(full.slice(5, 7), 16) / 255;
  /* WCAG relative luminance; sRGB transfer function applied per channel. */
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return { lum: +lum.toFixed(4), isDark: lum < 0.35, bg: full };
}

/**
 * One pattern file, ready to place.
 *
 * The two shipped patterns are 1920×1080 and paint their own page fill (always
 * `#F8FAFC`, on every section, regardless of the section background). Dropped in
 * as-is they would destroy a dark section, so the canvas places them with the
 * page fill suppressed and only the tiled artwork kept — see `patternOverlay`
 * in canvas.js. This function just resolves and caches the geometry.
 *
 * @param {'editorial-system'|'identity-weave'} name
 */
export function patternFor(sectionCode, name = 'identity-weave') {
  const dir = BRAND_DIRS[sectionCode];
  if (!dir) return null;
  const rel = `patterns/${dir}/${name}.svg`;
  const geometry = readSvgGeometry(rel);
  return geometry ? { ...geometry, rel, kind: 'svg' } : null;
}

export function patternsFor(sectionCode) {
  const dir = BRAND_DIRS[sectionCode];
  if (!dir) return [];
  const folder = `patterns/${dir}`;
  try {
    return fs
      .readdirSync(abs(folder))
      .filter((f) => f.endsWith('.svg'))
      .map((f) => ({ name: f.replace('.svg', ''), rel: `${folder}/${f}` }));
  } catch {
    return [];
  }
}

/* ────────────────────────── tokens ────────────────────────── */

let tokensCache = null;
export function identityTokens() {
  if (tokensCache) return tokensCache;
  const read = (rel) => {
    try {
      return JSON.parse(fs.readFileSync(abs(rel), 'utf8'));
    } catch {
      return null;
    }
  };
  tokensCache = {
    tokens: read('reference/tokens.json'),
    designSystem: read('reference/design-system.json'),
    identity: read('identity-tokens.json'),
    iconIndex: read('icon-index.json'),
    iconAliases: read('icon-aliases.json'),
  };
  return tokensCache;
}

/** Typography scale straight from the identity package, not from memory. */
export function typography() {
  const t = identityTokens().tokens?.typography ?? {};
  return {
    faHeadline: 'Vazirmatn',
    faBody: 'Vazirmatn',
    latinHeading: 'Montserrat',
    latinBody: 'Lato',
    levels: t,
  };
}

/* ────────────────────────── inventory ────────────────────────── */

/** Walk the asset tree — used by the asset room so the real library is visible. */
export function inventory({ maxDepth = 3 } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(abs(dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = path.join(dir, entry.name).split(path.sep).join('/');
      if (entry.isDirectory()) {
        const files = countFiles(rel);
        out.push({ path: rel, type: 'dir', files, bytes: dirBytes(rel) });
        walk(rel, depth + 1);
      }
    }
  };
  const countFiles = (rel) => {
    try {
      return fs.readdirSync(abs(rel), { withFileTypes: true }).filter((e) => e.isFile()).length;
    } catch {
      return 0;
    }
  };
  const dirBytes = (rel) => {
    try {
      return fs
        .readdirSync(abs(rel), { withFileTypes: true })
        .filter((e) => e.isFile())
        .reduce((sum, e) => sum + fs.statSync(abs(`${rel}/${e.name}`)).size, 0);
    } catch {
      return 0;
    }
  };
  walk('', 0);
  return out;
}

export function assetStats() {
  let files = 0;
  let bytes = 0;
  const byExt = {};
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(abs(dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(rel);
      } else {
        files++;
        const size = fs.statSync(abs(rel)).size;
        bytes += size;
        const ext = path.extname(entry.name).toLowerCase() || 'none';
        byExt[ext] = (byExt[ext] ?? 0) + 1;
      }
    }
  };
  walk('');
  return { files, bytes, byExt, root: ASSETS_ROOT };
}

export function invalidate() {
  cache.clear();
  aliasCache = null;
  tokensCache = null;
  logoIndexCache = null;
  warned.clear();
}

export { ASSETS_ROOT, BRAND_DIRS };
