/**
 * Media & subtitle routes.
 *
 * Upload is raw-binary (so a 200 MB phone clip doesn't get base64-bloated), or
 * multipart when the browser sends a form. Everything after that is JSON.
 */
import { bad, notFound, HttpError } from '../lib/http.js';
import {
  saveUpload,
  listMedia,
  getMedia,
  deleteMedia,
  compress,
  probe,
  extractAudio,
  importFolder,
  mediaStats,
  saveTranscript,
  getTranscript,
  estimateTranscript,
  burnSubtitles,
  buildSrt,
  buildVtt,
  MEDIA_DIR,
  FOLDERS,
} from '../services/media.js';
import { transcribeWithGemini, validateTranscript } from '../services/subtitles.js';
import path from 'node:path';
import fs from 'node:fs';
import { SubtitleStyle, Transcript } from '@atoz/contracts';

const MAX_UPLOAD = Number(process.env.ATOZ_MAX_UPLOAD_MB ?? 512) * 1024 * 1024;

/**
 * Store one upload and optionally compress it.
 * Compression is best-effort: a failure must never lose the original file.
 */
async function ingestOne({ buffer, name, mime }, query) {
  const media = await saveUpload(buffer, name, { folder: query.folder ?? 'incoming', mime });
  let compressed = null;
  if ((query.compress === '1' || query.compress === 'true') && (media.kind === 'video' || media.kind === 'audio')) {
    try {
      const result = await compress(media.file, { crf: Number(query.crf) || 26 });
      const { insertMedia } = await import('../services/media.js');
      compressed = insertMedia({
        kind: media.kind,
        file: result.file,
        url: media.url.replace(/\.\w+$/, '.compressed.mp4'),
        originalName: `${path.basename(media.originalName, path.extname(media.originalName))}.compressed.mp4`,
        mime: 'video/mp4',
        bytes: result.afterBytes,
        width: result.width,
        height: result.height,
        durationSec: result.durationSec,
        folder: media.folder,
        contentId: media.contentId,
        parentId: media.mediaId,
        meta: { compressedFrom: media.mediaId, savedPct: result.savedPct, beforeBytes: result.beforeBytes },
      });
    } catch (err) {
      compressed = null;
      media.meta = { ...media.meta, compressError: String(err.message) };
    }
  }
  return { media, compressed };
}

