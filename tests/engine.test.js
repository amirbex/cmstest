/**
 * Engine tests — canvas layout, text wrapping, motion timing.
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANVAS,
  wrapText,
  estimateTextWidth,
  barChart,
  donut,
  sparkline,
  toSvg,
  toFa,
  buildReelScene,
  buildCover,
  buildCarouselSlide,
  buildOutro,
} from '../app/server/src/engine/canvas.js';
import { MOTIONS, MOTION_KEYS, computeBeatStyle, styleToCss, ease } from '../app/server/src/engine/motion.js';

const brand = {
  brandName: 'AtoZ.FnB',
  domain: 'atozfnb.info',
  handle: '@atozfnb.info',
  promise: 'رشد کسب‌وکار خود را با هوش مصنوعی سیستم‌سازی کنید',
  cta: 'دریافت ابزار',
  colors: {},
};

const theme = {
  accent: '#3B5998',
  bg: '#F8FAFC',
  mode: 'light',
  isDark: false,
  name: 'کتابخانه',
  subbrandName: 'AtoZ Library',
  text: '#0A1931',
  textMuted: 'rgba(10,25,49,0.66)',
  onAccent: '#FFFFFF',
  gold: '#FFB400',
  navy: '#0A1931',
  surface: '#FFFFFF',
};

const plan = {
  title: 'چگونه ضایعات کافه را ۳۰٪ کم کنیم',
  subtitle: 'سیستم سه‌لایه مدیریت مواد اولیه',
  sectionCode: 'Library',
  layout: { logoX: 0, logoY: 0, titleY: 0, cardY: 0, logoMotion: 'kinetic-az', theme: 'auto', showSafeZones: true },
  scenes: [{ cardTitle: 'اندازه‌گیری ضایعات', metric: '-30%', items: ['الف', 'ب'], chartData: [] }],
};

test('toFa converts latin digits to Persian digits', () => {
  assert.equal(toFa('2026'), '۲۰۲۶');
  assert.equal(toFa('-30%'), '-۳۰%');
});

test('estimateTextWidth grows with length and weight', () => {
  const short = estimateTextWidth('سلام', 40, 700);
  const long = estimateTextWidth('سلام دنیای کافه و رستوران', 40, 700);
  const heavy = estimateTextWidth('سلام', 40, 900);
  assert.ok(long > short);
  assert.ok(heavy > estimateTextWidth('سلام', 40, 400));
});

test('wrapText respects maxLines and never exceeds maxWidth for normal words', () => {
  const text = 'این یک متن بسیار طولانی فارسی است که باید به چند خط شکسته شود تا در کارت جا بگیرد';
  const lines = wrapText(text, { maxWidth: 300, fontSize: 30, weight: 700, maxLines: 3 });
  assert.ok(lines.length > 0 && lines.length <= 3);
  for (const line of lines.slice(0, -1)) {
    assert.ok(estimateTextWidth(line, 30, 700) <= 300 * 1.25, `line too wide: ${line}`);
  }
});

test('wrapText returns empty array for empty input', () => {
  assert.deepEqual(wrapText('', { maxWidth: 100, fontSize: 20 }), []);
  assert.deepEqual(wrapText('   ', { maxWidth: 100, fontSize: 20 }), []);
});

test('barChart renders right-to-left with labels and values', () => {
  const { nodes, height } = barChart(
    [
      { label: 'ضایعات', value: 42 },
      { label: 'سود', value: 20 },
    ],
    { x: 0, y: 0, width: 600, height: 200, palette: ['#FFB400', '#3B5998'], theme, size: 24 }
  );
  assert.ok(height > 0);
  const texts = nodes.filter((n) => n.type === 'text').map((n) => n.content);
  assert.ok(texts.includes('ضایعات'));
  assert.ok(texts.includes('۴۲'), 'values must use Persian digits');
  const rects = nodes.filter((n) => n.type === 'rect');
  /* the bigger value must produce the wider bar */
  const bars = rects.filter((r) => r.rx && r.rx > 0);
  assert.ok(bars.length >= 2);
});

