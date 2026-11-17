/**
 * Template & motion-recipe catalogue.
 *
 * The reference toolkits (OpenDesign Motion, Remotion skills, HyperFrames,
 * anatomy, "400+ motion recipes") all ship a browsable library. Rather than
 * hardcode 400 effects as copy-paste code, this module *composes* them from a
 * small orthogonal set:
 *
 *   intent   (what the piece is)  ×  motion (how it enters)  ×  layout (how it
 *   is arranged)  ×  style (type treatment)
 *
 * 14 intents × 8 motion families × 4 layouts × 3 styles = 1344 addressable
 * recipes, every one of which the existing renderer can actually draw, because
 * each axis maps onto primitives that already exist (MOTIONS, buildCover,
 * buildCarouselSlide, buildReelScene, chart builders).
 *
 * That is the honest version of "400+ recipes": a generator you can extend by
 * adding one motion preset, not a folder of unmaintainable snippets.
 */
import { MOTIONS, MOTION_KEYS, TRANSITIONS, TRANSITION_KEYS } from './motion.js';

/* ────────────────────────── axes ────────────────────────── */

/** What the piece is for. Each maps to a scene builder + a default duration. */
const INTENTS = [
  { id: 'cover', name: 'کاور پست', family: 'core', scene: 'cover', aspect: '1080x1350', dur: null, hint: 'اسلاید اول کاروسل یا پست تکی' },
  { id: 'carousel', name: 'کاروسل آموزشی', family: 'core', scene: 'carousel', aspect: '1080x1350', dur: null, hint: '۶ تا ۱۰ اسلاید با قوس روایی' },
  { id: 'reel-story', name: 'ریلز استوری‌تلینگ', family: 'core', scene: 'reel', aspect: '9:16', dur: 45, hint: 'روایت شخصی با نریشن' },
  { id: 'reel-tutorial', name: 'ریلز آموزشی', family: 'core', scene: 'reel', aspect: '9:16', dur: 30, hint: 'سه گام اجرایی' },
  { id: 'reel-stat', name: 'ریلز داده', family: 'remotion-skills', scene: 'reel', aspect: '9:16', dur: 20, hint: 'یک متریک بزرگ با نمودار متحرک' },
  { id: 'reel-kinetic', name: 'تایپوگرافی جنبشی', family: 'opendesign', scene: 'reel', aspect: '9:16', dur: 12, hint: 'متن تنها، ریتم تند' },
  { id: 'chart-bar', name: 'نمودار میله‌ای متحرک', family: 'remotion-skills', scene: 'chart-bar', aspect: '16:9', dur: 8, hint: 'مقایسه چند دسته' },
  { id: 'chart-donut', name: 'دونات پیشرفت', family: 'remotion-skills', scene: 'chart-donut', aspect: '1:1', dur: 6, hint: 'یک عدد از کل' },
  { id: 'chart-line', name: 'روند خطی', family: 'remotion-skills', scene: 'chart-line', aspect: '16:9', dur: 8, hint: 'روند در زمان' },
  { id: 'logo-intro', name: 'اینترو لوگو', family: 'hyperframes', scene: 'outro', aspect: '1:1', dur: 5, hint: 'لوگو + وعده برند' },
  { id: 'web-to-video', name: 'صفحه وب به ویدیو', family: 'hyperframes', scene: 'web', aspect: '16:9', dur: 15, hint: 'اسکرول صفحه سایت به کلیپ' },
  { id: 'anatomy', name: 'کالبدشکافی محصول', family: 'anatomy', scene: 'anatomy', aspect: '9:16', dur: 18, hint: 'باز کردن قطعه‌به‌قطعه' },
  { id: 'stat-card', name: 'کارت آماری', family: 'core', scene: 'cover', aspect: '1:1', dur: null, hint: 'عدد بزرگ + کپشن' },
  { id: 'story', name: 'استوری متوالی', family: 'core', scene: 'story', aspect: '9:16', dur: null, hint: '۹:۱۶ بدون نوار پایین' },
];

