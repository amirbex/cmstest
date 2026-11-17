/**
 * Canvas builder — the offline graphics engine.
 *
 * Takes a CreativePlan + brand tokens and emits resolution-independent
 * primitives (rect / text / polygon / polyline / circle) that can be:
 *   • serialised to SVG + rasterised with resvg (~5 ms), used by tests & previews
 *   • rasterised one frame at a time and piped into ffmpeg for MP4/WebM
 *
 * This is deliberately layout-only: no animation timing lives here, so the
 * still renderer and the video renderer share exactly one source of truth.
 * Text shaping (Persian RTL, ZWNJ, ligatures) is handled by the rasteriser,
 * which is why every text node carries direction + anchor + family.
 */

import { parentLogo, subbrandLockup, socialIcon, backgroundFor, backgroundTone } from './assets.js';
import { persianText, protectNumericClusters } from './bidi.js';

export const CANVAS = {
  reel: { width: 1080, height: 1920 },
  carousel: { width: 1080, height: 1350 },
  cover: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
};

const SAFE = { top: 108, bottom: 420, side: 72, right: 260 };

/* ────────────────────────── helpers ────────────────────────── */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/* ────────────────────────── real brand assets ────────────────────────── */

/**
 * An inline SVG asset placed in a box.
 *
 * resvg does not fetch external references, so the asset's own SVG body is
 * nested inside a group that scales its viewBox into the target rectangle. That
 * keeps the mark perfectly crisp at any size (a reel title card and an 80 px
 * corner logo use the same file) instead of blurring a raster copy.
 */
export function svgAsset(asset, { x, y, width, height = null, opacity = 1, align = 'start', color = null }) {
  if (!asset?.body) return null;
  const ratio = asset.ratio || 1;
  const w = width;
  const h = height ?? width / ratio;
  const offsetX = align === 'end' ? x - w : align === 'center' ? x - w / 2 : x;

  /* the asset may carry its own width/height; the transform overrides them */
  const [vx, vy, vw, vh] = asset.viewBox;
  const scaleX = w / vw;
  const scaleY = h / vh;

  return {
    type: 'svg',
    x: offsetX,
    y,
    w,
    h,
    opacity,
    /* recolour monochrome variants by swapping fills is handled at read time;
       here we keep the original artwork intact */
    color,
    inner: asset.body,
    transform: `translate(${offsetX} ${y}) scale(${scaleX.toFixed(5)} ${scaleY.toFixed(5)}) translate(${-vx} ${-vy})`,
  };
}

/**
 * Reconcile a caller's theme with the section background that will actually be
 * painted underneath it.
 *
 * Design-system rule: the artwork wins. If the background is light, text goes
 * navy; if it is dark, text goes white. A caller that asks for `isDark: true` on
 * a light section gets a corrected theme plus a `themeCorrection` note rather
 * than a silently invisible cover — the note is what lets the content pipeline
 * flag a mismatched brief instead of shipping a blank-looking card.
 */
const NAVY = '#0A1931';

export function resolveTheme(theme, sectionCode) {
  const tone = sectionCode ? backgroundTone(sectionCode, 'portrait') : null;
  if (!tone) return theme;

  const wantText = tone.isDark ? '#F8FAFC' : NAVY;
  const wantMuted = tone.isDark ? '#A8B6CC' : '#475569';

  const corrected = {
    ...theme,
    isDark: tone.isDark,
    bg: tone.bg ?? theme.bg,
    text: wantText,
    textMuted: wantMuted,
    /* Headlines get their own token so a light cover can use navy while a
       muted secondary stays grey rather than washing out. */
    heading: tone.isDark ? '#FFFFFF' : NAVY,
  };
  if (theme.isDark !== tone.isDark) {
    corrected.themeCorrection = `section background ${tone.bg} is ${tone.isDark ? 'dark' : 'light'}; theme isDark was ${theme.isDark}`;
  }
  return corrected;
}

/**
 * Place the real parent mark. Falls back to the brand wordmark as text when the
 * identity package is absent, so the renderer still produces something on a
 * bare checkout — but it says so in the caller's own voice, not with a
 * look-alike drawing.
 */
export function brandMark({ theme, brand, x, y, height = 64, align = 'end', variant = null }) {
  const wantVariant = variant ?? (theme.isDark ? 'white' : 'color');
  const logo = parentLogo({ variant: wantVariant, layout: 'horizontal' });
  if (logo?.kind === 'svg') {
    const width = height * (logo.ratio || 4);
    return [svgAsset(logo, { x, y, width, height, align })];
  }
  /* honest fallback: the wordmark as type, never an invented monogram */
  return [
    text(brand.brandName, x, y + height * 0.8, {
      size: height * 0.62,
      weight: 900,
      fill: theme.text,
      anchor: align === 'end' ? 'end' : align === 'center' ? 'middle' : 'start',
      family: 'Montserrat',
    }),
  ];
}