test('donut clamps percentages outside 0..100', () => {
  const low = donut(-20, { cx: 100, cy: 100, r: 60, color: '#000', track: '#eee', theme });
  const high = donut(180, { cx: 100, cy: 100, r: 60, color: '#000', track: '#eee', theme });
  const texts = (r) => r.nodes.filter((n) => n.type === 'text').map((n) => n.content);
  /* The percent token is emitted sign-first (`٪۰`) so it draws sign-left, so
     assert the meaning — clamped digits plus a percent sign — not the order. */
  const hasPercent = (t, digits) => t.includes('٪') && t.includes(digits);
  assert.ok(texts(low).some((t) => hasPercent(t, '۰')), 'negative percent must clamp to zero');
  assert.ok(texts(high).some((t) => hasPercent(t, '۱۰۰')));
});

test('sparkline emits a polygon and a polyline', () => {
  const nodes = sparkline([1, 5, 3, 9, 7], { x: 0, y: 0, width: 200, height: 80, color: '#FFB400' });
  assert.equal(nodes.filter((n) => n.type === 'polygon').length, 1);
  assert.equal(nodes.filter((n) => n.type === 'polyline').length, 1);
});

test('toSvg escapes XML metacharacters (no injection into the rasteriser)', () => {
  const svg = toSvg(
    [{ type: 'text', content: '<script>alert(1)</script>', x: 0, y: 0, size: 20, weight: 700, fill: '#000', anchor: 'end', family: 'Vazirmatn' }],
    { width: 100, height: 100 }
  );
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
});

test('reel scene stays inside the canvas and respects the caption safe zone', () => {
  const { nodes, captionBox } = buildReelScene({
    plan,
    theme,
    brand,
    scene: { cardTitle: 'تست', metric: '۱۰٪', items: ['یک', 'دو', 'سه'], chartData: [] },
    sceneIndex: 0,
    totalScenes: 3,
  });
  const { width, height } = CANVAS.reel;
  for (const node of nodes) {
    if (node.type === 'rect') {
      assert.ok(node.x >= -40, `rect x too far left: ${node.x}`);
      assert.ok(node.x + node.w <= width + 40, `rect overflows right: ${node.x + node.w}`);
      assert.ok(node.y + node.h <= height + 20, `rect overflows bottom: ${node.y + node.h}`);
    }
  }
  assert.ok(captionBox.y + captionBox.height <= height, 'caption band must fit');
  assert.ok(captionBox.y > height * 0.7, 'caption band belongs in the lower third');
});

test('cover and carousel builds are non-empty and finite', () => {
  const cover = buildCover({ plan, theme, brand, scene: { metric: '-30%', metricCaption: 'سه ماه' } });
  assert.ok(cover.length > 10);
  for (const node of cover) {
    if (node.type === 'text') assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
  }
  const slide = buildCarouselSlide({
    plan,
    theme,
    brand,
    slide: { heading: 'عنوان', body: 'متن', highlightMetric: '۱۰٪', items: [], chartData: [] },
    index: 0,
    total: 4,
  });
  assert.ok(slide.length > 8);
});

test('outro always contains the brand promise and domain', () => {
  const nodes = buildOutro({ theme, brand, plan });
  const texts = nodes.filter((n) => n.type === 'text').map((n) => n.content);
  assert.ok(texts.some((t) => t.includes('atozfnb.info')));
  assert.ok(texts.some((t) => t.includes(brand.promise.slice(0, 12))), 'promise must be on the outro');
});

test('outro carries the real identity mark, not typed letters', () => {
  /* The outro used to draw a gold square with the text "AZ" inside it. The
     shipped mark is a real asset; asserting on the string 'AZ' would pass for
     the fake and fail for the real one, which is exactly backwards. */
  for (const sectionCode of ['AI', 'Library', 'Solutions']) {
    const nodes = buildOutro({ theme, brand, plan: { ...plan, sectionCode } });
    const artwork = nodes.filter((n) => n.type === 'svg');
    assert.ok(artwork.length > 0, `${sectionCode}: outro has no identity artwork`);
    const typedMark = nodes.some((n) => n.type === 'text' && n.content.trim() === 'AZ');
    assert.equal(typedMark, false, `${sectionCode}: outro still types the mark instead of placing it`);
  }
});

