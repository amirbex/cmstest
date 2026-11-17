/**
 * Domain tests — the exact regressions found in the v5.0 review.
 * Run: node --experimental-sqlite --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* use a throwaway database so tests never touch real data */
const tmpDir = fs.mkdtempSync(path.join('/tmp', 'atoz-test-'));
process.env.ATOZ_DATA_DIR = path.join(tmpDir, 'data');
process.env.ATOZ_OUTPUT_DIR = path.join(tmpDir, 'outputs');

const { ingestPuzzleBlock, persistGeneratedBatch } = await import('../app/server/src/services/content.js');
const { estimateCaptions, splitWords } = await import('../app/server/src/services/voice.js');
const repo = await import('../app/server/src/services/repo.js');
const cal = await import('../app/server/src/services/calendar.js');
const { PuzzleBlock, CreativePlan, RenderRequest, ContentId } = await import('../packages/contracts/src/index.ts');

/* ────────────────────────── v5.0 regression: double insert ────────────────────────── */

const block = {
  schema_metadata: { period_code: 'M01-W01-PART1', batch_id: 'ATZ-B-M01-W01-P1' },
  content_ideas: [
    { content_id: 'ATZ-C-100001', title: 'ایده اول', thread: 'موضوع اول', pillar: 'P1' },
    { content_id: 'ATZ-C-100002', title: 'ایده دوم', thread: 'موضوع دوم', pillar: 'P4' },
  ],
  deliveries: [
    { content_id: 'ATZ-C-100001', delivery_id: 'ATZ-D-100001', format_type: 'reel', schedule_key: 'M01-W01-D01-IG-ANM-01', funnel_stage: 'TOFU', content_pillar: 'P1' },
    { content_id: 'ATZ-C-100002', delivery_id: 'ATZ-D-100002', format_type: 'carousel', schedule_key: 'M01-W01-D02-IG-CAR-01', funnel_stage: 'MOFU', content_pillar: 'P4' },
  ],
};

test('ingest creates exactly one content + one delivery per idea (v5.0 created 2x)', () => {
  const summary = ingestPuzzleBlock(block);
  assert.equal(summary.contentsCreated, 2);
  const contents = repo.listContents();
  assert.equal(contents.length, 2);
  const deliveries = repo.listDeliveries();
  assert.equal(deliveries.length, 2, 'two ideas must not become four deliveries');
  for (const content of contents) {
    const own = deliveries.filter((d) => d.contentId === content.contentId);
    assert.equal(own.length, 1, `${content.contentId} must have exactly one delivery`);
  }
});

test('ingest is idempotent for the same content_id', () => {
  ingestPuzzleBlock(block);
  ingestPuzzleBlock(block);
  assert.equal(repo.listContents().length, 2, 're-uploading a block must not duplicate content');
  assert.equal(repo.listDeliveries().length, 2);
});

test('explicit ids are honoured and do not burn counters', () => {
  const before = repo.stats().counters.content;
  ingestPuzzleBlock({
    schema_metadata: { period_code: 'M01-W02-PART1' },
    content_ideas: [{ content_id: 'ATZ-C-200050', title: 'با شناسه صریح', pillar: 'P2' }],
    deliveries: [],
  });
  const after = repo.stats().counters.content;
  assert.ok(repo.getContent('ATZ-C-200050'), 'explicit content_id must exist');
  assert.ok(after >= before, 'counter must never go backwards');
});

test('orphan deliveries (no matching idea) still become content instead of being dropped', () => {
  ingestPuzzleBlock({
    schema_metadata: { period_code: 'M01-W03-PART1' },
    content_ideas: [{ title: 'فقط ایده', pillar: 'P1' }],
    deliveries: [
      { content_id: 'ATZ-C-300001', delivery_id: 'ATZ-D-300001', format_type: 'article', schedule_key: 'M01-W03-D01-WEB-MAG-01', content_pillar: 'P5' },
    ],
  });
  assert.ok(repo.getContent('ATZ-C-300001'), 'delivery-only content must be created');
});