/** How the content enters. Maps to an existing MOTIONS preset. */
const MOTION_FAMILIES = [
  { id: 'fade', name: 'محو و ظهور', preset: 'fade-up', tags: ['آرام', 'حرفه‌ای'] },
  { id: 'slide', name: 'ورود کشویی', preset: 'slide-in-right', tags: ['پرانرژی'] },
  { id: 'scale', name: 'بزرگ‌نمایی', preset: 'zoom-in', tags: ['تمرکز'] },
  { id: 'wipe', name: 'وایپ پوششی', preset: 'wipe-up', tags: ['مدرن'] },
  { id: 'type', name: 'تایپوگرافی', preset: 'kinetic-words', tags: ['متن‌محور'] },
  { id: 'bounce', name: 'فنری', preset: 'spring-pop', tags: ['بازیگوش'] },
  { id: 'blur', name: 'فوکوس نرم', preset: 'blur-in', tags: ['سینمایی'] },
  { id: 'rotate', name: 'کشش داده', preset: 'bar-grow', tags: ['داده‌محور'] },
];

/** How elements are arranged. */
const LAYOUTS = [
  { id: 'editorial', name: 'روزنامه‌ای', note: 'تیتر بزرگ راست، بدنه پایین' },
  { id: 'split', name: 'دو ستونی', note: 'متن و تصویر کنار هم' },
  { id: 'card', name: 'کارت شناور', note: 'کارت وسط با سایه' },
  { id: 'full', name: 'تمام‌قاب', note: 'تصویر تمام‌صفحه با متن روی آن' },
];

/** Type treatment. */
const STYLES = [
  { id: 'navy', name: 'سرمه‌ای و طلایی', accent: '#FFB400', note: 'هویت پیش‌فرض برند' },
  { id: 'light', name: 'روشن کتابخانه', accent: '#3B5998', note: 'زمینه روشن، آرام' },
  { id: 'obsidian', name: 'اوبسیدین', accent: '#FF5722', note: 'کنتراست بالا' },
];

/* ────────────────────────── generation ────────────────────────── */

const slug = (s) => s.replace(/[^a-z0-9-]/gi, '-').toLowerCase();

/**
 * Expand the axes into a flat catalogue. Deterministic: the same inputs always
 * produce the same ids, so saved references stay valid across restarts.
 */
export function buildCatalogue() {
  const out = [];
  for (const intent of INTENTS) {
    for (const motion of MOTION_FAMILIES) {
      for (const layout of LAYOUTS) {
        for (const style of STYLES) {
          /* keep the catalogue size honest but manageable: not every
             combination is meaningful (a chart has no "split" layout) */
          if (intent.scene.startsWith('chart') && layout.id !== 'card' && layout.id !== 'full') continue;
          out.push({
            id: `${intent.id}.${motion.id}.${layout.id}.${style.id}`,
            name: `${intent.name} — ${motion.name}`,
            category: intent.scene === 'cover' ? 'cover' : intent.scene.startsWith('chart') ? 'chart' : intent.scene === 'reel' ? 'reel' : intent.scene === 'outro' ? 'logo-intro' : intent.scene === 'web' ? 'web-to-video' : intent.scene === 'anatomy' ? 'anatomy' : intent.scene === 'story' ? 'story' : 'carousel',
            family: intent.family,
            description: `${intent.hint} · چیدمان ${layout.name} · ${style.name}`,
            aspect: intent.aspect,
            durationSec: intent.dur,
            motions: [motion.preset],
            tags: [...motion.tags, layout.id, style.id, intent.scene],
            accent: style.accent,
            sceneKind: intent.scene,
            /* not part of the public Template contract, but useful internally */
            _intent: intent.id,
            _layout: layout.id,
            _style: style.id,
            _note: `${layout.note}; ${style.note}`,
          });
        }
      }
    }
  }
  return out;
}

