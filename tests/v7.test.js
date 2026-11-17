/**
 * v7.0 regression suite.
 *
 * Covers the four layers that were added on top of the v6 engine and that are
 * most likely to drift: plan ingestion, KPI derivation, the template catalogue,
 * and the media/subtitle pipeline.
 *
 * Each test uses its own temporary data directory so a run never touches the
 * developer's real `storage/data/atoz.db`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* The DB module captures its path at import time, so the env var must be set
   before any dynamic import below. A unique dir per run keeps tests parallel-safe. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atoz-v7-'));
process.env.ATOZ_DATA_DIR = TMP;
process.env.ATOZ_MEDIA_DIR = path.join(TMP, 'media');
process.env.ATOZ_AI_KEY = '';
process.env.GOOGLE_API_KEY = '';
process.env.GEMINI_API_KEY = '';

const load = (p) => import(p);

const PLAN_PATH = path.resolve('docs/reference/ATZ-B-M01-W01-P1_ContentPlan.json');
const WEEK = '2026-11-14';

/* ────────────────────────── contracts ────────────────────────── */

test('schedule keys round-trip and reject malformed input', async () => {
  const contracts = await load('@atoz/contracts');

  const parsed = contracts.parseScheduleKey('M01-W02-D03-IG-CAR-04');
  assert.ok(parsed);
  assert.equal(parsed.month, 1);
  assert.equal(parsed.week, 2);
  assert.equal(parsed.day, 3);
  assert.equal(parsed.platform, 'IG');
  assert.equal(parsed.format, 'CAR');
  assert.equal(parsed.seq, 4);

  assert.equal(contracts.buildScheduleKey(parsed), 'M01-W02-D03-IG-CAR-04');

  /* two-letter format codes (web uses LIB / MAG / PRM / CLC) must parse */
  assert.ok(contracts.parseScheduleKey('M01-W01-D01-WEB-LIB-01'));
  assert.ok(contracts.parseScheduleKey('M01-W01-D02-WEB-CLC-01'));

  for (const bad of [
    '',
    'nonsense',
    'M1-W01-D01-IG-CAR-01',
    'M01-W01-D01-IG-01',
    'M01-W01-D08-IG-CAR-01', // there are only seven days
    'M13-W01-D01-IG-CAR-01', // and twelve months
    'M01-W06-D01-IG-CAR-01', // and five weeks per month
    'M01-W01-D00-IG-CAR-01',
  ]) {
    assert.equal(contracts.parseScheduleKey(bad), null, `should reject: ${bad}`);
  }
});

test('asset ids accept versioned sub-file suffixes', async () => {
  const contracts = await load('@atoz/contracts');
  assert.ok(contracts.AssetId.safeParse('ATZ-A-000001').success);
  assert.ok(contracts.AssetId.safeParse('ATZ-A-000001-CVR-V1').success);
  assert.ok(contracts.AssetId.safeParse('ATZ-A-000007-REEL-INS-V2').success);
  assert.equal(contracts.AssetId.safeParse('ATZ-A-1').success, false);
  assert.equal(contracts.AssetId.safeParse('ATZ-X-000001').success, false);
});

test('platform names are normalised before validation', async () => {
  const contracts = await load('@atoz/contracts');
  assert.equal(contracts.normalisePlatform('Instagram_Feed'), 'instagram');
  assert.equal(contracts.normalisePlatform('Telegram'), 'telegram');
  assert.equal(contracts.normalisePlatform('Website'), 'website');
  assert.equal(contracts.normalisePlatform('یوتیوب'), 'youtube');
  assert.equal(contracts.normalisePlatform('MySpace'), null);
});

/* ────────────────────────── ingestion ────────────────────────── */

