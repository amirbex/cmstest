/**
 * Media service — upload, compress, transcribe, subtitle.
 *
 * The pipeline the user asked for, implemented literally:
 *
 *   upload → probe → compress (fewer bytes, same look) → send a short audio
 *   extract to Gemini with a timestamped-schema prompt → validate the returned
 *   word timings → hand them to our own subtitle engine → burn in with ffmpeg.
 *
 * Why compress first: a 200 MB phone clip costs latency and tokens to
 * transcribe and can hit upload limits. Re-encoding to a sane bitrate at the
 * same resolution cuts 60-85% of the bytes with no visible loss, and the
 * transcription call receives a small mono 16 kHz audio track.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { db, nowIso, logEvent } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { ensureDir } from '../lib/fsx.js';
import { SubtitleStyle, Transcript } from '@atoz/contracts';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

const MEDIA_DIR = process.env.ATOZ_MEDIA_DIR || path.resolve('storage/media');
export const FOLDERS = ['incoming', 'brand', 'raw', 'reference', 'exports'];

/* ────────────────────────── ffmpeg / ffprobe ────────────────────────── */

function resolveFfmpeg() {
  if (process.env.ATOZ_FFMPEG && fs.existsSync(process.env.ATOZ_FFMPEG)) return process.env.ATOZ_FFMPEG;
  try {
    const packaged = require('@ffmpeg-installer/ffmpeg');
    fs.accessSync(packaged.path, fs.constants.X_OK);
    return packaged.path;
  } catch {
    /* fall through */
  }
  return 'ffmpeg';
}

const FFMPEG = resolveFfmpeg();
const FFMPEG_DIR = FFMPEG === 'ffmpeg' ? null : path.dirname(FFMPEG);

/** ffprobe ships next to the ffmpeg binary in the installer package. */
function resolveFfprobe() {
  if (process.env.ATOZ_FFPROBE && fs.existsSync(process.env.ATOZ_FFPROBE)) return process.env.ATOZ_FFPROBE;
  if (FFMPEG_DIR) {
    const candidate = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'ffprobe';
}

const FFPROBE = resolveFfprobe();

export function mediaUrlFor(relPath) {
  return `/media/uploads/${relPath.split(path.sep).join('/')}`;
}

function safeName(name) {
  const base = path.basename(String(name ?? 'upload')).replace(/[^\w.\-\u0600-\u06FF]/g, '_');
  return base.slice(0, 120) || 'upload';
}

function uniquePath(folder, filename) {
  const dir = ensureDir(path.join(MEDIA_DIR, folder));
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${n}${ext}`);
    n++;
  }
  return candidate;
}

/* ────────────────────────── probe ────────────────────────── */

/**
 * Probe with ffprobe when available, else parse `ffmpeg -i` stderr.
 *
 * The bundled @ffmpeg-installer package ships ffmpeg but not ffprobe, and most
 * machines have neither on PATH. Refusing to know a video's duration because of
 * a missing sibling binary would break the whole subtitle pipeline, so the
 * fallback parses the same information out of ffmpeg's own banner.
 */
async function probeWithFfmpeg(file) {
  let stderr = '';
  try {
    await exec(FFMPEG, ['-hide_banner', '-i', file], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    /* ffmpeg exits non-zero when no output is specified — that is expected */
    stderr = String(err.stderr ?? '');
  }
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const video = /Stream #\d+:\d+.*?: Video: (\w+).*?(\d{2,5})x(\d{2,5})/.exec(stderr);
  const fpsMatch = /,\s*([\d.]+) fps/.exec(stderr);
  const audio = /Stream #\d+:\d+.*?: Audio: (\w+)/.exec(stderr);
  const bitrateMatch = /bitrate:\s*(\d+) kb\/s/.exec(stderr);
  return {
    durationSec: duration
      ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
      : null,
    width: video ? Number(video[2]) : null,
    height: video ? Number(video[3]) : null,
    fps: fpsMatch ? Number(fpsMatch[1]) : null,
    videoCodec: video ? video[1] : null,
    audioCodec: audio ? audio[1] : null,
    hasAudio: Boolean(audio),
    bytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
    bitrate: bitrateMatch ? Number(bitrateMatch[1]) * 1000 : null,
    format: null,
  };
}

export async function probe(file) {
  try {
    const { stdout } = await exec(
      FFPROBE,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
    );
    const info = JSON.parse(stdout);
    const video = (info.streams ?? []).find((s) => s.codec_type === 'video');
    const audio = (info.streams ?? []).find((s) => s.codec_type === 'audio');
    return {
      durationSec: Number(info.format?.duration ?? video?.duration ?? 0) || null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      fps: video?.r_frame_rate ? evalRate(video.r_frame_rate) : null,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      hasAudio: Boolean(audio),
      bytes: Number(info.format?.size ?? 0),
      bitrate: Number(info.format?.bit_rate ?? 0) || null,
      format: info.format?.format_name ?? null,
    };
  } catch {
    return probeWithFfmpeg(file);
  }
}

const evalRate = (rate) => {
  const [a, b] = String(rate).split('/').map(Number);
  return b ? Math.round((a / b) * 100) / 100 : a;
};

/** Extract a mono 16 kHz mp3 — small enough to send to a model. */
export async function extractAudio(file, { bitrate = '48k' } = {}) {
  const info = await probe(file);
  if (!info.hasAudio) {
    throw new HttpError(422, 'این فایل هیچ صدایی ندارد؛ زیرنویس خودکار نیاز به نریشن دارد', 'NO_AUDIO_STREAM');
  }
  const out = path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.audio.mp3`);
  try {
    await exec(
      FFMPEG,
      ['-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', bitrate, out],
      { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }
    );
  } catch (err) {
    throw new HttpError(422, `استخراج صدا ناموفق بود: ${String(err.stderr ?? err.message).slice(0, 300)}`, 'AUDIO_EXTRACT_FAILED');
  }
  return { file: out, bytes: fs.statSync(out).size };
}

