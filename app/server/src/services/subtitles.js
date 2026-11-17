/**
 * Subtitle agent — Gemini word-level transcription with an honest fallback.
 *
 * The user's requested flow, exactly:
 *   1. compress the upload  (media.compress)
 *   2. send the audio to Gemini with a strict timestamped schema
 *   3. feed the returned word timings into *our* engine
 *   4. burn the result with ffmpeg
 *
 * Steps 1, 3 and 4 are entirely local. Only step 2 needs a model, and when no
 * model is available we estimate timings locally and label the result as an
 * estimate rather than pretending it is transcription.
 */
import fs from 'node:fs';
import { z } from 'zod';
import { TranscriptCue } from '@atoz/contracts';
import { db, nowIso, logEvent } from '../lib/db.js';
import { askJson } from './ai.js';

/**
 * The schema Gemini is constrained to. Kept deliberately flat and word-level:
 * asking for one object per word is the most reliable way to get exact timings,
 * because the model has to commit to a number for every token.
 */
export const TranscriptSchema = z.object({
  language: z.string().max(8).default('fa'),
  duration_sec: z.number().nonnegative(),
  cues: z
    .array(
      z.object({
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
        text: z.string().min(1).max(400),
        words: z
          .array(
            z.object({
              word: z.string().min(1).max(60),
              start: z.number().nonnegative(),
              end: z.number().nonnegative(),
            })
          )
          .max(60)
          .default([]),
      })
    )
    .min(1)
    .max(400),
});

const SUBTITLE_SKILL = `تو یک موتور رونویسی حرفه‌ای فارسی هستی.
قواعد سخت‌گیرانه:
۱. دقیقاً همان کلماتی را بنویس که شنیده می‌شود؛ هیچ کلمه‌ای اضافه یا حذف نکن.
۲. هر کلمه باید start و end به ثانیه داشته باشد، با دقت دو رقم اعشار.
۳. کلمات نباید هم‌پوشانی داشته باشند: end هر کلمه ≤ start کلمه بعدی.
۴. جمله‌ها را در cues گروه‌بندی کن: حداکثر ۵ کلمه یا ۲.۵ ثانیه در هر cue.
۵. متن باید فارسی طبیعی با نیم‌فاصله صحیح باشد.
۶. اگر بخشی از صدا نامفهوم است، آن را با «...» علامت بزن، از خودت نساز.
۷. اعداد را با ارقام فارسی بنویس.
خروجی فقط JSON معتبر مطابق اسکیمای داده‌شده باشد.`;

/**
 * Ask Gemini for a word-level transcript of an audio file.
 * Returns null when no model is available, so the caller can fall back.
 */
export async function transcribeWithGemini(audioFile, { durationSec = null } = {}) {
  if (!fs.existsSync(audioFile)) {
    throw Object.assign(new Error('فایل صوتی پیدا نشد'), { status: 404, code: 'NOT_FOUND' });
  }
  const bytes = fs.statSync(audioFile).size;
  /* inline audio caps at 20 MB on the Gemini API; we always send the extracted
     16 kHz mono track, which is far smaller, but guard anyway */
  if (bytes > 19 * 1024 * 1024) {
    throw Object.assign(new Error('فایل صوتی برای ارسال بزرگ است'), { status: 413, code: 'TOO_LARGE' });
  }

  const base64 = fs.readFileSync(audioFile).toString('base64');
  const prompt = `${SUBTITLE_SKILL}

مدت فایل حدوداً ${durationSec ? `${durationSec} ثانیه` : 'نامشخص'} است.
کل صدا را از ابتدا تا انتها رونویسی کن.

خروجی JSON:
{"language":"fa","duration_sec":0,"cues":[{"start":0,"end":0,"text":"...","words":[{"word":"...","start":0,"end":0}]}]}`;

  const { data, model } = await askJson({
    schema: TranscriptSchema,
    prompt,
    agentId: 'SUBTITLE_ENGINEER',
    label: 'زیرنویس خودکار',
    temperature: 0.1,
    /* multimodal inline part: the SDK accepts a contents array */
    audio: { file: audioFile, base64, mime: 'audio/mp3' },
  });

  if (!data) return null;

  /* sanitise: enforce monotonic, non-overlapping timings before anything is
     rendered — a model that returns an end past the next start would produce
     flickering subtitles */
  let previousEnd = 0;
  const cues = data.cues
    .map((cue) => {
      const start = Math.max(previousEnd, round2(cue.start));
      const end = Math.max(start + 0.2, round2(cue.end));
      previousEnd = end;
      const words = (cue.words ?? [])
        .map((w) => ({
          word: w.word,
          start: clampWithin(round2(w.start), start, end),
          end: clampWithin(round2(w.end), start + 0.1, end),
          confidence: null,
        }))
        .sort((a, b) => a.start - b.start);
      return { start, end, text: cue.text.trim(), words };
    })
    .filter((cue) => cue.text.length > 0);

  if (!cues.length) return null;

  logEvent('INFO', 'subtitle', `رونویسی با ${model}: ${cues.length} cue`);
  return {
    language: data.language ?? 'fa',
    duration_sec: data.duration_sec || durationSec || cues.at(-1).end,
    cues,
    source: 'gemini',
    model,
  };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const clampWithin = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Validate a model-produced transcript before rendering.
 * Returns { ok, cues, issues } rather than throwing, so the UI can show what
 * was wrong and let the user fix it in the editor.
 */
export function validateTranscript(raw) {
  const parsed = TranscriptCue.array().safeParse(raw);
  if (!parsed.success) {
    return { ok: false, cues: [], issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const issues = [];
  let last = 0;
  for (const [i, cue] of parsed.data.entries()) {
    if (cue.start < last - 0.05) issues.push(`cue ${i}: با cue قبلی هم‌پوشانی دارد`);
    if (cue.end <= cue.start) issues.push(`cue ${i}: پایان قبل از شروع است`);
    last = cue.end;
  }
  return { ok: issues.length === 0, cues: parsed.data, issues };
}

export function transcriptToSrt(cues) {
  const ts = (sec) => {
    const t = Math.max(0, Number(sec) || 0);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.round((t - Math.floor(t)) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n');
}

export { nowIso };
