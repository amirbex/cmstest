/**
 * Composer — plan → artefacts.
 *
 * Owns the timing model (how long each beat holds, where the outro starts) and
 * translates the static primitives from `canvas.js` into animated frames using
 * the motion registry. Both the "cover" path and the "reel" path funnel through
 * here so the studio preview, the exported MP4 and the gallery thumbnails are
 * always the same picture.
 */
import path from 'node:path';
import { CANVAS, buildReelScene, buildCarouselSlide, buildCover, buildOutro } from './canvas.js';
import { computeBeatStyle } from './motion.js';
import { renderStill, renderSequence, OUT_DIR } from './renderer.js';
import { themeFor, loadBrand } from '../services/brand.js';

const FPS = 30;

/** Time budget: narration length wins, otherwise 4s per beat, capped at 58s. */
export function planTimeline(plan) {
  const scenes = plan.scenes?.length ? plan.scenes : [{ cardTitle: plan.title, items: [], chartData: [] }];
  const audioSec = Number(plan.audio?.durationSec) || 0;
  const target = audioSec > 2 ? audioSec : Math.min(58, Math.max(12, scenes.length * 4.2));
  const outroSec = plan.layout?.logoMotion === 'none' ? 0 : 2.6;
  const contentSec = Math.max(6, target - outroSec);
  const perScene = contentSec / scenes.length;
  return {
    scenes,
    perScene,
    contentSec,
    outroSec,
    totalSec: contentSec + outroSec,
    fps: FPS,
  };
}

/* ────────────────────────── stills ────────────────────────── */

export async function renderCover({ plan, contentId, revision = 1 }) {
  const theme = themeFor(plan.sectionCode, plan.layout?.theme ?? 'auto');
  const brand = loadBrand();
  const { width, height } = CANVAS.cover;
  const scene = plan.scenes?.[0];
  const nodes = buildCover({ plan, theme, brand, scene });
  const outFile = path.join(OUT_DIR, 'covers', `${contentId}-COVER-r${revision}.png`);
  const result = await renderStill({ nodes, width, height, background: theme.bg, outFile });
  return { ...result, kind: 'cover', url: `/media/outputs/covers/${path.basename(outFile)}` };
}

export async function renderCarousel({ plan, contentId, revision = 1, onProgress }) {
  const theme = themeFor(plan.sectionCode, plan.layout?.theme ?? 'auto');
  const brand = loadBrand();
  const { width, height } = CANVAS.carousel;
  const slides = plan.carouselSlides?.length
    ? plan.carouselSlides
    : [
        {
          slideNumber: 1,
          templateType: 'cover',
          badge: plan.sectionCode,
          heading: plan.title,
          body: plan.subtitle,
          highlightMetric: plan.scenes?.[0]?.metric ?? '',
          items: [],
          chartData: [],
        },
      ];

  const results = [];
  for (const [index, slide] of slides.entries()) {
    const nodes = buildCarouselSlide({ plan, theme, brand, slide, index, total: slides.length });
    const outFile = path.join(OUT_DIR, 'carousels', `${contentId}-S${String(index + 1).padStart(2, '0')}-r${revision}.png`);
    const result = await renderStill({ nodes, width, height, background: theme.bg, outFile });
    results.push({
      ...result,
      kind: 'image',
      url: `/media/outputs/carousels/${path.basename(outFile)}`,
      slideNumber: index + 1,
    });
    onProgress?.(Math.round(((index + 1) / slides.length) * 100), `اسلاید ${index + 1} از ${slides.length}`);
  }
  return results;
}

/* ────────────────────────── video ────────────────────────── */

/**
 * Frame builder for the reel. The scene nodes are computed once per beat and
 * then transformed per frame — cheap and exactly consistent with the preview.
 */
