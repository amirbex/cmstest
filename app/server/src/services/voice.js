/**
 * Voice service — offline-first TTS with an honest engine chain.
 *
 * v5.0 "supported" local TTS but its last resort was PowerShell/Windows SAPI,
 * which made the whole feature break on Linux/macOS and in containers. The
 * chain here degrades cleanly and always reports which engine actually spoke:
 *
 *   1. piper      — fully offline neural Persian (bundled binary expected in
 *                   bin/piper; best quality, no network)
 *   2. edge-tts   — free Microsoft neural voices, needs internet, very good
 *   3. pyttsx3    — offline system voices (espeak-ng on Linux, SAPI on Windows)
 *   4. silent     — explicit, reported failure instead of a fake empty file
 *
 * Captions: if the engine can give us word timings we use them; otherwise we
 * synthesise per-word timings from the audio duration (labelled as estimated,
 * never passed off as karaoke-accurate).
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { logEvent } from '../lib/db.js';

const execFileAsync = promisify(execFile);
const AUDIO_DIR = path.resolve(process.env.ATOZ_AUDIO_DIR || 'storage/outputs/audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const PY = process.env.ATOZ_PYTHON || 'python3';

function slug(text) {
  return Buffer.from(text.slice(0, 24)).toString('hex').slice(0, 12);
}

/** Split a Persian script into caption words. ZWNJ stays glued. */
export function splitWords(text) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/** Even-time word captions — explicitly marked as estimated. */
export function estimateCaptions(text, durationSec) {
  const words = splitWords(text);
  if (!words.length) return [];
  const per = durationSec / words.length;
  return words.map((w, i) => ({
    text: w,
    start: +(i * per).toFixed(3),
    end: +((i + 1) * per).toFixed(3),
  }));
}

