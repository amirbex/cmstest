/**
 * Motion system — a registry of code-defined animation recipes.
 *
 * Each preset maps normalised progress `t ∈ [0,1]` to a transform + opacity,
 * so the same recipe drives both the live browser preview (CSS/WASM-free JS)
 * and the offline frame renderer. This is the "400 motion recipes" idea from
 * the reference toolkits (Remotion skills / HyperFrames / OpenDesign) rebuilt
 * as a small, dependency-free, testable set of primitives.
 */

const clamp01 = (t) => Math.max(0, Math.min(1, t));

/* ────────────────────────── easings ────────────────────────── */

export const ease = {
  linear: (t) => t,
  outQuad: (t) => 1 - (1 - t) ** 2,
  outCubic: (t) => 1 - (1 - t) ** 3,
  outQuart: (t) => 1 - (1 - t) ** 4,
  inOutCubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  /** classic Remotion-style spring approximation */
  spring: (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return 1 - Math.exp(-6.5 * t) * Math.cos(9.2 * t);
  },
  backOut: (t) => {
    const c = 1.70158;
    return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
  },
};

/* ────────────────────────── presets ────────────────────────── */

/**
 * A preset receives the IN/OUT progress of a beat and returns a style object.
 * `tIn` is 0→1 over the entrance window, `tOut` is 0→1 over the exit window
 * (0 while the element is still on screen at rest).
 */
export const MOTIONS = {
  'fade-in': {
    label: 'محو شدن',
    style: ({ tIn }) => ({ opacity: ease.outQuad(tIn) }),
  },
  'fade-up': {
    label: 'ظهور از پایین',
    style: ({ tIn }) => {
      const e = ease.outCubic(tIn);
      return { opacity: e, translateY: (1 - e) * 46 };
    },
  },
  'fade-down': {
    label: 'ظهور از بالا',
    style: ({ tIn }) => {
      const e = ease.outCubic(tIn);
      return { opacity: e, translateY: -(1 - e) * 46 };
    },
  },
  'slide-in-right': {
    label: 'ورود از راست',
    style: ({ tIn }) => {
      const e = ease.outQuart(tIn);
      return { opacity: e, translateX: (1 - e) * 140 };
    },
  },
  'slide-in-left': {
    label: 'ورود از چپ',
    style: ({ tIn }) => {
      const e = ease.outQuart(tIn);
      return { opacity: e, translateX: -(1 - e) * 140 };
    },
  },
  'spring-pop': {
    label: 'پاپ فنری',
    style: ({ tIn }) => {
      const e = ease.spring(tIn);
      return { opacity: clamp01(tIn * 2), scale: 0.72 + 0.28 * e };
    },
  },
  'zoom-in': {
    label: 'بزرگ‌نمایی',
    style: ({ tIn }) => {
      const e = ease.outCubic(tIn);
      return { opacity: e, scale: 0.86 + 0.14 * e };
    },
  },
  'blur-in': {
    label: 'وضوح تدریجی',
    style: ({ tIn }) => {
      const e = ease.outQuad(tIn);
      return { opacity: e, blur: (1 - e) * 12 };
    },
  },
  'wipe-right': {
    label: 'پرده از راست',
    style: ({ tIn }) => {
      const e = ease.inOutCubic(tIn);
      return { opacity: 1, clipRight: (1 - e) * 100 };
    },
  },
  'wipe-up': {
    label: 'پرده از پایین',
    style: ({ tIn }) => {
      const e = ease.inOutCubic(tIn);
      return { opacity: 1, clipBottom: (1 - e) * 100 };
    },
  },
  'count-up': {
    label: 'شمارنده عددی',
    style: ({ tIn }) => ({ opacity: clamp01(tIn * 3), counter: ease.outCubic(tIn) }),
  },
  'bar-grow': {
    label: 'رشد نمودار',
    style: ({ tIn }) => ({ opacity: 1, progress: ease.outCubic(tIn) }),
  },
  'ring-sweep': {
    label: 'جاروکشی حلقه',
    style: ({ tIn }) => ({ opacity: 1, progress: ease.inOutCubic(tIn) }),
  },
  'kinetic-words': {
    label: 'کلمات جنبشی',
    style: ({ tIn }) => ({ opacity: 1, wordProgress: clamp01(tIn) }),
  },
  'pulse': {
    label: 'تپش',
    style: ({ tIn }) => ({ opacity: clamp01(tIn * 2), scale: 1 + 0.02 * Math.sin(tIn * Math.PI * 3) }),
  },
  'none': { label: 'بدون حرکت', style: () => ({ opacity: 1 }) },
};

export const MOTION_KEYS = Object.keys(MOTIONS);

export function resolveMotion(key) {
  return MOTIONS[key] ?? MOTIONS['fade-up'];
}

/** Apply an entrance/exit window to a preset. */
export function computeBeatStyle({ motion = 'fade-up', elapsed, duration, inSec = 0.55, outSec = 0.35 }) {
  const preset = resolveMotion(motion);
  const tIn = clamp01(inSec <= 0 ? 1 : elapsed / inSec);
  const remaining = duration - elapsed;
  const tOut = outSec > 0 && remaining < outSec ? 1 - clamp01(remaining / outSec) : 0;
  const style = preset.style({ tIn, tOut, elapsed, duration });
  if (tOut > 0) {
    style.opacity = (style.opacity ?? 1) * (1 - ease.outQuad(tOut));
    style.translateY = (style.translateY ?? 0) - 24 * ease.outQuad(tOut);
  }
  return style;
}

/** CSS transform string for the browser preview (same maths as the renderer). */
export function styleToCss(style = {}) {
  const parts = [];
  if (style.translateX) parts.push(`translateX(${style.translateX.toFixed(2)}px)`);
  if (style.translateY) parts.push(`translateY(${style.translateY.toFixed(2)}px)`);
  if (style.scale && style.scale !== 1) parts.push(`scale(${style.scale.toFixed(4)})`);
  const css = {};
  if (parts.length) css.transform = parts.join(' ');
  if (style.opacity !== undefined) css.opacity = String(Math.max(0, Math.min(1, style.opacity)).toFixed(3));
  if (style.blur) css.filter = `blur(${style.blur.toFixed(2)}px)`;
  if (style.clipRight !== undefined) css.clipPath = `inset(0 0 0 ${(100 - style.clipRight).toFixed(2)}%)`;
  if (style.clipBottom !== undefined) css.clipPath = `inset(${(100 - style.clipBottom).toFixed(2)}% 0 0 0)`;
  return css;
}

/* ────────────────────────── transitions between beats ────────────────────────── */

export const TRANSITIONS = {
  cut: { label: 'کات', apply: () => ({}) },
  dissolve: { label: 'محو متقاطع', apply: ({ t }) => ({ opacity: clamp01(t) }) },
  'slide-push': {
    label: 'هل دادن',
    apply: ({ t, direction = 1 }) => ({ translateX: (1 - clamp01(t)) * 120 * direction }),
  },
  'zoom-through': {
    label: 'عبور زوم',
    apply: ({ t }) => ({ scale: 1.12 - 0.12 * clamp01(t), opacity: clamp01(t * 1.4) }),
  },
  'whip-pan': {
    label: 'وایپ پن',
    apply: ({ t }) => ({ translateX: (1 - ease.outQuart(clamp01(t))) * 340, blur: (1 - clamp01(t)) * 18 }),
  },
};

export const TRANSITION_KEYS = Object.keys(TRANSITIONS);