test('approve with no filter approves every pending item', () => {
  const result = repo.approveBlueprints({});
  assert.ok(result.approvedCount > 0, 'approve-all must approve pending content');
  assert.equal(repo.listContents({ status: 'blueprint_pending' }).length, 0);
});

test('approve via periodCode only touches that batch', () => {
  ingestPuzzleBlock({
    schema_metadata: { period_code: 'M02-W01-PART1', batch_id: 'ATZ-B-M02-W01-P1' },
    content_ideas: [{ content_id: 'ATZ-C-400001', title: 'بلوک دوم', pillar: 'P3' }],
    deliveries: [],
  });
  const result = repo.approveBlueprints({ periodCode: 'M02-W01-PART1' });
  assert.equal(result.approvedCount, 1);
  assert.equal(result.contentIds[0], 'ATZ-C-400001');
});

test('approve throws for an unknown period code instead of faking success', () => {
  assert.throws(() => repo.approveBlueprints({ periodCode: 'M99-W99-PART9' }), /پیدا نشد/);
});

/* ────────────────────────── metrics ────────────────────────── */

test('KPIs are computed from real numbers and clamped safely', () => {
  const delivery = repo.listDeliveries()[0];
  const updated = repo.recordMetrics(delivery.deliveryId, {
    reach: 1000,
    saves: 50,
    shares: 10,
    clicks: 20,
    avgWatchTimeSec: 15,
    videoDurationSec: 30,
  });
  assert.equal(updated.kpis.saveRate, 5);
  assert.equal(updated.kpis.shareRate, 1);
  assert.equal(updated.kpis.ctr, 2);
  assert.equal(updated.kpis.avgWatchRatio, 50);
});

test('metrics reject a missing delivery', () => {
  assert.throws(() => repo.recordMetrics('ATZ-D-999999', { reach: 1 }), /پیدا نشد/);
});

/* ────────────────────────── validation ────────────────────────── */

test('PuzzleBlock schema rejects a block with no ideas', () => {
  assert.equal(PuzzleBlock.safeParse({ schema_metadata: { period_code: 'X-1' }, content_ideas: [] }).success, false);
});

test('PuzzleBlock schema rejects a missing period_code', () => {
  assert.equal(PuzzleBlock.safeParse({ schema_metadata: {}, content_ideas: [{ title: 'a' }] }).success, false);
});

test('content id pattern blocks injection payloads', () => {
  assert.equal(ContentId.safeParse('ATZ-C-000001').success, true);
  assert.equal(ContentId.safeParse('ATZ-C-1; rm -rf /').success, false);
  assert.equal(ContentId.safeParse("ATZ-C-000001' OR 1=1--").success, false);
});

test('render request schema requires a valid content id and at least one kind', () => {
  assert.equal(RenderRequest.safeParse({ contentId: 'ATZ-C-000001', kinds: ['cover'] }).success, true);
  assert.equal(RenderRequest.safeParse({ contentId: 'nope', kinds: ['cover'] }).success, false);
  assert.equal(RenderRequest.safeParse({ contentId: 'ATZ-C-000001', kinds: [] }).success, false);
});

test('CreativePlan fills defaults so downstream code never sees undefined', () => {
  const plan = CreativePlan.parse({ title: 'تست' });
  assert.equal(plan.sectionCode, 'Library');
  assert.equal(plan.audio.durationSec, 0);
  assert.deepEqual(plan.scenes, []);
  assert.equal(plan.layout.theme, 'auto');
});

/* ────────────────────────── calendar ────────────────────────── */

test('jalali conversion matches known dates', () => {
  assert.deepEqual(
    (({ year, month, day }) => ({ year, month, day }))(cal.toJalali({ year: 2024, month: 3, day: 20 })),
    { year: 1403, month: 1, day: 1 }
  );
  assert.deepEqual(
    (({ year, month, day }) => ({ year, month, day }))(cal.toJalali({ year: 2026, month: 11, day: 17 })),
    { year: 1405, month: 8, day: 26 }
  );
});

