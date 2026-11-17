/**
 * Persian text handling for the render engine.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE PERCENT SIGN. Measured, not guessed — this file exists because of it.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Persian convention: the sign is *typed after* the digits and, inside running
 * Persian text, the Bidi algorithm therefore places it visually to the LEFT of
 * the number (`۳۰٪`). Reference: r12a, Arabic script → Persian orthography
 * notes, "Numbers → Percentages".
 *
 * Measured against resvg (the engine that rasterises our stills), colour-coding
 * the percent sign red and the digits blue, then reading the ink centroids:
 *
 *   context              markup                result
 *   -------------------  --------------------  --------------
 *   sentence             "کاهش ۳۰٪ ضایعات"     percent LEFT   ✓ standard
 *   sentence + FSI/PDI   "کاهش ⁨۳۰٪⁩ …"        percent RIGHT  ✗ breaks it
 *   sentence + RLE/PDF   "کاهش ‫۳۰٪‬ …"        percent RIGHT  ✗ breaks it
 *   standalone token     "۳۰٪"                 percent RIGHT  ✗ LTR base
 *   standalone + ALM     "؜۳۰٪"                 percent RIGHT  ✗ ALM ignored
 *
 * Two findings drove the final design:
 *
 *  1. **Never inject bidi controls into a sentence.** The default behaviour is
 *     already correct; FSI/RLE actively break it. An earlier attempt to "fix"
 *     the sentence was about to ship exactly that bug.
 *
 *  2. **resvg ignores every base-direction control** (ALM U+061C, RLE/PDF,
 *     FSI/PDI, and the `direction` attribute). An isolated numeric token is laid
 *     out with an LTR base, so `۳۰٪` lands with the sign on the right — the one
 *     genuinely wrong case, and precisely the case that appears in metric pills,
 *     stat cards and big-number callouts.
 *
 * Since the engine will not honour ALM, we produce the intended *visual* result
 * by emitting the sign first: `٪۳۰`. Verified to render sign-on-the-left, which
 * matches the sentence rendering above and the Persian convention. This order
 * is also stable in a browser preview: in an RTL container the token resolves as
 * one LTR run, so it stays sign-left instead of flipping again.
 */

/**
 * Arabic-script letters (presentation forms included).
 *
 * The ranges stop *before* the digits on purpose: a naive `\u0669-\u06FF`
 * swallows U+06F0–U+06F9 (۰–۹), which made every Persian number look like
 * "running text" and turned this whole module into a no-op.
 *
 *   U+0621–U+064A  Arabic letters
 *   U+0671–U+06D3  Arabic letters, extended (‹۰–۹ = U+06F0–06F9 skipped)
 *   U+06FA–U+06FF  Arabic letters, tail
 *   U+0750–U+077F  Arabic Supplement
 *   U+08A0–U+08FF  Arabic Extended-A
 *   U+FB50–U+FDFF  Arabic Presentation Forms-A
 *   U+FE70–U+FEFF  Arabic Presentation Forms-B
 */