/** Place the subbrand lockup (AZ mark + subbrand wordmark on one baseline). */
export function sectionLockup({ theme, sectionCode, x, y, height = 56, align = 'start' }) {
  const lockup = subbrandLockup(sectionCode, { variant: theme.isDark ? 'white' : 'full' });
  if (!lockup?.body) return null;
  const width = height * (lockup.ratio || 3);
  return svgAsset(lockup, { x, y, width, height, align });
}

/**
 * A social-action row: the identity package's own icons, with Persian labels.
 * This is what makes a CTA banner look like the brand instead of like an app.
 */
export function actionRow({ theme, platform, actions, x, y, size = 44, gap = 22, labels = null, color = null }) {
  const nodes = [];
  let cursor = x;
  for (const [i, action] of actions.entries()) {
    const icon = socialIcon(platform, action, { tone: 'accent' });
    if (!icon?.body) continue;

    nodes.push(svgAsset(icon, { x: cursor, y, width: size, height: size, opacity: 0.95 }));

    const label = labels?.[i];
    if (label) {
      /* Persian label sits immediately after its icon and is measured, not
         guessed, so the row never overflows its box. */
      const labelSize = Math.round(size * 0.42);
      const labelWidth = Math.min(120, estimateTextWidth(label, labelSize, 700));
      nodes.push(
        text(label, cursor + size + 14, y + size * 0.68, {
          size: labelSize,
          weight: 700,
          fill: color ?? theme.textMuted,
          anchor: 'start',
        })
      );
      cursor += size + 14 + labelWidth + gap;
    } else {
      cursor += size + gap;
    }
  }
  return { nodes, width: cursor - x - gap };
}