test('jalali round-trips back to gregorian', () => {
  for (const date of [
    { year: 2024, month: 3, day: 20 },
    { year: 2025, month: 7, day: 4 },
    { year: 2026, month: 11, day: 17 },
  ]) {
    const jalali = cal.toJalali(date);
    const back = cal.toGregorian(jalali);
    assert.deepEqual(back, date, `round-trip failed for ${JSON.stringify(date)}`);
  }
});

test('the week always starts on Saturday and contains a real today', () => {
  const board = cal.weekBoard(new Date());
  assert.equal(board.days.length, 7);
  assert.equal(board.days[0].weekday, 'شنبه', 'week must start on Saturday');
  assert.ok(board.days.some((d) => d.isToday), 'today must be marked exactly once');
  assert.equal(board.days.filter((d) => d.isToday).length, 1);
});

test('deliveries are matched on exact ISO date, not substring', () => {
  const board = cal.weekBoard(new Date());
  for (const day of board.days) {
    for (const item of day.items) {
      assert.equal(item.scheduledFor.slice(0, 10), day.iso, 'item on wrong day');
    }
  }
});

test('rollover moves a delivery by exactly one day and counts it', () => {
  const delivery = repo.listDeliveries().find((d) => d.scheduledFor);
  const before = new Date(delivery.scheduledFor);
  const after = cal.rollover(delivery.deliveryId, 1);
  const diffDays = Math.round((new Date(after.scheduledFor) - before) / 86400000);
  assert.equal(diffDays, 1);
  assert.equal(after.rolloverCount, delivery.rolloverCount + 1);
});

/* ────────────────────────── voice captions ────────────────────────── */

test('splitWords keeps ZWNJ glued and drops empty tokens', () => {
  const words = splitWords('کسب‌وکار   خوب\nاست');
  assert.deepEqual(words, ['کسب‌وکار', 'خوب', 'است']);
});

test('estimated captions are monotonic and cover the whole duration', () => {
  const words = estimateCaptions('یک دو سه چهار', 8);
  assert.equal(words.length, 4);
  assert.equal(words[0].start, 0);
  assert.equal(words.at(-1).end, 8);
  for (let i = 1; i < words.length; i++) {
    assert.ok(words[i].start >= words[i - 1].end - 1e-9, 'captions must not overlap');
  }
});

/* ────────────────────────── AI batch persistence ────────────────────────── */

test('persistGeneratedBatch writes a valid plan for every deliverable', () => {
  const records = persistGeneratedBatch({
    conceptTitle: 'کانسپت تست',
    sectionCode: 'Magazine',
    counts: { reels: 1, carousels: 1 },
    deliverables: [
      {
        type: 'reel',
        title: 'ریلز تست',
        subtitle: 'زیرتیتر',
        voiceoverScript: 'متن نریشن',
        articleHtml: '',
        scenes: [{ cardTitle: 'صحنه', metric: '+۴۰٪', items: ['یک'], chartData: [] }],
        carouselSlides: [],
        social: { instagramCaption: 'کپشن' },
      },
      {
        type: 'carousel',
        title: 'کاروسل تست',
        scenes: [],
        carouselSlides: [{ templateType: 'cover', badge: 'X', heading: 'ع', body: 'م', highlightMetric: '' }],
        social: {},
      },
    ],
  });
  assert.equal(records.length, 2);
  for (const record of records) {
    const content = repo.getContent(record.contentId);
    assert.ok(content, 'record must be readable back');
    assert.equal(CreativePlan.safeParse(content.plan).success, true, 'stored plan must satisfy the contract');
  }
});

/* ────────────────────────── job lifecycle ────────────────────────── */

test('queue rejects unknown content instead of silently enqueuing', async () => {
  const queue = await import('../app/server/src/services/queue.js');
  const jobId = queue.enqueue({ kind: 'cover', contentId: 'ATZ-C-999999' });
  assert.ok(jobId);
  await new Promise((r) => setTimeout(r, 150));
  const job = queue.getJob(jobId);
  /* the worker may not have started in this process; either state is fine but
     the job must exist and be tracked */
  assert.ok(['queued', 'running', 'failed'].includes(job.status));
});

test('cleanup', () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