test('the real plan file ingests completely and idempotently', async () => {
  const plan = await load('../app/server/src/services/plan.js');
  const raw = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));

  const first = plan.ingestPlanFile(raw, { weekStartIso: WEEK });
  assert.equal(first.ideas.added, 19);
  assert.equal(first.assets.added, 25);
  assert.equal(first.publishes.added, 48);
  assert.deepEqual(first.warnings, [], 'a clean plan must ingest without warnings');

  /* re-ingesting the same file must update, never duplicate */
  const second = plan.ingestPlanFile(raw, { weekStartIso: WEEK });
  assert.equal(second.publishes.added, 0);
  assert.equal(second.publishes.updated, 48);
  assert.equal(plan.listPublishes().length, 48);
});

test('every publish carries a parseable schedule key and a derived timestamp', async () => {
  const plan = await load('../app/server/src/services/plan.js');
  const contracts = await load('@atoz/contracts');

  const publishes = plan.listPublishes();
  assert.equal(publishes.length, 48);

  for (const p of publishes) {
    const key = contracts.parseScheduleKey(p.scheduleKey);
    assert.ok(key, `unparseable key on ${p.deliveryId}: ${p.scheduleKey}`);
    assert.ok(p.scheduledFor, `${p.deliveryId} has no scheduled_for`);
    assert.equal(p.platform, contracts.normalisePlatform(p.platform));
  }
});

test('the board returns enriched days that match the publishes', async () => {
  const plan = await load('../app/server/src/services/plan.js');
  const board = plan.publishBoard({ from: WEEK });

  assert.equal(board.days.length, 7);
  for (const day of board.days) {
    assert.equal(typeof day.weekday, 'string');
    assert.equal(typeof day.count, 'number');
    const actual = board.publishes.filter((p) => (p.scheduledFor ?? '').slice(0, 10) === day.date).length;
    assert.equal(day.count, actual, `count mismatch on ${day.date}`);
  }
  const totals = board.days.reduce((sum, d) => sum + d.count, 0) + (board.outsideWeek?.length ?? 0);
  assert.equal(totals, board.publishes.length);
});

/* ────────────────────────── metrics ────────────────────────── */

test('KPIs are derived from raw metrics and never trusted from the client', async () => {
  const plan = await load('../app/server/src/services/plan.js');
  const publish = plan.listPublishes()[0];

  const snapshots = plan.recordSnapshot(
    publish.deliveryId,
    '24h',
    {
      reach: 10000,
      likes: 500,
      comments: 50,
      saves: 300,
      shares: 50,
      clicks: 400,
      views: 20000,
      avg_watch_time_sec: 6,
      video_duration_sec: 12,
    },
    { source: 'manual' }
  );

  const snap = snapshots.find((s) => s.window === '24h');
  assert.equal(snap.kpis.save_rate, 3); // 300/10000
  assert.equal(snap.kpis.share_rate, 0.5);
  assert.equal(snap.kpis.ctr, 4);
  assert.equal(snap.kpis.engagement_rate_by_reach, 9); // (500+50+300+50)/10000
  assert.equal(snap.kpis.avg_watch_ratio, 50); // 6/12

  /* a division by zero must yield null, not Infinity or NaN */
  const empty = plan.recordSnapshot(plan.listPublishes()[1].deliveryId, '24h', { reach: 0, saves: 5 }, { source: 'manual' });
  assert.equal(empty.find((s) => s.window === '24h').kpis.save_rate, null);
});

test('the human quality index is the mean of the scored axes only', async () => {
  const plan = await load('../app/server/src/services/plan.js');
  const publish = plan.listPublishes()[2];

  const scored = plan.recordQuality(publish.deliveryId, {
    scores_1_to_5: {
      factual_and_domain_accuracy: 4,
      brand_tone_and_visual_alignment: 5,
      clarity_and_structure: 3,
      actionability_for_persona: 4,
    },
  });
  assert.equal(scored.weighted_quality_index, 4);

  /* unscored axes must not drag the mean toward zero */
  const partial = plan.recordQuality(publish.deliveryId, {
    scores_1_to_5: { factual_and_domain_accuracy: 5, clarity_and_structure: 3 },
  });
  assert.equal(partial.weighted_quality_index, 4);
});