/** Persian digits, used for metrics and slide counters. */
export function toFa(value) {
  return String(value ?? '').replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

/**
 * Width estimate for mixed Persian/Latin text, used for wrapping and for sizing
 * pills and badges.
 *
 * Why a table and not a per-character average: Persian is a *connected* script,
 * so a naive sum over characters over-counts badly ("می" is narrower than m + y
 * drawn separately) while Latin at bold weights under-counts. The previous
 * constants under-counted by 35% on a real CTA label, which pushed the text
 * outside its own pill — visible in every rendered cover.
 *
 * These weights are calibrated against Vazirmatn Bold and Montserrat Bold at
 * cap height, which is what the identity package specifies.
 */
export function estimateTextWidth(text, fontSize, weight = 700) {
  const chars = [...String(text)];
  let em = 0;
  for (const ch of chars) {
    if (ch === '\u200c') {
      em += 0.06; // ZWNJ: joins two words, adds almost nothing
    } else if (/[\u0600-\u06FF]/.test(ch)) {
      em += 0.66; // connected Arabic-script letter at medium connector width
    } else if (/[A-Z]/.test(ch)) {
      em += 0.68;
    } else if (/[a-z]/.test(ch)) {
      em += 0.55;
    } else if (/[0-9]/.test(ch)) {
      em += 0.6;
    } else if (ch === ' ') {
      em += 0.3;
    } else if (/[.,:;'!|]/.test(ch)) {
      em += 0.26;
    } else {
      em += 0.5;
    }
  }
  /* bold faces are wider, and Persian bold is notably wider than Persian regular */
  const weightFactor = weight >= 900 ? 1.1 : weight >= 800 ? 1.06 : weight >= 700 ? 1.03 : 1;
  return em * fontSize * weightFactor;
}

/** True when the estimate is trustworthy enough to size a container from. */
export function fitsIn(text, fontSize, maxWidth, weight = 700) {
  return estimateTextWidth(text, fontSize, weight) <= maxWidth;
}

/** Greedy word wrap driven by `estimateTextWidth`. Returns at most maxLines. */
export function wrapText(text, { maxWidth, fontSize, weight = 700, maxLines = 4 }) {
  /* Protect "۳۰٪", "۱۲.۵٪", "۳×" and friends from being split across a line
     break. The NBSP is a normal-width space, so nothing moves visually — it
     only removes the break opportunity. */
  const words = protectNumericClusters(String(text ?? '')).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (estimateTextWidth(candidate, fontSize, weight) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length === maxLines && current && !lines.includes(current)) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = `${last}…`;
  }
  return lines.slice(0, maxLines);
}

/* ────────────────────────── primitives ────────────────────────── */

export const rect = (x, y, w, h, fill, extra = {}) => ({ type: 'rect', x, y, w, h, fill, ...extra });

export const circle = (cx, cy, r, fill, extra = {}) => ({ type: 'circle', cx, cy, r, fill, ...extra });

export const polygon = (points, fill, extra = {}) => ({ type: 'polygon', points, fill, ...extra });

export const polyline = (points, stroke, extra = {}) => ({ type: 'polyline', points, stroke, ...extra });

export function text(content, x, y, opts = {}) {
  /* Every visible string funnels through here, so this is where the Persian
     treatment belongs: normalisation (digits, ZWNJ) plus the percent-sign rule
     that keeps a standalone `۳۰٪` from drawing its sign on the right.
     See engine/bidi.js for the measurements behind it. */
  const content_ = persianText(String(content ?? ''));
  return {
    type: 'text',
    content: content_,
    x,
    y,
    size: opts.size ?? 32,
    weight: opts.weight ?? 700,
    fill: opts.fill ?? '#0A1931',
    anchor: opts.anchor ?? 'end', // Persian content defaults to right-aligned
    opacity: opts.opacity ?? 1,
    family: opts.family ?? 'Vazirmatn',
    lineHeight: opts.lineHeight ?? 1.55,
    letterSpacing: opts.letterSpacing ?? 0,
    ...opts,
    content: content_,
    x,
    y,
  };
}

/** Right-aligned paragraph block; returns { nodes, height }. */
export function paragraph(content, { x, y, maxWidth, size = 30, weight = 600, fill, lineHeight = 1.62, maxLines = 5, anchor = 'end', opacity = 1 }) {
  const lines = wrapText(content, { maxWidth, fontSize: size, weight, maxLines });
  const nodes = lines.map((line, i) =>
    text(line, x, y + i * size * lineHeight, { size, weight, fill, anchor, opacity, lineHeight })
  );
  return { nodes, height: lines.length * size * lineHeight, lines };
}

/** Centered pill/badge. Returns { nodes, width }. */
export function badge(label, { x, y, size = 22, fill, color, paddingX = 22, height = 44, anchor = 'end' }) {
  const width = estimateTextWidth(label, size, 800) + paddingX * 2 + 10;
  const left = anchor === 'end' ? x - width : anchor === 'center' ? x - width / 2 : x;
  return {
    width,
    nodes: [
      rect(left, y, width, height, fill, { rx: height / 2 }),
      text(label, left + width / 2, y + height / 2 + size * 0.36, {
        size,
        weight: 800,
        fill: color,
        anchor: 'middle',
      }),
    ],
  };
}

/* ────────────────────────── charts ────────────────────────── */

/**
 * Horizontal bar chart, RTL-aware: labels hug the right edge and bars grow
 * right→left so the reading direction matches the Persian text around them.
 */
export function barChart(data, { x, y, width, height, palette, theme, size = 24 }) {
  const nodes = [];
  if (!data?.length) return { nodes, height: 0 };
  const max = Math.max(...data.map((d) => Number(d.value) || 0), 1);
  const rowH = Math.min(76, height / data.length);
  const labelW = Math.min(width * 0.36, Math.max(...data.map((d) => estimateTextWidth(d.label, size, 700))) + 26);
  const gutter = 76;
  const barZoneRight = x + width - labelW;
  const barMax = Math.max(60, width - labelW - gutter);
  data.forEach((d, i) => {
    const cy = y + i * rowH;
    const value = Number(d.value) || 0;
    const barW = Math.max(10, (value / max) * barMax);
    const color = d.color ?? palette[i % palette.length];
    const barY = cy + rowH * 0.24;
    const barH = rowH * 0.44;
    nodes.push(text(d.label, x + width, cy + rowH * 0.6, { size, weight: 700, fill: theme.text, anchor: 'end' }));
    nodes.push(
      rect(barZoneRight - barMax, barY, barMax, barH, theme.isDark ? 'rgba(255,255,255,0.09)' : 'rgba(10,25,49,0.06)', { rx: barH / 2 })
    );
    nodes.push(rect(barZoneRight - barW, barY, barW, barH, color, { rx: barH / 2 }));
    nodes.push(
      text(toFa(value), x + gutter * 0.42, cy + rowH * 0.6, {
        size: size * 0.94,
        weight: 900,
        fill: color,
        anchor: 'middle',
      })
    );
  });
  return { nodes, height: data.length * rowH };
}

/** Donut / progress ring used for single-KPI scenes. */
export function donut(percent, { cx, cy, r, thickness = 26, color, track, label, theme }) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const circumference = 2 * Math.PI * r;
  const nodes = [
    circle(cx, cy, r, 'none', { stroke: track, strokeWidth: thickness }),
    circle(cx, cy, r, 'none', {
      stroke: color,
      strokeWidth: thickness,
      strokeDasharray: `${(clamped / 100) * circumference} ${circumference}`,
      strokeDashoffset: 0,
      transform: `rotate(-90 ${cx} ${cy})`,
      strokeLinecap: 'round',
    }),
    text(`${toFa(clamped)}٪`, cx, cy + r * 0.16, { size: r * 0.62, weight: 900, fill: theme.text, anchor: 'middle' }),
  ];
  if (label) {
    nodes.push(text(label, cx, cy + r + 52, { size: 26, weight: 700, fill: theme.textMuted, anchor: 'middle' }));
  }
  return { nodes };
}

