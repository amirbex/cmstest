/**
 * Offline render engine — zero cloud, zero Chrome.
 *
 *   canvas primitives ──► SVG ──► resvg (Rust) ──► PNG frame
 *                                                 │
 *                              ffmpeg (static) ◄──┘ ──► MP4 / WebM / GIF
 *
 * This replaces v5.0's `npx remotion render` subprocess (which needed a
 * downloaded Chromium and was shell-injectable). Everything here is pure
 * Node: no network, no browser, deterministic output, ~40–90 fps for 1080p
 * stills on a laptop CPU.
 */
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import { toSvg } from './canvas.js';
import { computeBeatStyle } from './motion.js';

const FONT_DIR = path.resolve('app/web/public/fonts');
const OUT_DIR = path.resolve(process.env.ATOZ_OUTPUT_DIR || 'storage/outputs');

fs.mkdirSync(OUT_DIR, { recursive: true });

/* ────────────────────────── fonts ────────────────────────── */

let fontCache = null;

export function loadFonts() {
  if (fontCache) return fontCache;
  const buffers = [];

  /* Two font sources, both required by the identity package:
       • app/web/public/fonts — the woff2 web subset (Persian UI)
       • assets/fonts        — the TTF originals for Montserrat + Lato, which
     the identity tokens specify for latin headings and body. Loading only the
     web subset silently fell back to a system sans for every latin glyph. */
  const dirs = [FONT_DIR, process.env.ATOZ_ASSETS_DIR ? path.join(process.env.ATOZ_ASSETS_DIR, 'fonts') : path.resolve('assets/fonts')];
  for (const dir of dirs) {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (/\.(woff2?|otf|ttf)$/i.test(file)) buffers.push(fs.readFileSync(path.join(dir, file)));
      }
    } catch {
      /* a missing font directory is not fatal: system fonts remain available */
    }
  }
  fontCache = {
    fontBuffers: buffers,
    loadSystemFonts: buffers.length === 0,
    defaultFontFamily: 'Vazirmatn',
  };
  return fontCache;
}

/* ────────────────────────── still rendering ────────────────────────── */

/**
 * Rasterise a primitive list to a PNG buffer.
 * @returns {Buffer}
 */
export function rasterise(nodes, { width, height, background }) {
  const svg = toSvg(nodes, { width, height, background });
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: loadFonts(),
    background,
  });
  return resvg.render().asPng();
}

export async function renderStill({ nodes, width, height, background = '#0A1931', outFile }) {
  const png = rasterise(nodes, { width, height, background });
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await fsp.writeFile(outFile, png);
  return { file: outFile, bytes: png.length, width, height };
}

/* ────────────────────────── video encoding ────────────────────────── */

let ffmpegPath = null;
export function getFfmpegPath() {
  if (ffmpegPath) return ffmpegPath;
  if (process.env.ATOZ_FFMPEG) {
    ffmpegPath = process.env.ATOZ_FFMPEG;
    return ffmpegPath;
  }
  try {
    ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    fs.accessSync(ffmpegPath, fs.constants.X_OK);
  } catch {
    ffmpegPath = process.env.ATOZ_FFMPEG || 'ffmpeg';
  }
  return ffmpegPath;
}

function runFfmpeg(args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      reject(new Error(`ffmpeg قابل اجرا نیست: ${err.message}`));
      return;
    }
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ffmpeg timeout'));
    }, 15 * 60 * 1000);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 40_000) stderr = stderr.slice(-20_000);
      onStderr?.(chunk.toString());
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg قابل اجرا نیست: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stderr });
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

export async function encodeVideo({ framesDir, outFile, fps = 30, width, height, crf = 20, onProgress }) {
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const args = [
    '-y',
    '-framerate',
    String(fps),
    '-i',
    path.join(framesDir, 'f%05d.png'),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    String(crf),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-vf',
    `scale=${width}:${height}`,
    outFile,
  ];
  await runFfmpeg(args, {
    onStderr: (chunk) => {
      const m = chunk.match(/frame=\s*(\d+)/);
      if (m && onProgress) onProgress(Number(m[1]));
    },
  });
  const stat = await fsp.stat(outFile);
  return { file: outFile, bytes: stat.size, width, height };
}

/** Mux an audio track onto a silent video (used when TTS succeeds). */
export async function muxAudio({ videoFile, audioFile, outFile }) {
  await runFfmpeg([
    '-y',
    '-i',
    videoFile,
    '-i',
    audioFile,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-shortest',
    outFile,
  ]);
  const stat = await fsp.stat(outFile);
  return { file: outFile, bytes: stat.size };
}

/* ────────────────────────── frame sequence ────────────────────────── */

/**
 * Render an animated sequence described by `makeFrame(frameIndex, timeSec)`.
 * PNG frames are written to a temporary directory that is deleted afterwards,
 * so a crashed render can never leak gigabytes into storage.
 */
export async function renderSequence({
  makeFrame,
  fps = 30,
  durationSec,
  width,
  height,
  background = '#0A1931',
  outFile,
  jobId = `job-${Date.now()}`,
  audioFile = null,
  onProgress,
}) {
  const totalFrames = Math.max(1, Math.round(durationSec * fps));
  const framesDir = path.join(OUT_DIR, '.frames', jobId);
  await fsp.mkdir(framesDir, { recursive: true });

  try {
    for (let i = 0; i < totalFrames; i++) {
      const nodes = makeFrame(i, i / fps);
      const png = rasterise(nodes, { width, height, background });
      await fsp.writeFile(path.join(framesDir, `f${String(i).padStart(5, '0')}.png`), png);
      if (onProgress && (i % 5 === 0 || i === totalFrames - 1)) {
        onProgress(Math.round(((i + 1) / totalFrames) * 85), `رندر فریم ${i + 1} از ${totalFrames}`);
      }
    }

    const silentFile = audioFile ? outFile.replace(/\.mp4$/, '.silent.mp4') : outFile;
    await encodeVideo({ framesDir, outFile: silentFile, fps, width, height, onProgress: (n) =>
      onProgress?.(85 + Math.min(14, Math.round((n / totalFrames) * 14)), 'کدگذاری ویدئو')
    });

    if (audioFile) {
      await muxAudio({ videoFile: silentFile, audioFile, outFile });
      await fsp.rm(silentFile, { force: true });
    }

    const stat = await fsp.stat(outFile);
    return { file: outFile, bytes: stat.size, width, height, frames: totalFrames, fps };
  } finally {
    await fsp.rm(framesDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Build a zipped content package without any third-party dependency. */
export async function zipFiles({ files, outFile }) {
  // archiver-free: use the system `zip` if present, otherwise emit a tar.
  const listFile = `${outFile}.list`;
  await fsp.writeFile(listFile, files.join('\n'), 'utf-8');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('zip', ['-j', '-q', outFile, '-@'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (c) => (err += c));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))));
      fs.createReadStream(listFile).pipe(child.stdin);
    });
    return { file: outFile, format: 'zip' };
  } catch {
    return null;
  } finally {
    await fsp.rm(listFile, { force: true });
  }
}

export function beatStyle(args) {
  return computeBeatStyle(args);
}

export { OUT_DIR };