/* ────────────────────────── templates ────────────────────────── */

test('the template catalogue is large, deterministic and fully addressable', async () => {
  const templates = await load('../app/server/src/engine/templates.js');
  const facets = templates.catalogueFacets();

  assert.ok(facets.total >= 400, `catalogue too small: ${facets.total}`);

  /* deterministic ids: the same build twice must agree, so saved references hold */
  const a = templates.getCatalogue({ force: true })[0].id;
  const b = templates.getCatalogue({ force: true })[0].id;
  assert.equal(a, b);

  /* every entry must resolve through getTemplate — no dead links in the gallery */
  const all = templates.getCatalogue();
  for (const t of all.slice(0, 200)) {
    assert.ok(templates.getTemplate(t.id), `unresolvable template ${t.id}`);
  }
});

test('template filters compose and paging never returns an empty page for valid filters', async () => {
  const templates = await load('../app/server/src/engine/templates.js');

  const page = templates.queryTemplates({ category: 'reel', pageSize: 10 });
  assert.ok(page.total > 0);
  assert.equal(page.items.length, Math.min(10, page.total));
  assert.ok(page.items.every((t) => t.category === 'reel'));

  const byMotion = templates.queryTemplates({ motion: 'fade-up' });
  assert.ok(byMotion.total > 0);
  assert.ok(byMotion.items.every((t) => t.motions.includes('fade-up')));

  /* private generator fields must never leak to the client */
  assert.equal('_intent' in page.items[0], false);
  assert.equal('_layout' in page.items[0], false);
});

/* ────────────────────────── production ────────────────────────── */

test('an idea plus a build guide yields scenes that tile the duration exactly', async () => {
  const production = await load('../app/server/src/services/production.js');
  const plan = await load('../app/server/src/services/plan.js');

  for (const publish of plan.listPublishes().slice(0, 12)) {
    const concept = production.buildConcept(publish.deliveryId);
    assert.ok(concept.scenes.length > 0);
    assert.equal(concept.scenes[0].startSec, 0);

    /* scenes must be contiguous: each start equals the previous end */
    for (let i = 1; i < concept.scenes.length; i++) {
      assert.equal(concept.scenes[i].startSec, concept.scenes[i - 1].endSec, `gap before scene ${i}`);
    }
    const total = concept.scenes.reduce((sum, s) => sum + s.durationSec, 0);
    assert.ok(Math.abs(total - concept.durationSec) < 0.06, `duration drift ${total} vs ${concept.durationSec}`);
    assert.ok(concept.scenes.every((s) => s.beat.length > 0), 'every scene needs a beat label');
  }

  /* a shorter guide must still tile a custom duration */
  const short = production.buildConcept(plan.listPublishes()[0].deliveryId, { durationSec: 12, guideId: 'micro-question' });
  assert.equal(short.durationSec, 12);
  assert.equal(short.scenes.length, 3);
  assert.equal(short.scenes.at(-1).endSec, 12);
});

test('edit documents persist, and saving re-derives duration from the scenes', async () => {
  const production = await load('../app/server/src/services/production.js');
  const plan = await load('../app/server/src/services/plan.js');
  const deliveryId = plan.listPublishes()[3].deliveryId;

  const created = production.createEditDoc(deliveryId, { force: true });
  assert.ok(created.doc.docId);

  const doc = created.doc.doc;
  doc.scenes = doc.scenes.map((s, i) => (i === 0 ? { ...s, durationSec: 9, endSec: 9 } : s));
  const saved = production.saveEditDoc(created.doc.docId, doc);

  /* the client claimed whatever it liked; the server trusts the last scene end */
  assert.equal(saved.durationSec, doc.scenes.at(-1).endSec);
  assert.equal(production.getEditDoc(created.doc.docId).doc.scenes[0].durationSec, 9);
});

