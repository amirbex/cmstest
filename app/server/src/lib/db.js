/**
 * SQLite data layer (node:sqlite, built in from Node 22.5 — no native build).
 *
 * Replaces the v5.0 "read whole JSON file / write whole JSON file" pattern that
 * lost data under concurrency. Everything runs in WAL mode with an explicit
 * transaction helper, so a render finishing mid-edit can no longer clobber it.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.ATOZ_DATA_DIR || path.resolve('storage/data');
const DB_FILE = path.join(DATA_DIR, 'atoz.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

/* ────────────────────────── schema ────────────────────────── */

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS content (
  content_id       TEXT PRIMARY KEY,
  batch_id         TEXT NOT NULL DEFAULT 'ATZ-B-CUSTOM',
  title            TEXT NOT NULL,
  section_code     TEXT NOT NULL DEFAULT 'Library',
  deliverable_type TEXT NOT NULL DEFAULT 'reel',
  status           TEXT NOT NULL DEFAULT 'blueprint_pending',
  funnel_stage     TEXT NOT NULL DEFAULT 'MOFU',
  schedule_key     TEXT NOT NULL DEFAULT '',
  plan_json        TEXT NOT NULL,
  revision         INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_status  ON content(status);
CREATE INDEX IF NOT EXISTS idx_content_batch   ON content(batch_id);
CREATE INDEX IF NOT EXISTS idx_content_section ON content(section_code);

CREATE TABLE IF NOT EXISTS delivery (
  delivery_id      TEXT PRIMARY KEY,
  content_id       TEXT NOT NULL REFERENCES content(content_id) ON DELETE CASCADE,
  platform         TEXT NOT NULL DEFAULT 'instagram',
  schedule_key     TEXT NOT NULL DEFAULT '',
  scheduled_for    TEXT,
  status           TEXT NOT NULL DEFAULT 'blueprint_pending',
  platform_post_id TEXT,
  rollover_count   INTEGER NOT NULL DEFAULT 0,
  metrics_json     TEXT NOT NULL DEFAULT '{}',
  kpis_json        TEXT NOT NULL DEFAULT '{}',
  published_at     TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_content  ON delivery(content_id);
CREATE INDEX IF NOT EXISTS idx_delivery_date     ON delivery(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_delivery_status   ON delivery(status);

CREATE TABLE IF NOT EXISTS asset (
  asset_id   TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content(content_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  file       TEXT NOT NULL,
  url        TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  width      INTEGER,
  height     INTEGER,
  duration_sec REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_content ON asset(content_id);

CREATE TABLE IF NOT EXISTS job (
  job_id       TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  content_id   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  progress     REAL NOT NULL DEFAULT 0,
  step         TEXT NOT NULL DEFAULT '',
  error        TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json  TEXT NOT NULL DEFAULT '[]',
  priority     INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT,
  finished_at  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_status ON job(status, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS notification (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT NOT NULL DEFAULT 'info',
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_prompt (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_cast (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT '',
  engine       TEXT NOT NULL DEFAULT 'auto',
  sample_file  TEXT NOT NULL DEFAULT '',
  prompt_style TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quota_usage (
  day        TEXT NOT NULL,
  model      TEXT NOT NULL,
  requests   INTEGER NOT NULL DEFAULT 0,
  tokens     INTEGER NOT NULL DEFAULT 0,
  cost_usd   REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model)
);

CREATE TABLE IF NOT EXISTS agent_run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL,
  model       TEXT NOT NULL,
  status      TEXT NOT NULL,
  prompt_len  INTEGER NOT NULL DEFAULT 0,
  output_len  INTEGER NOT NULL DEFAULT 0,
  tokens      INTEGER NOT NULL DEFAULT 0,
  latency_ms  INTEGER NOT NULL DEFAULT 0,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_run_created ON agent_run(created_at DESC);

CREATE TABLE IF NOT EXISTS puzzle_block (
  period_code TEXT PRIMARY KEY,
  batch_id    TEXT NOT NULL,
  month       INTEGER NOT NULL DEFAULT 1,
  week        INTEGER NOT NULL DEFAULT 1,
  part        INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'waiting_upload',
  ideas_count INTEGER NOT NULL DEFAULT 0,
  deliveries_count INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT
);

/* ═══════════════ v7.0 — content-ops model ═══════════════ */

/* Real plan ideas replace the simplified content row: one idea -> many
   deliveries -> many assets, plus per-delivery snapshots and quality scores. */
CREATE TABLE IF NOT EXISTS idea (
  content_id     TEXT PRIMARY KEY,
  batch_id       TEXT NOT NULL,
  title          TEXT NOT NULL,
  pillar         TEXT NOT NULL DEFAULT '',
  thread         TEXT NOT NULL DEFAULT '',
  section_code   TEXT NOT NULL DEFAULT 'Library',
  personas_json  TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'idea',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idea_batch   ON idea(batch_id);
CREATE INDEX IF NOT EXISTS idx_idea_status  ON idea(status);

/* A plan asset is a *specification*; rendered files live in the asset table. */
CREATE TABLE IF NOT EXISTS plan_asset (
  asset_id            TEXT PRIMARY KEY,
  content_id          TEXT NOT NULL REFERENCES idea(content_id) ON DELETE CASCADE,
  asset_type          TEXT NOT NULL DEFAULT '',
  name                TEXT NOT NULL DEFAULT '',
  storage_location    TEXT NOT NULL DEFAULT '',
  subfile_codes_json  TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_asset_content ON plan_asset(content_id);

CREATE TABLE IF NOT EXISTS publish (
  delivery_id       TEXT PRIMARY KEY,
  content_id        TEXT NOT NULL REFERENCES idea(content_id) ON DELETE CASCADE,
  batch_id          TEXT NOT NULL,
  schedule_key      TEXT NOT NULL,
  platform          TEXT NOT NULL,
  format_code       TEXT NOT NULL DEFAULT 'SNG',
  format_type       TEXT NOT NULL DEFAULT '',
  day_of_week       TEXT NOT NULL DEFAULT '',
  time_slot         TEXT NOT NULL DEFAULT '09:00',
  funnel_stage      TEXT NOT NULL DEFAULT 'MOFU',
  content_pillar    TEXT NOT NULL DEFAULT '',
  cta_target_id     TEXT,
  platform_post_id  TEXT,
  publish_status    TEXT NOT NULL DEFAULT 'planned',
  scheduled_for     TEXT,
  asset_ids_json    TEXT NOT NULL DEFAULT '[]',
  positioning_json  TEXT NOT NULL DEFAULT '{}',
  visual_json       TEXT NOT NULL DEFAULT '{}',
  content_json      TEXT NOT NULL DEFAULT '{}',
  quality_json      TEXT NOT NULL DEFAULT '{}',
  rollover_count    INTEGER NOT NULL DEFAULT 0,
  published_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publish_content  ON publish(content_id);
CREATE INDEX IF NOT EXISTS idx_publish_date     ON publish(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_publish_status   ON publish(publish_status);
CREATE INDEX IF NOT EXISTS idx_publish_platform ON publish(platform);

/* Three fixed windows per publish: 24h, 7d, 30d. */
CREATE TABLE IF NOT EXISTS snapshot (
  delivery_id    TEXT NOT NULL REFERENCES publish(delivery_id) ON DELETE CASCADE,
  window_key     TEXT NOT NULL,
  captured_at    TEXT,
  raw_json       TEXT NOT NULL DEFAULT '{}',
  kpis_json      TEXT NOT NULL DEFAULT '{}',
  source         TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (delivery_id, window_key)
);

/* Non-destructive edit documents, one active doc per (contentId,target). */
CREATE TABLE IF NOT EXISTS edit_doc (
  content_id  TEXT NOT NULL,
  target      TEXT NOT NULL,
  doc_json    TEXT NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (content_id, target)
);

/* v7.0 edit documents: one per delivery, holding the full editable concept
   (scenes, timings, copy) that the editor canvas renders and the renderer reads.
   Separate from the legacy edit_doc above, which was keyed by content+target. */
CREATE TABLE IF NOT EXISTS edit_document (
  doc_id        TEXT PRIMARY KEY,
  delivery_id   TEXT NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  aspect        TEXT NOT NULL,
  duration_sec  REAL NOT NULL,
  doc_json      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edit_document_delivery ON edit_document(delivery_id);

/* Media library: everything the user uploads or the engine produces. */
CREATE TABLE IF NOT EXISTS media (
  media_id      TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'video',
  file          TEXT NOT NULL,
  url           TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  mime          TEXT NOT NULL DEFAULT '',
  bytes         INTEGER NOT NULL DEFAULT 0,
  width         INTEGER,
  height        INTEGER,
  duration_sec  REAL,
  folder        TEXT NOT NULL DEFAULT 'incoming',
  content_id    TEXT,
  parent_id     TEXT,
  meta_json     TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_folder  ON media(folder);
CREATE INDEX IF NOT EXISTS idx_media_content ON media(content_id);
CREATE INDEX IF NOT EXISTS idx_media_parent  ON media(parent_id);

/* Transcripts produced from video/audio, with word-level timing. */
CREATE TABLE IF NOT EXISTS transcript (
  media_id     TEXT PRIMARY KEY REFERENCES media(media_id) ON DELETE CASCADE,
  language     TEXT NOT NULL DEFAULT 'fa',
  duration_sec REAL NOT NULL DEFAULT 0,
  cues_json    TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'gemini',
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT NOT NULL,
  source     TEXT NOT NULL,
  message    TEXT NOT NULL,
  details    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_log_created ON event_log(created_at DESC);
`);

/* ────────────────────────── helpers ────────────────────────── */

export function nowIso() {
  return new Date().toISOString();
}

let txDepth = 0;
/** Run `fn` inside a single SQLite transaction (re-entrant). */
export function tx(fn) {
  if (txDepth > 0) return fn();
  txDepth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  } finally {
    txDepth--;
  }
}

export function nextCounter(name) {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name);
  const value = (row?.value ?? 0) + 1;
  db.prepare(
    'INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value'
  ).run(name, value);
  return value;
}

export function peekCounter(name) {
  return db.prepare('SELECT value FROM counters WHERE name = ?').get(name)?.value ?? 0;
}

export function getMeta(key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setMeta(key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}

export function notify(level, message) {
  db.prepare('INSERT INTO notification (level, message, created_at) VALUES (?, ?, ?)').run(
    level,
    message,
    nowIso()
  );
  db.exec('DELETE FROM notification WHERE id NOT IN (SELECT id FROM notification ORDER BY id DESC LIMIT 50)');
}

export function logEvent(level, source, message, details = null) {
  db.prepare('INSERT INTO event_log (level, source, message, details, created_at) VALUES (?, ?, ?, ?, ?)').run(
    level.toUpperCase(),
    source,
    message,
    details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null,
    nowIso()
  );
  db.exec(
    'DELETE FROM event_log WHERE id NOT IN (SELECT id FROM event_log ORDER BY id DESC LIMIT 1000)'
  );
}

export const DB_PATH = DB_FILE;