export function registerMediaRoutes(app) {
  /* ── library ── */
  app.get('/api/media', ({ query }) => ({
    success: true,
    data: listMedia({
      folder: query.folder,
      kind: query.kind,
      contentId: query.contentId,
      limit: Number(query.limit) || 300,
    }),
  }));

  app.get('/api/media/stats', () => ({ success: true, data: mediaStats() }));

  app.get('/api/media/folders', () => ({
    success: true,
    data: FOLDERS.map((folder) => {
      const full = path.join(MEDIA_DIR, folder);
      return {
        folder,
        path: full,
        exists: fs.existsSync(full),
        files: fs.existsSync(full) ? fs.readdirSync(full).filter((f) => !f.startsWith('.')).length : 0,
      };
    }),
  }));

  app.get('/api/media/:id', ({ params }) => {
    const media = getMedia(params.id);
    if (!media) throw notFound('رسانه پیدا نشد');
    return { success: true, data: { ...media, transcript: getTranscript(params.id) } };
  });

  app.del('/api/media/:id', ({ params }) => ({ success: true, data: deleteMedia(params.id) }));

  /* ── upload ── */
  app.post('/api/media/upload', async ({ body, query, rawBody, files, req }) => {
    /* Accept three shapes: multipart (browser form/multiple files), a raw
       binary body with ?name=, or JSON {"path": "..."} for an on-disk drop. */
    const uploads = [];
    if (files?.length) {
      for (const file of files) {
        uploads.push({ buffer: file.data, name: file.filename, mime: file.contentType ?? '' });
      }
    } else if (rawBody?.length) {
      if (rawBody.length > MAX_UPLOAD) throw bad(`حجم فایل بیشتر از ${MAX_UPLOAD / 1024 / 1024} مگابایت است`);
      uploads.push({ buffer: rawBody, name: query.name ?? `upload-${Date.now()}.bin`, mime: query.mime ?? req.headers['content-type'] ?? '' });
    } else if (body?.path) {
      const abs = path.resolve(body.path);
      if (!fs.existsSync(abs)) throw notFound(`فایل پیدا نشد: ${body.path}`);
      uploads.push({ buffer: fs.readFileSync(abs), name: path.basename(abs), mime: '' });
    }
    if (!uploads.length) throw bad('فایلی دریافت نشد');

    const results = [];
    for (const upload of uploads) {
      results.push(await ingestOne(upload, query));
    }
    return { success: true, data: results.length === 1 ? results[0] : { items: results } };
  });

  /* ── re-index a folder on disk ── */
  app.post('/api/media/import', ({ body }) => {
    const folderPath = body?.path;
    if (!folderPath) throw bad('مسیر پوشه لازم است');
    return { success: true, data: importFolder(folderPath, { folder: body?.folder ?? 'incoming' }) };
  });

  /* ── probe / compress ── */
  app.post('/api/media/:id/probe', async ({ params }) => {
    const media = getMedia(params.id);
    if (!media) throw notFound('رسانه پیدا نشد');
    return { success: true, data: await probe(media.file) };
  });

  app.post('/api/media/:id/compress', async ({ params, body }) => {
    const media = getMedia(params.id);
    if (!media) throw notFound('رسانه پیدا نشد');
    const result = await compress(media.file, {
      crf: Number(body?.crf) || 26,
      maxWidth: Number(body?.maxWidth) || 1080,
      preset: body?.preset ?? 'veryfast',
    });
    const { insertMedia } = await import('../services/media.js');
    const stored = insertMedia({
      kind: media.kind,
      file: result.file,
      url: media.url.replace(/\.\w+$/, '.compressed.mp4'),
      originalName: `${path.basename(media.originalName, path.extname(media.originalName))}.compressed.mp4`,
      mime: 'video/mp4',
      bytes: result.afterBytes,
      width: result.width,
      height: result.height,
      durationSec: result.durationSec,
      folder: media.folder,
      contentId: media.contentId,
      parentId: media.mediaId,
      meta: { savedPct: result.savedPct, beforeBytes: result.beforeBytes, elapsedMs: result.elapsedMs },
    });
    return { success: true, data: { ...result, media: stored } };
  });

  /* ── subtitles ── */
  /**
   * Full auto pipeline: compress → transcribe → store.
   * `force=estimate` skips the model entirely (offline mode).
   */
  app.post('/api/media/:id/transcribe', async ({ params, body }) => {
    const media = getMedia(params.id);
    if (!media) throw notFound('رسانه پیدا نشد');

    const info = await probe(media.file);
    let source = media.file;
    if (media.kind === 'video') {
      source = info.hasAudio ? (await extractAudio(media.file)).file : media.file;
    }
    const durationSec = media.durationSec ?? info.durationSec;
    const force = body?.mode ?? 'auto';

    /* A silent clip cannot be transcribed, but it can still be captioned from a
       supplied script. Say so precisely instead of failing with an ffmpeg error. */
    if (!info.hasAudio && force !== 'estimate' && !body?.scriptText) {
      throw new HttpError(422, 'این فایل صدا ندارد. متن نریشن را وارد کن یا فایل صوتی آپلود کن.', 'NO_AUDIO_STREAM');
    }

    if (force !== 'estimate') {
      try {
        const transcript = await transcribeWithGemini(source, { durationSec });
        if (transcript) {
          const stored = saveTranscript(media.mediaId, transcript);
          return { success: true, data: { ...stored, engine: transcript.model ?? 'gemini' } };
        }
      } catch (err) {
        if (force === 'gemini') {
          throw Object.assign(new Error(`رونویسی ناموفق بود: ${err.message}`), { status: 502, code: 'AI_FAILED' });
        }
        /* fall through to the local estimate */
      }
    }

    const scriptText = body?.scriptText ?? '';
    if (!scriptText.trim()) {
      throw bad('برای حالت برآوردی، متن نریشن لازم است');
    }
    const estimated = estimateTranscript(scriptText, durationSec);
    const stored = saveTranscript(media.mediaId, estimated);
    return { success: true, data: { ...stored, engine: 'local-estimate' } };
  });

  /** Save a hand-edited transcript (from the editor). */
  app.put('/api/media/:id/transcript', ({ params, body }) => {
    const media = getMedia(params.id);
    if (!media) throw notFound('رسانه پیدا نشد');
    const check = validateTranscript(body?.cues ?? []);
    if (!check.cues.length) throw bad('زیرنویس نامعتبر است');
    const stored = saveTranscript(media.mediaId, {
      language: body?.language ?? 'fa',
      duration_sec: body?.duration_sec ?? media.durationSec ?? 0,
      cues: check.cues,
      source: 'edited',
    });
    return { success: true, data: { ...stored, issues: check.issues } };
  });

  app.get('/api/media/:id/transcript', ({ params, query }) => {
    const transcript = getTranscript(params.id);
    if (!transcript) throw notFound('زیرنویسی برای این رسانه ثبت نشده');
    if (query.format === 'srt') {
      return { success: true, data: { format: 'srt', body: buildSrt(transcript.cues) } };
    }
    if (query.format === 'vtt') {
      return { success: true, data: { format: 'vtt', body: buildVtt(transcript.cues) } };
    }
    return { success: true, data: transcript };
  });

  /** Burn subtitles into a new mp4. */
  app.post('/api/media/:id/subtitles', async ({ params, body }) => {
    const media = getMedia(params.id);
    if (!media) throw notFound('رسانه پیدا نشد');
    if (media.kind !== 'video') throw bad('زیرنویس سوخته فقط برای ویدیو ممکن است');

    const transcript = getTranscript(params.id);
    const cues = body?.cues ?? transcript?.cues;
    if (!cues?.length) throw bad('زیرنویس موجود نیست؛ اول رونویسی کن');

    const style = SubtitleStyle.parse(body?.style ?? {});
    const result = await burnSubtitles(media.file, cues, style);
    const { insertMedia } = await import('../services/media.js');
    const stored = insertMedia({
      kind: 'video',
      file: result.file,
      url: media.url.replace(/\.\w+$/, '.subtitled.mp4'),
      originalName: `${path.basename(media.originalName, path.extname(media.originalName))}.subtitled.mp4`,
      mime: 'video/mp4',
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      durationSec: result.durationSec,
      folder: media.folder,
      contentId: media.contentId,
      parentId: media.mediaId,
      meta: { subtitledFrom: media.mediaId, style },
    });
    return { success: true, data: { media: stored, srt: result.srt, vtt: result.vtt } };
  });
}