const RTL_LETTER_RE =
  /[\u0621-\u064A\u0671-\u06D3\u06FA-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** Percent signs in every form a plan file or model might emit. */
const PERCENT = '٪%％';
const PERCENT_CLASS = `[${PERCENT}]`;

/** Every bidi formatting character an editor or model may have inserted. */
const BIDI_CONTROL_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Digits in Latin, Persian and Arabic-Indic. */
const DIGIT_CLASS = '0-9\\u06F0-\\u06F9\\u0660-\\u0669';

/**
 * A token that contains nothing but numbers, signs and separators.
 * NB: the percent characters are listed inline — interpolating a bracket
 * expression (`[٪%％]`) into another character class builds a nested class,
 * which silently matches nothing. That bug made this whole module a no-op.
 */
const NUMERIC_ONLY_RE = new RegExp(
  `^[${DIGIT_CLASS}\\s.,٫٬+\\-−×÷±٪%％‰$]*$`,
);

/** Digits with an optional decimal tail immediately followed by a percent sign. */
const PERCENT_TOKEN_RE = new RegExp(
  `([${DIGIT_CLASS}]+(?:[.,٫٬][${DIGIT_CLASS}]+)*)\\s*(${PERCENT_CLASS})`,
  'g',
);

/**
 * Put a standalone number+percent token into the visual order resvg will draw
 * as sign-on-the-left. Sentences are returned untouched: their Bidi result is
 * already standard, and touching them is what breaks Persian.
 *
 * @param {string} input
 * @returns {string}
 */
export function persianPercent(input) {
  const text = String(input ?? '');
  if (!text) return text;

  const bare = text.replace(BIDI_CONTROL_RE, '').trim();
  if (!bare) return text;

  /* Persian running text — leave the Bidi algorithm alone. */
  if (RTL_LETTER_RE.test(bare)) return text;

  /* Standalone numeric token: emit sign-first so it draws sign-left. A leading
     sign (+/−/±) belongs to the number, not to the token, so it stays in place:
     `+۴۵٪` → `+٪۴۵`, not `٪+۴۵`. */
  if (NUMERIC_ONLY_RE.test(bare)) {
    const leading = /^([+\-−±])\s*/.exec(bare);
    const prefix = leading ? leading[1] : '';
    const rest = leading ? bare.slice(leading[0].length) : bare;
    return prefix + rest.replace(PERCENT_TOKEN_RE, (_m, digits, sign) => `${sign}${digits}`);
  }
  return text;
}

/**
 * Normalise the substitutions a Persian editor makes by hand. Order matters:
 * character mapping first, then ZWNJ (it changes word shape), then spacing.
 */
export function normalisePersian(input) {
  return String(input ?? '')
    /* Arabic yeh/kaf/teh-marbuta → Persian forms: different glyphs in Vazirmatn */
    .replace(/\u064A/g, '\u06CC')
    .replace(/\u0643/g, '\u06A9')
    .replace(/\u0629/g, '\u0647')
    /* Arabic-Indic digits → Persian digits */
    .replace(/[\u0660-\u0669]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0x06F0 - 0x0660))
    /* European digits → Persian digits (Persian-first; plan files are mixed) */
    .replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0x06F0 - 0x30))
    /* "می شود" → "می‌شود" */
    .replace(/(^|[\s\u200C])(می|نمی)\s+([\u0600-\u06FF])/g, '$1$2\u200C$3')
    /* "کتاب ها" → "کتاب‌ها" */
    .replace(/([\u0600-\u06FF]{2,})\s+(ها|های|هایی|هایم|هایت|هایش)(?=[\s،؛.!؟]|$)/g, '$1\u200C$2')
    /* collapse repeated spaces and spaces before punctuation */
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([،؛:!؟?])/g, '$1');
}

/**
 * The full render-time treatment for a user-visible Persian string.
 * Normalise, then apply the percent rule. Idempotent.
 */
export function persianText(input) {
  return persianPercent(normalisePersian(input));
}

/**
 * Keep a number glued to its percent sign or unit across a line break, so
 * `wrapText` can never orphan the sign. Uses U+00A0, which renders at normal
 * width, so the visual output is unchanged.
 */
export function protectNumericClusters(input) {
  return String(input ?? '').replace(
    new RegExp(`([${DIGIT_CLASS}]+(?:[.,٫٬][${DIGIT_CLASS}]+)*)\\s+(${PERCENT_CLASS}|‰|×|÷)`, 'g'),
    '$1\u00A0$2',
  );
}

/**
 * Strip bidi controls for copy-out, export and search — anywhere the invisible
 * characters would become the next person's debugging session.
 */
export function stripBidiControls(input) {
  return String(input ?? '').replace(BIDI_CONTROL_RE, '');
}

/** Direction facts about a string, for layout decisions. */
export function bidiInfo(input) {
  const text = String(input ?? '');
  const bare = text.replace(BIDI_CONTROL_RE, '').trim();
  const rtl = RTL_LETTER_RE.test(text);
  const numeric = NUMERIC_ONLY_RE.test(bare);
  return {
    rtl,
    direction: rtl ? 'rtl' : 'ltr',
    numeric,
    hasPercent: new RegExp(PERCENT_CLASS).test(text),
    reordered: !rtl && numeric && new RegExp(PERCENT_CLASS).test(text),
  };
}

export { PERCENT, RTL_LETTER_RE, BIDI_CONTROL_RE, DIGIT_CLASS };