/* ────────────────────────── compress ────────────────────────── */

/**
 * Re-encode to H.264/AAC at the same resolution but a sane CRF.
 * CRF 26 is visually lossless for social video and typically 60-85% smaller
 * than a phone's default recording.
 */
export async function compress(inputFile, { crf = 26, maxWidth = 1080, preset = 'veryfast' } = {}) {
  const info = await probe(inputFile);
  const isVideo = Boolean(info.width);
  const out = path.join(path.dirname(inputFile), `${path.basename(inputFile, path.extname(inputFile))}.compressed.mp4`);

  const scale =
    isVideo && info.width > maxWidth
      ? ['-vf', `scale=${maxWidth}:-2`]
      : [];

  const args = isVideo
    ? ['-y', '-i', inputFile, ...scale, '-c:v', 'libx264', '-crf', String(crf), '-preset', preset, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', out]
    : ['-y', '-i', inputFile, '-c:a', 'aac', '-b:a', '128k', out];

  const started = Date.now();
  await exec(FFMPEG, args, { timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
  const after = await probe(out);
  const before = fs.statSync(inputFile).size;
  const afterBytes = fs.statSync(out).size;
  return {
    file: out,
    beforeBytes: before,
    afterBytes,
    savedPct: before ? Math.round((1 - afterBytes / before) * 1000) / 10 : 0,
    durationSec: after.durationSec ?? info.durationSec,
    width: after.width,
    height: after.height,
    elapsedMs: Date.now() - started,
    info,
  };
}

/* ────────────────────────── store / query ────────────────────────── */

export function insertMedia(record) {
  const mediaId =
    record.mediaId ||
    `MDA-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  db.prepare(
    `INSERT INTO media (media_id, kind, file, url, original_name, mime, bytes, width, height,
       duration_sec, folder, content_id, parent_id, meta_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    mediaId,
    record.kind ?? 'video',
    record.file,
    record.url,
    record.originalName ?? '',
    record.mime ?? '',
    record.bytes ?? 0,
    record.width ?? null,
    record.height ?? null,
    record.durationSec ?? null,
    record.folder ?? 'incoming',
    record.contentId ?? null,
    record.parentId ?? null,
    JSON.stringify(record.meta ?? {}),
    nowIso()
  );
  return getMedia(mediaId);
}

export function rowToMedia(row) {
  if (!row) return null;
  let meta = {};
  try {
    meta = JSON.parse(row.meta_json ?? '{}');
  } catch {
    /* ignore */
  }
  return {
    mediaId: row.media_id,
    kind: row.kind,
    file: row.file,
    url: row.url,
    originalName: row.original_name,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    durationSec: row.duration_sec,
    folder: row.folder,
    contentId: row.content_id,
    parentId: row.parent_id,
    meta,
    createdAt: row.created_at,
  };
}

export function getMedia(mediaId) {
  return rowToMedia(db.prepare('SELECT * FROM media WHERE media_id = ?').get(mediaId));
}

export function listMedia({ folder, kind, contentId, limit = 300 } = {}) {
  const where = [];
  const args = [];
  if (folder) {
    where.push('folder = ?');
    args.push(folder);
  }
  if (kind) {
    where.push('kind = ?');
    args.push(kind);
  }
  if (contentId) {
    where.push('content_id = ?');
    args.push(contentId);
  }
  const sql = `SELECT * FROM media ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
  return db
    .prepare(sql)
    .all(...args, limit)
    .map(rowToMedia);
}

export function deleteMedia(mediaId) {
  const media = getMedia(mediaId);
  if (!media) return { removed: false };
  db.prepare('DELETE FROM media WHERE media_id = ? OR parent_id = ?').run(mediaId, mediaId);
  db.prepare('DELETE FROM transcript WHERE media_id = ?').run(mediaId);
  for (const file of [media.file]) {
    try {
      if (file.startsWith(MEDIA_DIR)) fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
  return { removed: true };
}

/** Walk a folder on disk and index every file, for the asset-library import. */
export function importFolder(folderAbsPath, { folder = 'incoming', contentId = null } = {}) {
  const root = path.resolve(folderAbsPath);
  if (!fs.existsSync(root)) {
    throw Object.assign(new Error(`پوشه پیدا نشد: ${folderAbsPath}`), { status: 404, code: 'NOT_FOUND' });
  }
  const known = new Set(db.prepare('SELECT file FROM media').all().map((r) => r.file));
  const imported = [];
  const skipped = [];

  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const kind = MEDIA_KINDS[ext];
      if (!kind) {
        skipped.push(entry.name);
        continue;
      }
      if (known.has(full)) continue;
      const stat = fs.statSync(full);
      imported.push(
        insertMedia({
          kind,
          file: full,
          url: mediaUrlFor(path.relative(MEDIA_DIR, full)),
          originalName: entry.name,
          mime: MIME[ext] ?? 'application/octet-stream',
          bytes: stat.size,
          folder,
          contentId,
          meta: { importedFrom: root, importedAt: nowIso() },
        })
      );
    }
  };
  walk(root);
  logEvent('INFO', 'media', `ورود دارایی‌ها: ${imported.length} فایل از ${folderAbsPath}`);
  return { imported: imported.length, skipped: skipped.length, items: imported };
}

const MEDIA_KINDS = {
  '.mp4': 'video', '.mov': 'video', '.webm': 'video', '.mkv': 'video', '.avi': 'video', '.m4v': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio', '.ogg': 'audio', '.aac': 'audio', '.flac': 'audio',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.avif': 'image',
  '.svg': 'image',
  '.pdf': 'document', '.json': 'document', '.md': 'document', '.txt': 'document',
  '.xlsx': 'document', '.csv': 'document', '.docx': 'document', '.pptx': 'document',
};

const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.json': 'application/json',
  '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv',
};

export const MEDIA_EXTENSIONS = MEDIA_KINDS;

/* ────────────────────────── save an upload ────────────────────────── */

export async function saveUpload(buffer, originalName, { folder = 'incoming', mime = '' } = {}) {
  const name = safeName(originalName);
  const target = uniquePath(folder, name);
  await fsp.writeFile(target, buffer);
  const ext = path.extname(name).toLowerCase();
  const kind = MEDIA_KINDS[ext] ?? 'document';
  const info = kind === 'video' || kind === 'audio' ? await probe(target) : { bytes: buffer.length };
  return insertMedia({
    kind,
    file: target,
    url: mediaUrlFor(path.relative(MEDIA_DIR, target)),
    originalName: name,
    mime: mime || MIME[ext] || 'application/octet-stream',
    bytes: buffer.length,
    width: info.width ?? null,
    height: info.height ?? null,
    durationSec: info.durationSec ?? null,
    folder,
    meta: { probed: info },
  });
}

/* ────────────────────────── transcripts ────────────────────────── */

export function saveTranscript(mediaId, transcript) {
  const parsed = Transcript.parse(transcript);
  db.prepare(
    `INSERT INTO transcript (media_id, language, duration_sec, cues_json, source, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(media_id) DO UPDATE SET
       language=excluded.language, duration_sec=excluded.duration_sec,
       cues_json=excluded.cues_json, source=excluded.source, created_at=excluded.created_at`
  ).run(mediaId, parsed.language, parsed.duration_sec, JSON.stringify(parsed.cues), parsed.source, nowIso());
  return parsed;
}

export function getTranscript(mediaId) {
  const row = db.prepare('SELECT * FROM transcript WHERE media_id = ?').get(mediaId);
  if (!row) return null;
  let cues = [];
  try {
    cues = JSON.parse(row.cues_json);
  } catch {
    /* ignore */
  }
  return {
    language: row.language,
    duration_sec: row.duration_sec,
    cues,
    source: row.source,
    createdAt: row.created_at,
  };
}

/**
 * Estimate timings locally when no model is available.
 *
 * This is honest about what it is: Persian word timings are *estimated* by
 * distributing words proportionally to their length across the known audio
 * duration. It produces usable subtitles; it is not speech recognition, and the
 * transcript is tagged `source: 'estimated'` so the UI can say so.
 */
export function estimateTranscript(text, durationSec) {
  const words = String(text ?? '')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || !durationSec) return { language: 'fa', duration_sec: durationSec || 0, cues: [], source: 'estimated' };

  /* weight by character length so long words take proportionally longer */
  const weights = words.map((w) => Math.max(2, [...w].length));
  const total = weights.reduce((a, b) => a + b, 0);
  let t = 0;
  const timed = words.map((w, i) => {
    const dur = (weights[i] / total) * durationSec;
    const start = t;
    t += dur;
    return { word: w, start: Math.round(start * 100) / 100, end: Math.round(t * 100) / 100, confidence: null };
  });

  /* group into cues of ~5 words or ~2.5s, whichever comes first */
  const cues = [];
  let bucket = [];
  for (const w of timed) {
    bucket.push(w);
    const span = bucket.at(-1).end - bucket[0].start;
    if (bucket.length >= 5 || span >= 2.5) {
      cues.push({
        start: bucket[0].start,
        end: bucket.at(-1).end,
        text: bucket.map((b) => b.word).join(' '),
        words: bucket,
      });
      bucket = [];
    }
  }
  if (bucket.length) {
    cues.push({ start: bucket[0].start, end: bucket.at(-1).end, text: bucket.map((b) => b.word).join(' '), words: bucket });
  }
  return { language: 'fa', duration_sec: durationSec, cues, source: 'estimated' };
}

/* ────────────────────────── subtitle rendering ────────────────────────── */

const escapeFilter = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,');

/** Seconds -> ffmpeg/TTML timestamp HH:MM:SS,mmm */
export function toTimestamp(sec) {
  const total = Math.max(0, Number(sec) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** Build an SRT file from cues (used for download and for hardsub). */
export function buildSrt(cues) {
  return cues
    .map((cue, i) => `${i + 1}\n${toTimestamp(cue.start)} --> ${toTimestamp(cue.end)}\n${cue.text}\n`)
    .join('\n');
}

/** Build a TTML/DFXP for soft subtitles some platforms prefer. */
export function buildVtt(cues) {
  const ts = (sec) => toTimestamp(sec).replace(',', '.');
  return `WEBVTT\n\n${cues
    .map((cue) => `${ts(cue.start)} --> ${ts(cue.end)}\n${cue.text}\n`)
    .join('\n')}`;
}

/**
 * Burn subtitles into the video with ffmpeg's ASS renderer.
 *
 * A styled ASS file is generated rather than using a simple `subtitles=` filter
 * because ASS gives per-cue positioning, an outline and a background pill —
 * which is what makes Persian subtitles readable over busy footage.
 */
export async function burnSubtitles(videoFile, cues, styleInput = {}) {
  const style = SubtitleStyle.parse(styleInput);
  const dir = ensureDir(path.join(path.dirname(videoFile), '.subs'));
  const assPath = path.join(dir, `${path.basename(videoFile, path.extname(videoFile))}.ass`);

  const alignment = { bottom: 2, center: 5, top: 8 }[style.position] ?? 2;
  const hex = (c) => `&H${c.replace('#', '').match(/../g).reverse().join('')}&`;
  const primary = hex(style.color);
  const outline = hex(style.outline);
  const back = style.pill ? '&H80000000' : '&H00000000';

  const header = `[Script Info]
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: AtoZ,Vazirmatn,${style.fontSize},${primary},${primary},${outline},${back},-1,0,0,0,100,100,0,0,${style.pill ? 3 : 1},${style.outlineWidth},1,${alignment},72,72,${style.position === 'top' ? 120 : 160},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const assTime = (sec) => {
    const t = Math.max(0, Number(sec) || 0);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const cs = Math.round((t - Math.floor(t)) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  const lines = [];
  for (const cue of cues) {
    const text = style.uppercase ? cue.text.toUpperCase() : cue.text;
    if (style.karaoke && Array.isArray(cue.words) && cue.words.length) {
      /* one dialogue line per word: word-by-word reveal */
      for (const w of cue.words) {
        lines.push(`Dialogue: 0,${assTime(w.start)},${assTime(w.end)},AtoZ,,0,0,0,,${w.word}`);
      }
    } else {
      lines.push(`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},AtoZ,,0,0,0,,${text.replace(/\n/g, '\\N')}`);
    }
  }

  await fsp.writeFile(assPath, header + lines.join('\n'), 'utf8');

  const out = path.join(path.dirname(videoFile), `${path.basename(videoFile, path.extname(videoFile))}.subtitled.mp4`);
  await exec(
    FFMPEG,
    ['-y', '-i', videoFile, '-vf', `ass=${assPath.replace(/\\/g, '/').replace(/:/g, '\\:')}`, '-c:v', 'libx264', '-crf', '22', '-preset', 'veryfast', '-c:a', 'copy', '-movflags', '+faststart', out],
    { timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024 }
  );
  const info = await probe(out);
  return { file: out, bytes: fs.statSync(out).size, srt: buildSrt(cues), vtt: buildVtt(cues), style, ...info };
}

/* ────────────────────────── helpers ────────────────────────── */

export function mediaStats() {
  const rows = db.prepare('SELECT folder, kind, COUNT(*) AS n, SUM(bytes) AS bytes FROM media GROUP BY folder, kind').all();
  const total = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM media').get();
  return { total, byFolder: rows };
}

export { MEDIA_DIR, FFMPEG, FFPROBE };