export function makeReelFrameFactory({ plan, brand = loadBrand() }) {
  const theme = themeFor(plan.sectionCode, plan.layout?.theme ?? 'auto');
  const timeline = planTimeline(plan);
  const { width, height } = CANVAS.reel;

  const sceneNodes = timeline.scenes.map((scene, index) =>
    buildReelScene({ plan, theme, brand, scene, sceneIndex: index, totalScenes: timeline.scenes.length }).nodes
  );
  const outroNodes = buildOutro({ theme, brand, plan });

  return {
    width,
    height,
    background: theme.bg,
    timeline,
    totalSec: timeline.totalSec,
    frameFor(_frameIndex, timeSec) {
      const outroStart = timeline.contentSec;
      if (timeline.outroSec > 0 && timeSec >= outroStart) {
        const local = timeSec - outroStart;
        const style = computeBeatStyle({
          motion: 'spring-pop',
          elapsed: local,
          duration: timeline.outroSec,
          inSec: 0.45,
          outSec: 0,
        });
        return outroNodes.map((n) => applyStyle(n, style));
      }
      const sceneIndex = Math.min(
        timeline.scenes.length - 1,
        Math.floor(timeSec / timeline.perScene)
      );
      const local = timeSec - sceneIndex * timeline.perScene;
      const style = computeBeatStyle({
        motion: 'fade-up',
        elapsed: local,
        duration: timeline.perScene,
        inSec: 0.5,
        outSec: 0.3,
      });
      const base = sceneNodes[Math.max(0, sceneIndex)];
      // subtle Ken-Burns on the whole frame so static beats still breathe
      const drift = { ...style, scale: (style.scale ?? 1) * (1 + 0.006 * (local / timeline.perScene)) };
      return base.map((n) => applyStyle(n, drift));
    },
  };
}

/** Bake a motion style into a primitive (renderer stays dumb & fast). */
function applyStyle(node, style) {
  if (!style || Object.keys(style).length === 0) return node;
  const opacity = style.opacity === undefined ? 1 : style.opacity;
  const scale = style.scale ?? 1;
  const tx = style.translateX ?? 0;
  const ty = style.translateY ?? 0;
  if (opacity >= 0.999 && scale === 1 && tx === 0 && ty === 0) return node;

  const cx = node.type === 'circle' ? node.cx : node.x + (node.w ?? 0) / 2;
  const cy = node.type === 'circle' ? node.cy : node.y + (node.h ?? 0) / 2;
  const transform = [
    tx || ty ? `translate(${tx.toFixed(2)} ${ty.toFixed(2)})` : '',
    scale !== 1 ? `translate(${cx} ${cy}) scale(${scale.toFixed(4)}) translate(${-cx} ${-cy})` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return { ...node, opacity, transform: [node.transform, transform].filter(Boolean).join(' ') || undefined };
}

export async function renderReel({ plan, contentId, revision = 1, jobId, audioFile = null, onProgress }) {
  const factory = makeReelFrameFactory({ plan });
  const outFile = path.join(OUT_DIR, 'reels', `${contentId}-REEL-r${revision}.mp4`);

  const result = await renderSequence({
    makeFrame: (i, t) => factory.frameFor(i, t),
    fps: factory.timeline.fps,
    durationSec: factory.totalSec,
    width: factory.width,
    height: factory.height,
    background: factory.background,
    outFile,
    jobId,
    audioFile,
    onProgress: (p, step) => onProgress?.(p, step),
  });

  return {
    ...result,
    kind: 'video',
    url: `/media/outputs/reels/${path.basename(outFile)}`,
    durationSec: factory.totalSec,
  };
}

/** Preview a single still frame at an arbitrary time (used by the studio scrubber). */
export async function renderPreviewFrame({ plan, timeSec = 0, contentId = 'preview' }) {
  const factory = makeReelFrameFactory({ plan });
  const nodes = factory.frameFor(Math.round(timeSec * factory.timeline.fps), timeSec);
  const outFile = path.join(OUT_DIR, 'previews', `${contentId}.png`);
  return renderStill({
    nodes,
    width: factory.width,
    height: factory.height,
    background: factory.background,
    outFile,
  });
}