function probeDuration(file) {
  return new Promise((resolve) => {
    try {
      const ffprobe = require_ffprobe();
      if (!ffprobe) return resolve(null);
      execFile(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], (err, out) => {
        if (err) return resolve(null);
        const value = Number(String(out).trim());
        resolve(Number.isFinite(value) ? +value.toFixed(2) : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function require_ffprobe() {
  // ffprobe ships alongside ffmpeg in the static installer bundle (ffmpeg can
  // decode durations itself), so we fall back to parsing ffmpeg output.
  return process.env.ATOZ_FFPROBE || null;
}

/** Read duration from the static ffmpeg binary's stderr (no ffprobe needed). */
async function ffmpegDuration(file) {
  const ffmpeg = (await import('../engine/renderer.js')).getFfmpegPath();
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ['-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let out = '';
    child.stderr.on('data', (c) => (out += c.toString()));
    child.on('close', () => {
      const m = out.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      resolve(m ? +(+m[1] * 3600 + +m[2] * 60 + +m[3]).toFixed(2) : null);
    });
    child.on('error', () => resolve(null));
  });
}

/* ────────────────────────── engines ────────────────────────── */

async function tryPiper(scriptText, outFile) {
  const bin = process.env.ATOZ_PIPER || path.resolve('bin/piper');
  const model = process.env.ATOZ_PIPER_MODEL || path.resolve('bin/fa_IR-amir-medium.onnx');
  if (!fs.existsSync(bin) || !fs.existsSync(model)) return null;

  return new Promise((resolve) => {
    const child = spawn(bin, ['--model', model, '--output_file', outFile], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && fs.existsSync(outFile) ? { engine: 'piper (آفلاین)' } : null));
    child.stdin.end(scriptText);
    setTimeout(() => child.kill('SIGKILL'), 90_000);
    void err;
  });
}

async function tryEdge(scriptText, outFile) {
  const voice = process.env.ATOZ_EDGE_VOICE || 'fa-IR-FaridNeural';
  try {
    const { stdout } = await execFileAsync(
      PY,
      ['-c', EDGE_SCRIPT, scriptText, voice, outFile],
      { timeout: 60_000, maxBuffer: 1_000_000 }
    );
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 2048) {
      let words = null;
      try {
        words = JSON.parse(stdout.trim().split('\n').pop() || 'null');
      } catch {
        words = null;
      }
      return { engine: 'edge-tts (شبکه)', words };
    }
    return null;
  } catch (err) {
    logEvent('WARN', 'voice', `edge-tts در دسترس نیست: ${String(err.message).slice(0, 160)}`);
    return null;
  }
}

const EDGE_SCRIPT = `
import sys, json, asyncio, re
text, voice, out = sys.argv[1], sys.argv[2], sys.argv[3]
async def main():
    import edge_tts
    comm = edge_tts.Communicate(text, voice)
    words = []
    with open(out, "wb") as fh:
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                fh.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                words.append({
                    "text": chunk.get("text", ""),
                    "start": round(chunk["offset"] / 1e7, 3),
                    "end": round((chunk["offset"] + chunk["duration"]) / 1e7, 3),
                })
    print(json.dumps(words, ensure_ascii=False))
asyncio.run(main())
`;

async function tryPyttsx3(scriptText, outFile) {
  const target = outFile.replace(/\.[a-z0-9]+$/i, '.wav');
  try {
    await execFileAsync(PY, ['-c', PYTTSX_SCRIPT, scriptText, target], { timeout: 90_000 });
    if (fs.existsSync(target) && fs.statSync(target).size > 2048) {
      return { engine: 'pyttsx3 (آفلاین سیستم)', file: target };
    }
    return null;
  } catch {
    return null;
  }
}

const PYTTSX_SCRIPT = `
import sys
text, out = sys.argv[1], sys.argv[2]
import pyttsx3
eng = pyttsx3.init()
try:
    for v in eng.getProperty("voices"):
        langs = " ".join(v.languages if isinstance(v.languages, list) else [str(v.languages)])
        if "fa" in str(v.id).lower() or "iran" in str(v.name).lower() or "fa" in langs.lower():
            eng.setProperty("voice", v.id)
            break
except Exception:
    pass
eng.setProperty("rate", 170)
eng.save_to_file(text, out)
eng.runAndWait()
`;

/* ────────────────────────── public API ────────────────────────── */

/**
 * @returns {Promise<{ok:boolean, engine:string, file:string|null, url:string|null,
 *   durationSec:number, words:Array, estimatedCaptions:boolean, error?:string}>}
 */
export async function synthesizeVoice({ scriptText, engine = 'auto', contentId = 'adhoc', voiceSample = null }) {
  if (!scriptText?.trim()) {
    return { ok: false, engine: 'none', file: null, url: null, durationSec: 0, words: [], estimatedCaptions: false, error: 'متن نریشن خالی است' };
  }

  const base = `VOICE-${contentId}-${slug(scriptText)}-${Date.now().toString(36)}`;
  const mp3 = path.join(AUDIO_DIR, `${base}.mp3`);
  const order =
    engine === 'auto'
      ? ['piper', 'edge', 'pyttsx3']
      : engine === 'system'
        ? ['pyttsx3']
        : [engine];

  for (const candidate of order) {
    let result = null;
    if (candidate === 'piper') result = await tryPiper(scriptText, mp3.replace(/\.mp3$/, '.wav'));
    if (candidate === 'edge') result = await tryEdge(scriptText, mp3);
    if (candidate === 'pyttsx3' || candidate === 'system' || candidate === 'espeak') result = await tryPyttsx3(scriptText, mp3);

    if (result) {
      const file = result.file ?? mp3;
      const durationSec = (await ffmpegDuration(file)) ?? Math.max(2, scriptText.length / 14);
      const words = Array.isArray(result.words) && result.words.length ? result.words : estimateCaptions(scriptText, durationSec);
      logEvent('INFO', 'voice', `صدا با ${result.engine} ساخته شد (${durationSec}s)`);
      return {
        ok: true,
        engine: result.engine,
        file,
        url: `/media/audio/${path.basename(file)}`,
        durationSec,
        words,
        estimatedCaptions: !(Array.isArray(result.words) && result.words.length),
      };
    }
  }

  const error =
    'هیچ موتور صدای آفلاینی پیدا نشد. برای صدای کامل آفلاین، bin/piper و مدل فارسی آن را در پوشه‌ی bin بگذارید، یا وابستگی‌های python-engine را نصب کنید.';
  logEvent('WARN', 'voice', error);
  return { ok: false, engine: 'none', file: null, url: null, durationSec: 0, words: [], estimatedCaptions: false, error };
}

export async function listVoiceEngines() {
  const bin = process.env.ATOZ_PIPER || path.resolve('bin/piper');
  const model = process.env.ATOZ_PIPER_MODEL || path.resolve('bin/fa_IR-amir-medium.onnx');
  let edge = false;
  try {
    await execFileAsync(PY, ['-c', 'import edge_tts'], { timeout: 8000 });
    edge = true;
  } catch {
    edge = false;
  }
  let pyttsx = false;
  try {
    await execFileAsync(PY, ['-c', 'import pyttsx3'], { timeout: 8000 });
    pyttsx = true;
  } catch {
    pyttsx = false;
  }
  return [
    { id: 'piper', label: 'Piper (آفلاین، کیفیت بالا)', available: fs.existsSync(bin) && fs.existsSync(model) },
    { id: 'edge', label: 'Edge Neural (نیازمند شبکه)', available: edge },
    { id: 'pyttsx3', label: 'صدای سیستم (آفلاین)', available: pyttsx },
  ];
}

export async function computeDuration(file) {
  return (await ffmpegDuration(file)) ?? (await probeDuration(file));
}

export { AUDIO_DIR };
