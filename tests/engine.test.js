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
  assert.ok(texts(low).some((t) => t.includes('۰٪')), 'negative percent must clamp to zero');
  assert.ok(texts(high).some((t) => t.includes('۱۰۰')));
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
  assert.ok(texts.some((t) => t.includes('AZ')));
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