/** Upward-trend sparkline for "growth" beats. */
export function sparkline(values, { x, y, width, height, color, fill }) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const px = x + (i / Math.max(1, values.length - 1)) * width;
    const py = y + height - ((v - min) / span) * height;
    return [Math.round(px * 100) / 100, Math.round(py * 100) / 100];
  });
  const area = [[x, y + height], ...pts, [x + width, y + height]];
  return [
    polygon(area, fill ?? 'rgba(255,180,0,0.16)'),
    polyline(pts, color, { strokeWidth: 5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  ];
}

/* ────────────────────────── composition frames ────────────────────────── */

const GRID_OVERLAY = (theme, w, h) => {
  const nodes = [];
  const step = 90;
  const stroke = theme.isDark ? 'rgba(255,255,255,0.035)' : 'rgba(10,25,49,0.035)';
  for (let x = step; x < w; x += step) nodes.push(rect(x, 0, 1, h, stroke));
  for (let y = step; y < h; y += step) nodes.push(rect(0, y, w, 1, stroke));
  return nodes;
};

function header(theme, brand, sectionCode, width, safe) {
  const nodes = [];
  nodes.push(rect(0, 0, width, 8, theme.accent));

  /* Right edge: the real AZ monogram + wordmark from the identity package.
     Falls back to the wordmark as type only if the package is missing. */
  nodes.push(...brandMark({ theme, brand, x: width - safe.side, y: 52, height: 58 }));

  /* Left edge: the subbrand lockup, which is what actually tells a viewer they
     are looking at Library rather than AI. */
  const lockup = sectionLockup({ theme, sectionCode, x: safe.side, y: 54, height: 52, align: 'start' });
  if (lockup) {
    nodes.push(lockup);
  } else {
    const b = badge(theme.subbrandName, {
      x: safe.side + 22,
      y: 52,
      size: 20,
      fill: theme.accent,
      color: theme.onAccent,
      height: 40,
      anchor: 'start',
    });
    nodes.push(...b.nodes);
  }
  return nodes;
}

function footer(theme, brand, width, height, safe, url = true) {
  const nodes = [];
  if (url) {
    /* the wordmark footer uses the real wordmark file when present: it carries
       the gold dot and the AtoZ/latin lockup the text version cannot */
    const wordmark = parentLogo({ variant: theme.isDark ? 'white' : 'color', layout: 'wordmark' });
    if (wordmark?.body) {
      const h = 30;
      nodes.push(svgAsset(wordmark, { x: safe.side, y: height - 74, width: h * (wordmark.ratio || 5), height: h, align: 'start' }));
    } else {
      nodes.push(
        text(brand.domain, safe.side, height - 46, {
          size: 24,
          weight: 800,
          fill: theme.textMuted,
          anchor: 'start',
        })
      );
    }
  }
  nodes.push(
    text(brand.handle, width - safe.side, height - 46, {
      size: 22,
      weight: 700,
      fill: theme.textMuted,
      anchor: 'end',
    })
  );
  return nodes;
}

/**
 * Build the scene for a reel at a given local scene index.
 *
 * Layout is a bottom-anchored flex column: the caption band owns the
 * Instagram-safe zone, the bullet stack and hero card grow upward from it, and
 * remaining space is distributed as gaps so every frame fills 1920 px without
 * ever bleeding under the reels UI.
 */
export function buildReelScene({ plan, theme, brand, scene, sceneIndex, totalScenes }) {
  const { width, height } = CANVAS.reel;
  const layout = plan.layout ?? {};
  const LEFT = SAFE.side;
  const RIGHT = width - SAFE.side;
  const contentW = RIGHT - LEFT;
  const nodes = [];

  nodes.push(rect(0, 0, width, height, theme.bg));
  if (theme.isDark) {
    nodes.push(...GRID_OVERLAY(theme, width, height));
    nodes.push(circle(width * 0.94, height * 0.1, 460, 'rgba(255,180,0,0.055)'));
    nodes.push(circle(width * 0.02, height * 0.72, 340, `${theme.accent}1A`));
  } else {
    nodes.push(circle(width * 0.98, height * 0.06, 400, `${theme.accent}12`));
    nodes.push(circle(-70, height * 0.6, 300, 'rgba(255,180,0,0.14)'));
  }

  nodes.push(...header(theme, brand, plan.sectionCode, width, { side: LEFT }));

  /* ── progress rail ── */
  const railY = 118;
  nodes.push(rect(LEFT, railY, contentW, 7, theme.isDark ? 'rgba(255,255,255,0.13)' : 'rgba(10,25,49,0.10)', { rx: 3.5 }));
  nodes.push(rect(LEFT, railY, (contentW * (sceneIndex + 1)) / Math.max(1, totalScenes), 7, theme.gold, { rx: 3.5 }));

  /* ── vertical budget ── */
  const TOP = 168 + (layout.titleY ?? 0);
  const CAPTION_H = 96;
  const CAPTION_Y = height - SAFE.bottom + 22;
  const BOTTOM = CAPTION_Y - 34; // content may not go below this
  const items = (scene.items ?? []).slice(0, 3);
  const hasChart = (scene.chartData ?? []).length > 0;
  const bulletH = 88;
  const bulletGap = 14;
  const itemsH = items.length ? items.length * bulletH + (items.length - 1) * bulletGap : 0;

  /* ── title block ── */
  const titleLines = wrapText(plan.title, { maxWidth: contentW - 52, fontSize: 48, weight: 900, maxLines: 2 });
  const titleH = titleLines.length * 48 * 1.42 + 40;

  /* Optical centering: the [title · card · bullets] group is centred inside the
     free zone and internal gaps breathe with the available height. This keeps
     sparse beats balanced and dense beats inside the safe area. */
  const cardNatural = hasChart ? 372 : 186;
  const GAP = 30;
  const groupH = titleH + GAP + cardNatural + (itemsH ? GAP + itemsH : 0);
  const freeZone = BOTTOM - TOP;
  const extraGap = Math.max(0, Math.min(54, (freeZone - groupH) / (items.length ? 3 : 2) - GAP));
  const gap = GAP + extraGap;
  const groupTop = TOP + Math.max(0, (freeZone - groupH - extraGap * (items.length ? 2 : 1)) / 2);
  const cardH = cardNatural;
  nodes.push(rect(LEFT, groupTop, contentW, titleH, theme.isDark ? 'rgba(255,255,255,0.06)' : '#EAF2FE', { rx: 24 }));
  titleLines.forEach((line, i) =>
    nodes.push(
      text(line, RIGHT - 26, groupTop + 38 + i * 48 * 1.42, {
        size: 48,
        weight: 900,
        fill: theme.isDark ? '#FFFFFF' : theme.navy,
        anchor: 'end',
      })
    )
  );

  /* ── hero card ── */
  const cardY = groupTop + titleH + gap + (layout.cardY ?? 0);
  nodes.push(rect(LEFT, cardY, contentW, cardH, theme.isDark ? '#101B33' : theme.navy, { rx: 28 }));

  if (hasChart) {
    const eyebrow = scene.eyebrow || `داده ${toFa(sceneIndex + 1)}`;
    const ebW = estimateTextWidth(eyebrow, 20, 800) + 58;
    nodes.push(rect(RIGHT - 30 - ebW, cardY + 28, ebW, 40, theme.gold, { rx: 20 }));
    nodes.push(
      text(eyebrow, RIGHT - 30 - ebW / 2, cardY + 55, { size: 20, weight: 800, fill: '#0A0A0C', anchor: 'middle' })
    );
    const metricW = scene.metric ? estimateTextWidth(scene.metric, 38, 900) + 34 : 0;
    if (scene.metric) {
      nodes.push(
        text(scene.metric, RIGHT - 30, cardY + 66, { size: 38, weight: 900, fill: theme.gold, anchor: 'end' })
      );
    }
    nodes.push(
      text(scene.cardTitle, RIGHT - 30 - metricW - ebW - 28, cardY + 62, {
        size: 30,
        weight: 900,
        fill: '#F8FAFC',
        anchor: 'end',
      })
    );
    const chartTop = cardY + 116;
    const chartBox = cardH - 146;
    const rows = scene.chartData.length;
    const rowH = Math.min(86, chartBox / rows);
    const usedH = rowH * rows;
    nodes.push(
      ...barChart(scene.chartData, {
        x: LEFT + 30,
        y: chartTop + Math.max(0, (chartBox - usedH) / 2),
        width: contentW - 60,
        height: chartBox,
        palette: [theme.gold, theme.accent, '#5D5FEF', '#0F766E'],
        theme: { ...theme, text: '#F8FAFC', isDark: true },
        size: 26,
      }).nodes
    );
    if (scene.metricCaption) {
      nodes.push(
        text(scene.metricCaption, LEFT + 30, cardY + cardH - 26, {
          size: 21,
          weight: 700,
          fill: 'rgba(248,250,252,0.55)',
          anchor: 'start',
        })
      );
    }
  } else {
    const eyebrow = scene.eyebrow || `گام ${toFa(sceneIndex + 1)}`;
    const ebW = estimateTextWidth(eyebrow, 21, 900) + 62;
    nodes.push(rect(RIGHT - 30 - ebW, cardY + 26, ebW, 42, theme.gold, { rx: 21 }));
    nodes.push(
      text(eyebrow, RIGHT - 30 - ebW / 2, cardY + 55, { size: 21, weight: 900, fill: '#0A0A0C', anchor: 'middle' })
    );
    nodes.push(
      text(scene.cardTitle, RIGHT - 30, cardY + 128, { size: 40, weight: 900, fill: '#F8FAFC', anchor: 'end' })
    );
    if (scene.metric) {
      const mw = estimateTextWidth(scene.metric, 46, 900) + 52;
      const moon = cardY + cardH - 24 - 66;
      nodes.push(rect(LEFT + 28, moon, mw, 66, 'rgba(255,255,255,0.08)', { rx: 18 }));
      nodes.push(
        text(scene.metric, LEFT + 28 + 26, moon + 47, { size: 46, weight: 900, fill: theme.gold, anchor: 'start' })
      );
      if (scene.metricCaption) {
        nodes.push(
          text(scene.metricCaption, LEFT + 28 + mw + 18, moon + 44, {
            size: 21,
            weight: 700,
            fill: 'rgba(248,250,252,0.62)',
            anchor: 'start',
          })
        );
      }
    }
  }

  /* ── bullets ── */
  let bulletY = cardY + cardH + gap;
  items.forEach((item, i) => {
    nodes.push(rect(LEFT, bulletY, contentW, bulletH, theme.isDark ? 'rgba(255,255,255,0.07)' : '#FFFFFF', { rx: 20 }));
    const chip = 48;
    nodes.push(rect(RIGHT - 24 - chip, bulletY + (bulletH - chip) / 2, chip, chip, i === 1 ? theme.gold : theme.accent, { rx: 14 }));
    nodes.push(
      text(toFa(i + 1), RIGHT - 24 - chip / 2, bulletY + bulletH / 2 + 8, {
        size: 22,
        weight: 900,
        fill: i === 1 ? '#0A0A0C' : theme.onAccent,
        anchor: 'middle',
      })
    );
    const lines = wrapText(item, { maxWidth: contentW - 108, fontSize: 28, weight: 700, maxLines: 2 });
    lines.forEach((line, li) =>
      nodes.push(
        text(line, RIGHT - 32 - chip, bulletY + bulletH / 2 + 9 - (lines.length - 1) * 17 + li * 34, {
          size: 28,
          weight: 700,
          fill: theme.text,
          anchor: 'end',
        })
      )
    );
    bulletY += bulletH + bulletGap;
  });

  /* ── karaoke caption band ── */
  nodes.push(rect(LEFT - 14, CAPTION_Y, contentW + 28, CAPTION_H, 'rgba(10,25,49,0.94)', { rx: 22 }));
  nodes.push(rect(LEFT - 14, CAPTION_Y, 6, CAPTION_H, theme.gold, { rx: 3 }));
  const capText = scene.narration || scene.cardTitle;
  let capSize = 31;
  while (capSize > 20 && estimateTextWidth(capText, capSize, 800) > contentW - 70) capSize -= 1;
  const capLines = wrapText(capText, { maxWidth: contentW - 70, fontSize: capSize, weight: 800, maxLines: 2 });
  capLines.forEach((line, i) =>
    nodes.push(
      text(line, RIGHT, CAPTION_Y + (capLines.length === 1 ? 60 : 40 + i * 38), {
        size: capSize,
        weight: 800,
        fill: '#FFFFFF',
        anchor: 'end',
      })
    )
  );

  nodes.push(...footer(theme, brand, width, height, SAFE));
  nodes.push(
    text(`${toFa(sceneIndex + 1)} / ${toFa(totalScenes)}`, width / 2, height - 46, {
      size: 20,
      weight: 800,
      fill: theme.textMuted,
      anchor: 'middle',
    })
  );

  return { nodes, captionBox: { x: LEFT, y: CAPTION_Y, width: contentW, height: CAPTION_H } };
}

function countWidth(value) {
  return estimateTextWidth(String(value), 54, 900);
}

/** Outro / logo-motion frame (HyperFrames-style end card). */
export function buildOutro({ theme, brand, plan }) {
  const { width, height } = CANVAS.reel;
  const nodes = [
    rect(0, 0, width, height, '#0A1931'),
    circle(width / 2, height / 2, 460, 'rgba(255,180,0,0.07)'),
    circle(width / 2, height / 2, 300, 'rgba(255,180,0,0.09)'),
  ];
  nodes.push(rect(width / 2 - 86, height / 2 - 330, 172, 172, '#FFB400', { rx: 46 }));
  nodes.push(text('AZ', width / 2, height / 2 - 216, { size: 76, weight: 900, fill: '#0A1931', anchor: 'middle' }));
  const promiseLines = wrapText(brand.promise, { maxWidth: width - 220, fontSize: 54, weight: 900, maxLines: 3 });
  promiseLines.forEach((l, i) =>
    nodes.push(text(l, width / 2, height / 2 - 60 + i * 78, { size: 54, weight: 900, fill: '#FFB400', anchor: 'middle' }))
  );
  nodes.push(rect(width / 2 - 210, height / 2 + 150, 420, 78, 'none', { rx: 39, stroke: '#FFB400', strokeWidth: 3 }));
  nodes.push(text(brand.domain, width / 2, height / 2 + 200, { size: 34, weight: 900, fill: '#FFFFFF', anchor: 'middle' }));
  nodes.push(
    text(plan?.title ?? brand.brandName, width / 2, height / 2 + 300, {
      size: 26,
      weight: 700,
      fill: 'rgba(248,250,252,0.6)',
      anchor: 'middle',
    })
  );
  return nodes;
}

/** Carousel slide (1080×1350). */
export function buildCarouselSlide({ plan, theme, brand, slide, index, total }) {
  const { width, height } = CANVAS.carousel;
  const nodes = [];
  nodes.push(rect(0, 0, width, height, theme.bg));
  if (theme.isDark) {
    nodes.push(...GRID_OVERLAY(theme, width, height));
    nodes.push(circle(width * 0.9, height * 0.1, 380, 'rgba(255,180,0,0.06)'));
  } else {
    nodes.push(circle(width * 0.96, 40, 300, `${theme.accent}14`));
    nodes.push(circle(-30, height * 0.7, 220, 'rgba(255,180,0,0.16)'));
  }
  nodes.push(...header(theme, brand, plan.sectionCode, width, { side: 76 }));

  const contentW = width - 152;
  const top = 200;
  nodes.push(text(`${toFa(index + 1)} / ${toFa(total)}`, 76, 78, { size: 28, weight: 900, fill: theme.text, anchor: 'start' }));

  const headingLines = wrapText(slide.heading, { maxWidth: contentW, fontSize: 62, weight: 900, maxLines: 4 });
  headingLines.forEach((line, i) =>
    nodes.push(text(line, width - 76, top + i * 82, { size: 62, weight: 900, fill: theme.isDark ? '#FFFFFF' : theme.navy, anchor: 'end' }))
  );
  let cursorY = top + headingLines.length * 82 + 30;

  if (slide.highlightMetric) {
    const b = badge(slide.highlightMetric, {
      x: width - 76,
      y: cursorY,
      size: 34,
      fill: theme.gold,
      color: '#0A0A0C',
      height: 76,
      paddingX: 30,
    });
    nodes.push(...b.nodes);
    cursorY += 110;
  }

  if (slide.chartData?.length) {
    const chart = barChart(slide.chartData, {
      x: 76,
      y: cursorY + 20,
      width: contentW,
      height: 320,
      palette: [theme.accent, theme.gold, '#5D5FEF', '#0F766E'],
      theme,
      size: 28,
    });
    nodes.push(...chart.nodes);
    cursorY += chart.height + 60;
  }

  if (slide.body) {
    const p = paragraph(slide.body, {
      x: width - 76,
      y: cursorY + 40,
      maxWidth: contentW,
      size: 36,
      weight: 600,
      fill: theme.text,
      maxLines: slide.chartData?.length ? 2 : 6,
      lineHeight: 1.7,
    });
    nodes.push(...p.nodes);
    cursorY += p.height + 40;
  }

  (slide.items ?? []).slice(0, 4).forEach((item, i) => {
    const y = cursorY + i * 86;
    nodes.push(rect(76, y, contentW, 70, theme.isDark ? 'rgba(255,255,255,0.07)' : '#FFFFFF', { rx: 18 }));
    nodes.push(rect(width - 76 - 66, y + 11, 48, 48, i === 0 ? theme.gold : theme.accent, { rx: 14 }));
    nodes.push(text(toFa(i + 1), width - 76 - 42, y + 44, { size: 22, weight: 900, fill: i === 0 ? '#0A0A0C' : theme.onAccent, anchor: 'middle' }));
    nodes.push(text(item, width - 160, y + 45, { size: 28, weight: 700, fill: theme.text, anchor: 'end' }));
  });

  nodes.push(...footer(theme, brand, width, height, { side: 76 }));
  return nodes;
}

/** Post cover (1080×1350). */
export function buildCover({ plan, theme: rawTheme, brand, scene }) {
  const { width, height } = CANVAS.cover;
  /* The section background decides light vs dark, not the caller. Half the six
     shipped backgrounds are light, and a white headline over #F8FAFC renders an
     invisible cover. `resolveTheme` reconciles the two. */
  const theme = resolveTheme(rawTheme, plan.sectionCode);
  const nodes = [rect(0, 0, width, height, theme.bg)];
  if (theme.isDark) {
    nodes.push(...GRID_OVERLAY(theme, width, height));
    nodes.push(circle(width * 0.88, height * 0.08, 400, 'rgba(255,180,0,0.07)'));
  } else {
    nodes.push(circle(width * 0.95, 20, 340, `${theme.accent}18`));
    nodes.push(circle(-60, height * 0.66, 260, 'rgba(255,180,0,0.18)'));
  }
  /* The identity package ships a real section background (frame + corner
     ticks in the subbrand colour). Using it is what makes a cover look like an
     issued asset rather than a generic gradient. */
  const bg = backgroundFor(plan.sectionCode, 'portrait');
  if (bg?.body) {
    nodes.push(svgAsset(bg, { x: 0, y: 0, width, height }));
  }

  nodes.push(...header(theme, brand, plan.sectionCode, width, { side: 84 }));

  const heading = scene?.cardTitle ? `${plan.title}` : plan.title;
  const lines = wrapText(heading, { maxWidth: width - 168, fontSize: 72, weight: 900, maxLines: 4 });
  lines.forEach((line, i) =>
    nodes.push(text(line, width - 84, 330 + i * 94, { size: 72, weight: 900, fill: theme.isDark ? '#FFFFFF' : theme.navy, anchor: 'end', lineHeight: 1.4 }))
  );
  let y = 330 + lines.length * 94 + 20;

  if (plan.subtitle) {
    const p = paragraph(plan.subtitle, {
      x: width - 84,
      y: y + 30,
      maxWidth: width - 200,
      size: 36,
      weight: 600,
      fill: theme.textMuted,
      maxLines: 3,
    });
    nodes.push(...p.nodes);
    y += p.height + 40;
  }

  if (scene?.metric) {
    /* Anchor the stat to the lower third instead of letting it float directly
       under the subtitle. Short headlines used to leave ~300 px of dead space
       above the CTA, which read as a layout mistake rather than as air. `max`
       keeps it from ever colliding with a long headline block. */
    const metricY = Math.max(y + 40, height - 430);
    const b = badge(scene.metric, { x: width - 84, y: metricY, size: 44, fill: theme.gold, color: '#0A0A0C', height: 96, paddingX: 34 });
    nodes.push(...b.nodes);
    if (scene.metricCaption) {
      nodes.push(text(scene.metricCaption, width - 84 - b.width - 20, metricY + 62, { size: 26, weight: 700, fill: theme.textMuted, anchor: 'end' }));
    }
  }

  const bh = badge(brand.cta, { x: width - 84, y: height - 210, size: 28, fill: theme.gold, color: '#0A0A0C', height: 62, paddingX: 26 });
  nodes.push(...bh.nodes);
  nodes.push(...footer(theme, brand, width, height, { side: 84 }));
  return nodes;
}

/* ────────────────────────── serialiser ────────────────────────── */

export function toSvg(nodes, { width, height, background = '#0A1931' }) {
  const body = nodes
    .map((n) => {
      if (n.type === 'rect') {
        const rx = n.rx ?? 0;
        return `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${rx}" fill="${n.fill}"${
          n.stroke ? ` stroke="${n.stroke}" stroke-width="${n.strokeWidth ?? 2}"` : ''
        } opacity="${n.opacity ?? 1}"/>`;
      }
      if (n.type === 'circle') {
        return `<circle cx="${n.cx}" cy="${n.cy}" r="${n.r}" fill="${n.fill}"${
          n.stroke ? ` stroke="${n.stroke}" stroke-width="${n.strokeWidth ?? 2}"` : ''
        }${n.strokeDasharray ? ` stroke-dasharray="${n.strokeDasharray}"` : ''}${
          n.transform ? ` transform="${n.transform}"` : ''
        } opacity="${n.opacity ?? 1}"/>`;
      }
      if (n.type === 'polygon') {
        return `<polygon points="${n.points.map((p) => p.join(',')).join(' ')}" fill="${n.fill}" opacity="${n.opacity ?? 1}"/>`;
      }
      if (n.type === 'polyline') {
        return `<polyline points="${n.points.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${n.stroke}" stroke-width="${
          n.strokeWidth ?? 3
        }" stroke-linecap="${n.strokeLinecap ?? 'round'}" stroke-linejoin="${n.strokeLinejoin ?? 'round'}"/>`;
      }
      if (n.type === 'svg') {
        /* Nested artwork: strip the inner <svg> wrapper's own width/height so the
           group transform is the only thing that decides size. resvg resolves
           neither files nor URLs, so the body must already be inline. */
        /* Nested <svg> must carry explicit pixel dimensions: resvg ignores
           percentage sizing inside a transformed group, which silently draws
           nothing. The intrinsic viewBox size is the correct unit here because
           the group transform is what does the scaling. */
        const inner = String(n.inner ?? '')
          .replace(/<svg\b([^>]*)>/i, (_, attrs) => {
            const vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.trim().split(/[\s,]+/).map(Number);
            const vw = vb?.[2] ?? 100;
            const vh = vb?.[3] ?? 100;
            const kept = attrs
              .replace(/\s(width|height)\s*=\s*["'][^"']*["']/gi, '')
              .replace(/\s(x|y)\s*=\s*["'][^"']*["']/gi, '');
            return `<svg${kept} width="${vw}" height="${vh}">`;
          })
          .replace(/<\/svg>\s*$/i, '</svg>');
        return `<g transform="${n.transform}" opacity="${n.opacity ?? 1}"${n.color ? ` fill="${n.color}"` : ''}>${inner}</g>`;
      }
      if (n.type === 'text') {
        return `<text x="${n.x}" y="${n.y}" font-family="${n.family}" font-size="${n.size}" font-weight="${n.weight}" fill="${n.fill}" text-anchor="${
          n.anchor
        }" opacity="${n.opacity ?? 1}"${
          n.letterSpacing ? ` letter-spacing="${n.letterSpacing}"` : ''
        } xml:space="preserve">${esc(n.content)}</text>`;
      }
      return '';
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="${background}"/>
${body}
</svg>`;
}