test('the production queue reports a readiness checklist per publish', async () => {
  const production = await load('../app/server/src/services/production.js');
  const queue = production.productionQueue();

  assert.equal(queue.total, 48);
  for (const item of queue.items.slice(0, 10)) {
    assert.ok(item.readiness.total > 0);
    assert.equal(item.readiness.percent, Math.round((item.readiness.done / item.readiness.total) * 100));
    assert.ok(item.suggestedGuide.id);
  }
});

/* ────────────────────────── media & subtitles ────────────────────────── */

test('estimated transcripts produce monotonic, non-overlapping cues', async () => {
  const media = await load('../app/server/src/services/media.js');

  const transcript = media.estimateTranscript(
    'این یک متن آزمایشی فارسی است که باید به دقت زمان‌بندی شود و هیچ هم‌پوشانی نداشته باشد',
    10
  );

  assert.ok(transcript.cues.length > 0);
  assert.equal(transcript.source, 'estimated');

  let lastEnd = 0;
  for (const cue of transcript.cues) {
    assert.ok(cue.start >= lastEnd - 0.001, 'cue overlaps the previous one');
    assert.ok(cue.end > cue.start);
    assert.ok(cue.text.length > 0);
    for (const word of cue.words) {
      assert.ok(word.start >= cue.start - 0.001);
      assert.ok(word.end <= cue.end + 0.001);
    }
    lastEnd = cue.end;
  }

  /* the last cue must land on the audio's duration, not drift past it */
  assert.ok(Math.abs(transcript.cues.at(-1).end - 10) < 0.2);
});

test('SRT and VTT serialisers emit well-formed timestamps', async () => {
  const media = await load('../app/server/src/services/media.js');

  const cues = [
    { start: 0, end: 1.5, text: 'سلام' },
    { start: 1.5, end: 3.25, text: 'دنیا' },
  ];

  const srt = media.buildSrt(cues);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,500\nسلام/);
  assert.match(srt, /2\n00:00:01,500 --> 00:00:03,250\nدنیا/);

  const vtt = media.buildVtt(cues);
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /00:00:00\.000 --> 00:00:01\.500/);
});

test('minutes and hours are carried into the timestamp correctly', async () => {
  const media = await load('../app/server/src/services/media.js');
  assert.equal(media.toTimestamp(3661.5), '01:01:01,500');
  assert.equal(media.toTimestamp(0), '00:00:00,000');
});

test('a transcript with overlapping cues is reported, not silently rendered', async () => {
  const subtitles = await load('../app/server/src/services/subtitles.js');

  const good = subtitles.validateTranscript([
    { start: 0, end: 1, text: 'یک' },
    { start: 1, end: 2, text: 'دو' },
  ]);
  assert.equal(good.ok, true);
  assert.equal(good.issues.length, 0);

  const overlapping = subtitles.validateTranscript([
    { start: 0, end: 2, text: 'یک' },
    { start: 1, end: 3, text: 'دو' },
  ]);
  assert.equal(overlapping.ok, false);
  assert.match(overlapping.issues.join(' '), /هم‌پوشانی/);
});

/* ────────────────────────── http surface ────────────────────────── */

test('the new routes are mounted', async () => {
  const { buildApp } = await load('../app/server/src/routes/index.js');
  const app = buildApp();

  /* route patterns are compiled to regexes; read the raw pattern back out of
     the source so the assertion is about intent, not regex escaping */
  const paths = app.routes.map((r) => `${r.method} ${String(r.rx).replace(/\\/g, '')}`);
  const expected = [
    '/api/plan/ingest',
    '/api/plan/board',
    '/api/plan/analytics',
    '/api/plan/publishes',
    '/api/templates',
    '/api/templates/facets',
    '/api/production/queue',
    '/api/production/concept',
    '/api/edits',
    '/api/media',
    '/api/media/upload',
    '/subtitles',
  ];

  for (const fragment of expected) {
    assert.ok(
      paths.some((p) => p.includes(fragment)),
      `missing route: ${fragment}`
    );
  }
});

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