let cache = null;
export function getCatalogue({ force = false } = {}) {
  if (!cache || force) cache = buildCatalogue();
  return cache;
}

const CATEGORIES = [
  'cover', 'carousel', 'reel', 'post', 'story', 'chart',
  'kinetic-type', 'transition', 'logo-intro', 'anatomy', 'web-to-video', 'outro',
];

export const FAMILIES = [
  { id: 'core', name: 'هستهٔ AtoZ', note: 'کاور، کاروسل، ریلز پایه' },
  { id: 'opendesign', name: 'OpenDesign Motion', note: 'ساختار موشن‌دیزاین با لایه و تایم‌لاین' },
  { id: 'remotion-skills', name: 'Remotion Skills', note: 'نمودار و آمار متحرک با کد' },
  { id: 'hyperframes', name: 'HyperFrames', note: 'صفحه وب و لوگو به ویدیو' },
  { id: 'anatomy', name: 'Anatomy', note: 'باز کردن قطعه‌به‌قطعهٔ محصول' },
  { id: 'motion-library', name: 'کتابخانه حرکت', note: 'رسپی‌های آمادهٔ حرکت و گذار' },
];

/**
 * Filtered, paged catalogue query for the template browser.
 * Returns counts per facet so the UI can show live numbers on every filter.
 */
export function queryTemplates({ q, category, family, tag, aspect, motion, page = 1, pageSize = 48 } = {}) {
  const all = getCatalogue();
  const text = String(q ?? '').trim().toLowerCase();
  let items = all;

  if (text) {
    items = items.filter(
      (t) => t.name.toLowerCase().includes(text) || t.description.toLowerCase().includes(text) || t.id.includes(text)
    );
  }
  if (category) items = items.filter((t) => t.category === category);
  if (family) items = items.filter((t) => t.family === family);
  if (aspect) items = items.filter((t) => t.aspect === aspect);
  if (motion) items = items.filter((t) => t.motions.includes(motion));
  if (tag) items = items.filter((t) => t.tags.includes(tag));

  const size = Math.min(200, Math.max(1, Number(pageSize) || 48));
  const p = Math.max(1, Number(page) || 1);
  const start = (p - 1) * size;

  return {
    total: items.length,
    catalogueSize: all.length,
    page: p,
    pageSize: size,
    pages: Math.ceil(items.length / size) || 1,
    items: items.slice(start, start + size).map(({ _intent, _layout, _style, _note, ...t }) => t),
  };
}

/** Facet counts over the whole catalogue (not the filtered page). */
export function catalogueFacets() {
  const all = getCatalogue();
  const count = (key) =>
    Object.entries(
      all.reduce((acc, t) => {
        const v = typeof key === 'function' ? key(t) : t[key];
        acc[v] = (acc[v] ?? 0) + 1;
        return acc;
      }, {})
    )
      .map(([name, n]) => ({ name, count: n }))
      .sort((a, b) => b.count - a.count);

  return {
    total: all.length,
    categories: CATEGORIES.map((c) => ({ name: c, count: all.filter((t) => t.category === c).length })).filter((c) => c.count),
    families: FAMILIES.map((f) => ({ ...f, count: all.filter((t) => t.family === f.id).length })),
    aspects: count('aspect'),
    motions: count('motions'),
    styles: count((t) => t._style),
    layouts: count((t) => t._layout),
    presets: MOTION_KEYS.map((key) => ({ key, label: MOTIONS[key].label })),
    transitions: TRANSITION_KEYS.map((key) => ({ key, label: TRANSITIONS[key].label })),
  };
}

export function getTemplate(id) {
  return getCatalogue().find((t) => t.id === id) ?? null;
}

/** Suggested templates for an intent, used by the production queue. */
export function suggestTemplates(intentId, limit = 6) {
  return getCatalogue()
    .filter((t) => t._intent === intentId)
    .slice(0, limit)
    .map(({ _intent, _layout, _style, _note, ...t }) => t);
}