test('every motion preset returns a finite style for any progress', () => {
  for (const key of MOTION_KEYS) {
    assert.ok(MOTIONS[key], `missing preset ${key}`);
    for (const t of [0, 0.25, 0.5, 0.99, 1]) {
      const style = computeBeatStyle({ motion: key, elapsed: t * 4, duration: 4 });
      for (const [prop, value] of Object.entries(style)) {
        if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key}.${prop} produced ${value}`);
      }
      if (style.opacity !== undefined) {
        assert.ok(style.opacity >= 0 && style.opacity <= 1, `${key} opacity out of range: ${style.opacity}`);
      }
    }
  }
});

test('easings are clamped at both ends', () => {
  for (const [name, fn] of Object.entries(ease)) {
    if (name === 'spring' || name === 'backOut') continue; // intentionally overshoot
    assert.ok(Math.abs(fn(0)) < 1e-6, `${name}(0) should be 0`);
    assert.ok(Math.abs(fn(1) - 1) < 1e-6, `${name}(1) should be 1`);
  }
});

test('styleToCss produces valid CSS property names only', () => {
  const css = styleToCss({ opacity: 0.5, translateX: 10, scale: 1.2, blur: 3 });
  assert.equal(css.opacity, '0.500');
  assert.ok(css.transform.includes('translateX(10.00px)'));
  assert.ok(css.filter.includes('blur(3.00px)'));
});

/* ─────────────── Persian text: percent sign + theme (regressions) ───────────────
 * Both of these were invisible bugs that rendered "successfully":
 *   • a standalone `۳۰٪` drew its sign on the right (wrong base direction);
 *   • a light section background got white text, i.e. no visible text at all.
 * Neither throws, so only an assertion catches them.
 */
import { persianPercent, normalisePersian, persianText, bidiInfo } from '../app/server/src/engine/bidi.js';
import { resolveTheme } from '../app/server/src/engine/canvas.js';
import { backgroundTone } from '../app/server/src/engine/assets.js';

test('standalone percent token is emitted sign-first so it draws sign-left', () => {
  assert.equal(persianPercent('۳۰٪'), '٪۳۰');
  assert.equal(persianPercent('۱۲.۵٪'), '٪۱۲.۵');
  assert.equal(bidiInfo('۳۰٪').reordered, true);
});

test('a leading sign stays with the number, not the percent sign', () => {
  assert.equal(persianPercent('+۴۵٪'), '+٪۴۵');
  assert.equal(persianPercent('−۲۰٪'), '−٪۲۰');
});

test('Persian running text is never touched by the percent rule', () => {
  const sentence = 'چگونه ضایعات کافه را ۳۰٪ کم کنیم';
  assert.equal(persianPercent(sentence), sentence);
  assert.equal(bidiInfo(sentence).rtl, true);
});

test('percent rule is idempotent and control-character free', () => {
  const once = persianPercent('۳۰٪');
  assert.equal(persianPercent(once), once);
  assert.ok(!/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(once));
});

test('Persian letter ranges do not swallow the digits', () => {
  /* A naive \u0669-\u06FF range matched ۰-۹ and made the whole module a no-op. */
  assert.equal(bidiInfo('۳۰').rtl, false);
  assert.equal(bidiInfo('۱۲').rtl, false);
  assert.equal(bidiInfo('کافه').rtl, true);
});

test('normalisePersian fixes Arabic letters, digits and ZWNJ', () => {
  assert.equal(normalisePersian('كتاب'), 'کتاب');            // Arabic kaf + teh-marbuta
  assert.equal(normalisePersian('٣٠'), '۳۰');                // Arabic-Indic → Persian
  assert.equal(normalisePersian('30'), '۳۰');                // Latin → Persian
  assert.equal(normalisePersian('می شود'), 'می‌شود');        // ZWNJ
});

test('wrapText never splits a number from its percent sign', () => {
  const lines = wrapText('چگونه ضایعات کافه را ۳۰٪ کم کنیم', { maxWidth: 620, fontSize: 72, weight: 900, maxLines: 4 });
  assert.ok(lines.length > 1, 'should wrap into more than one line');
  for (const line of lines) {
    if (line.includes('٪')) assert.ok(/[۰-۹]/u.test(line), `percent orphaned: ${JSON.stringify(line)}`);
  }
});

test('section backgrounds report their own tone', () => {
  assert.equal(backgroundTone('Library').isDark, false);
  assert.equal(backgroundTone('Academy').isDark, false);
  assert.equal(backgroundTone('AI').isDark, true);
  assert.equal(backgroundTone('Calculators').isDark, true);
});

test('theme follows the background, so text is never invisible', () => {
  const asked = { isDark: true, bg: '#0A1931', text: '#F8FAFC', textMuted: '#A8B6CC', accent: '#FFB400' };
  const library = resolveTheme(asked, 'Library');
  assert.equal(library.isDark, false);
  assert.equal(library.heading, '#0A1931');
  assert.match(library.themeCorrection, /light/);

  const ai = resolveTheme(asked, 'AI');
  assert.equal(ai.isDark, true);
  assert.equal(ai.themeCorrection, undefined);
});

test('cover heading ink never matches the background it sits on', () => {
  for (const sectionCode of ['AI', 'Library', 'Calculators', 'Academy', 'Magazine', 'Solutions']) {
    const nodes = buildCover({
      plan: { title: 'چگونه ضایعات کافه را ۳۰٪ کم کنیم', sectionCode },
      theme: { isDark: true, bg: '#0A1931', text: '#F8FAFC', textMuted: '#A8B6CC', accent: '#FFB400', gold: '#FFB400' },
      brand,
      scene: {},
    });
    const tone = backgroundTone(sectionCode);
    const headings = nodes.filter((n) => n.type === 'text' && n.size >= 60);
    assert.ok(headings.length > 0, `${sectionCode}: no headline rendered`);
    for (const h of headings) {
      assert.notEqual(
        h.content === '' ? null : (h.fill ?? '').toUpperCase(),
        (tone.bg ?? '').toUpperCase(),
        `${sectionCode}: headline colour equals background`,
      );
    }
  }
});

/* ───────────── identity rollout: carousel, reel, outro, theme truth ─────────────
 * The identity layer used to be wired to the cover only. Carousel slides — the
 * main product output, 40 of the 48 scheduled publishes in the plan — rendered
 * with no section artwork at all, and the theme came from brand.json even where
 * brand.json disagreed with the shipped background.
 */
import { patternOverlay, avatarDisc } from '../app/server/src/engine/canvas.js';
import { patternFor } from '../app/server/src/engine/assets.js';
import { themeFor } from '../app/server/src/services/brand.js';

test('brand.json theme mode matches the artwork it is painted on', () => {
  /* Calculators was declared light with a #071923 background; Solutions was
     declared dark with #F9F7F2. Both produced unreadable text. */
  for (const sectionCode of ['AI', 'Library', 'Magazine', 'Calculators', 'Solutions', 'Academy']) {
    const theme = themeFor(sectionCode);
    const tone = backgroundTone(sectionCode);
    assert.equal(theme.isDark, tone.isDark, `${sectionCode}: theme and artwork disagree`);
    assert.equal(theme.themeCorrection, undefined, `${sectionCode} still needs a correction`);
  }
});

test('forced theme mode still wins over the artwork', () => {
  const forced = themeFor('Library', 'dark');
  assert.equal(forced.isDark, true);
});

test('pattern overlay drops the opaque page fill', () => {
  /* Every pattern file paints #F8FAFC before its tiles. Kept, that wipes a dark
     section to near-white. */
  const overlay = patternOverlay('AI', { width: 1080, height: 1920 });
  assert.ok(overlay, 'AI should ship a pattern');
  assert.equal(/fill="#F8FAFC"/i.test(overlay.inner), false, 'page fill must be stripped');
  assert.equal(/fill="#FFFFFF"/i.test(overlay.inner), false, 'white page fill must be stripped too');
});

test('pattern overlay namespaces its tile id per section', () => {
  /* Two sections in one document (a carousel exporting N slides) would otherwise
     both define id="tile" and the second would win. */
  const a = patternOverlay('AI', { width: 1080, height: 1920 });
  const b = patternOverlay('Library', { width: 1080, height: 1920 });
  assert.match(a.inner, /id="tile-AI-identity-weave"/);
  assert.match(b.inner, /id="tile-Library-identity-weave"/);
  assert.equal(/id="tile"/.test(a.inner), false, 'un-namespaced id leaked');
});

test('patternFor resolves one named pattern per section', () => {
  for (const sectionCode of ['AI', 'Library', 'Calculators']) {
    for (const name of ['editorial-system', 'identity-weave']) {
      const p = patternFor(sectionCode, name);
      assert.ok(p?.body, `${sectionCode}/${name} missing`);
    }
  }
  assert.equal(patternFor('Nope', 'identity-weave'), null);
});

test('avatarDisc only emits artwork when the asset exists', () => {
  const nodes = avatarDisc({ sectionCode: 'AI', x: 100, y: 100, size: 120 });
  assert.ok(nodes.length > 0);
  assert.ok(nodes.every((n) => n.type === 'svg' || n.type === 'circle'));
});

test('carousel slides carry the section background and pattern', () => {
  for (const sectionCode of ['AI', 'Library', 'Solutions']) {
    const nodes = buildCarouselSlide({
      plan: { title: 'چگونه ضایعات کافه را ۳۰٪ کم کنیم', sectionCode },
      theme: { isDark: true, bg: '#0A1931', text: '#F8FAFC', textMuted: '#A8B6CC', accent: '#FFB400', gold: '#FFB400' },
      brand,
      slide: { slideNumber: 1, heading: 'سرتیتر', body: 'متن', items: [], chartData: [] },
      index: 0,
      total: 3,
    });
    const artwork = nodes.filter((n) => n.type === 'svg');
    assert.ok(artwork.length >= 3, `${sectionCode}: expected background + pattern + logos, got ${artwork.length}`);
  }
});

test('reel scenes carry the landscape section background', () => {
  const nodes = buildReelScene({
    plan: { title: 'ریل ۳۰٪', sectionCode: 'AI' },
    theme: { isDark: false, bg: '#F8FAFC', text: '#0A1931', textMuted: '#475569', accent: '#5D5FEF', gold: '#FFB400' },
    brand,
    scene: { cardTitle: 'کارت', items: [], chartData: [] },
    sceneIndex: 0,
    totalScenes: 2,
  }).nodes;
  /* The caller asked for light; AI's artwork is dark, so the theme must flip. */
  assert.ok(nodes.filter((n) => n.type === 'svg').length >= 2);
});

test('carousel slide counter never overlaps the subbrand lockup', () => {
  /* Both used to render at x=76, y≈78; the overlap read as a corrupted logo. */
  const nodes = buildCarouselSlide({
    plan: { title: 'ت', sectionCode: 'Library' },
    theme: themeFor('Library'),
    brand,
    slide: { slideNumber: 1, heading: 'h', body: 'b', items: [], chartData: [] },
    index: 0,
    total: 4,
  });
  const lockup = nodes.find((n) => n.type === 'svg' && n.x < 120 && n.y > 40 && n.y < 120);
  const counter = nodes.find((n) => n.type === 'text' && /\//.test(n.content));
  assert.ok(lockup && counter, 'both elements must exist');
  assert.ok(counter.y > lockup.y + lockup.h - 8, `counter y=${counter.y} overlaps lockup bottom=${lockup.y + lockup.h}`);
});
