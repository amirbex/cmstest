/**
 * Brand service — loads/validates brand.json, derives chart-friendly theme
 * tokens, and resolves the on-brand readable foreground for any accent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BrandConfig } from '@atoz/contracts';
import { backgroundTone } from '../engine/assets.js';

const BRAND_FILE = process.env.ATOZ_BRAND_FILE || path.resolve('brand.json');

let cache = null;

export function loadBrand(force = false) {
  if (cache && !force) return cache;
  const raw = JSON.parse(fs.readFileSync(BRAND_FILE, 'utf-8'));
  cache = BrandConfig.parse(raw);
  return cache;
}

/** WCAG relative luminance → pick black or white text for a surface colour. */
export function readableOn(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.45 ? '#0A0A0C' : '#FFFFFF';
}

export function themeFor(sectionCode = 'Library', forceMode = 'auto') {
  const brand = loadBrand();
  const theme = brand.sectionThemes[sectionCode] ?? brand.sectionThemes.Library;

  /* The artwork is the authority on light vs dark, not brand.json.
     `backgrounds/<Section>/portrait.svg` is what actually gets painted under
     every still, and it disagreed with brand.json for two sections
     (Calculators is navy #071923 but was declared light; Solutions is
     #F9F7F2 but was declared dark). Reading the tone here means the theme,
     the artwork and the text colour cannot drift apart again — and a future
     identity update that recolours a background is picked up for free. */
  const tone = backgroundTone(sectionCode, 'portrait');
  const declaredMode = theme.mode;
  const artworkMode = tone ? (tone.isDark ? 'dark' : 'light') : declaredMode;
  const mode = forceMode === 'auto' ? artworkMode : forceMode;
  const isDark = mode === 'dark';
  return {
    ...theme,
    mode,
    isDark,
    surface: isDark ? 'rgba(255,255,255,0.06)' : '#FFFFFF',
    surfaceStrong: isDark ? 'rgba(255,255,255,0.12)' : '#FFFFFF',
    text: isDark ? '#F8FAFC' : brand.colors.primaryNavy ?? '#0A1931',
    textMuted: isDark ? 'rgba(248,250,252,0.72)' : 'rgba(10,25,49,0.66)',
    onAccent: readableOn(theme.accent),
    gold: brand.colors.accentGold ?? '#FFB400',
    navy: brand.colors.primaryNavy ?? '#0A1931',
    /* Set only when brand.json and the shipped artwork disagree, so the content
       pipeline can surface it instead of shipping an invisible card. */
    themeCorrection:
      forceMode === 'auto' && tone && artworkMode !== declaredMode
        ? `brand.json says ${sectionCode} is ${declaredMode}, but backgrounds/${sectionCode}/portrait.svg is ${tone.bg} (${artworkMode})`
        : undefined,
  };
}

/** Chart palette derived from the brand, guaranteed to stay legible on bg. */
export function chartPalette(sectionCode = 'Library') {
  const theme = themeFor(sectionCode);
  return [theme.accent, theme.gold, '#5D5FEF', '#0F766E', '#C05746', '#D97706'];
}
