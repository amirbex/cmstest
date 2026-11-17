/**
 * Jalali (Solar Hijri) calendar service.
 *
 * v5.0 faked this: it took "today + N days" and slapped fixed Persian weekday
 * names on top, so the first column was always "شنبه" no matter what day it
 * actually was, and deliveries were matched with `scheduleKey.includes('D01')`
 * which also matches D010.
 *
 * Here we do the real thing:
 *   • Gregorian → Jalali via the arithmetic 33-year cycle algorithm
 *   • week starts on Saturday (شنبه), derived from the actual date
 *   • deliveries are matched on an exact ISO date, never on substring
 */
import { db, nowIso } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { rowToDelivery } from './repo.js';

const WEEKDAYS = [
  { fa: 'شنبه', short: 'ش', jsDow: 6 },
  { fa: 'یکشنبه', short: 'ی', jsDow: 0 },
  { fa: 'دوشنبه', short: 'د', jsDow: 1 },
  { fa: 'سه‌شنبه', short: 'س', jsDow: 2 },
  { fa: 'چهارشنبه', short: 'چ', jsDow: 3 },
  { fa: 'پنج‌شنبه', short: 'پ', jsDow: 4 },
  { fa: 'جمعه', short: 'ج', jsDow: 5 },
];

export const JALALI_MONTHS = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
];

const div = (a, b) => Math.trunc(a / b);

/** Gregorian → Jalali (arithmetic 33-year cycle, accurate 1900–2100). */
export function toJalali({ year, month, day }) {
  const gDaysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gy = year;
  let gm = month;
  let gd = day;

  let gy2 = gm > 2 ? gy + 1 : gy;
  let days =
    355666 +
    365 * gy +
    div(gy2 + 3, 4) -
    div(gy2 + 99, 100) +
    div(gy2 + 399, 400) +
    gd +
    gDaysInMonth.slice(0, gm - 1).reduce((a, b) => a + b, 0);

  let jy = -1595 + 33 * div(days, 12053);
  days %= 12053;
  jy += 4 * div(days, 1461);
  days %= 1461;
  if (days > 365) {
    jy += div(days - 1, 365);
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + div(days, 31) : 7 + div(days - 186, 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return { year: jy, month: jm, day: jd, monthName: JALALI_MONTHS[jm - 1] };
}

/** Jalali → Gregorian (used by tests and by date input from the UI). */
export function toGregorian({ year, month, day }) {
  let jy = year + 1595;
  let days =
    -355668 + 365 * jy + div(jy, 33) * 8 + div((jy % 33) + 3, 4) + day +
    (month < 7 ? (month - 1) * 31 : (month - 7) * 30 + 186);
  let gy = 400 * div(days, 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * div(--days, 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * div(days, 1461);
  days %= 1461;
  if (days > 365) {
    gy += div(days - 1, 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  while (gm < 12 && gd > monthDays[gm]) {
    gd -= monthDays[gm];
    gm++;
  }
  return { year: gy, month: gm + 1, day: gd };
}

export function isoDate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function describe(dateLike) {
  const date = new Date(dateLike);
  const j = toJalali({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() });
  const weekday = WEEKDAYS.find((w) => w.jsDow === date.getDay());
  return {
    iso: isoDate(date),
    weekday: weekday?.fa ?? '',
    weekdayShort: weekday?.short ?? '',
    jalali: `${j.day} ${j.monthName} ${j.year}`,
    jalaliShort: `${j.day} ${j.monthName}`,
    jalaliDigits: `${j.day} ${j.monthName}`.replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]),
    year: j.year,
    month: j.month,
    monthName: j.monthName,
    day: j.day,
  };
}

/** Start of the current Jalali week, i.e. the most recent Saturday. */
export function startOfWeek(reference = new Date()) {
  const date = new Date(reference);
  date.setHours(0, 0, 0, 0);
  const offset = (date.getDay() + 1) % 7; // Saturday → 0
  date.setDate(date.getDate() - offset);
  return date;
}

/**
 * The publishing board: 7 real days starting from the actual Saturday,
 * each carrying the deliveries scheduled exactly on that ISO date.
 */
export function weekBoard(reference = new Date()) {
  const start = startOfWeek(reference);
  const rows = db
    .prepare('SELECT * FROM delivery WHERE scheduled_for IS NOT NULL ORDER BY scheduled_for ASC')
    .all()
    .map(rowToDelivery);
  const byDate = new Map();
  for (const delivery of rows) {
    const key = isoDate(delivery.scheduledFor);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(delivery);
  }

  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const info = describe(date);
    const items = (byDate.get(info.iso) ?? []).map((d) => {
      const content = db.prepare('SELECT title, section_code, status FROM content WHERE content_id = ?').get(d.contentId);
      return {
        ...d,
        title: content?.title ?? d.contentId,
        sectionCode: content?.section_code ?? 'Library',
      };
    });
    days.push({ ...info, isToday: info.iso === isoDate(new Date()), items, count: items.length });
  }
  return { startIso: isoDate(start), days, today: describe(new Date()) };
}

/** Month grid for the full Jalali month view (6×7 cells). */
export function monthBoard(reference = new Date()) {
  const now = describe(reference);
  // first day of the jalali month → gregorian
  const firstGregorian = toGregorian({ year: now.year, month: now.month, day: 1 });
  const firstDate = new Date(firstGregorian.year, firstGregorian.month - 1, firstGregorian.day);
  const lead = (firstDate.getDay() + 1) % 7;
  const length = now.month <= 6 ? 31 : now.month <= 11 ? 30 : 29;

  const rows = db
    .prepare('SELECT * FROM delivery WHERE scheduled_for IS NOT NULL')
    .all()
    .map(rowToDelivery);
  const byDate = new Map();
  for (const delivery of rows) {
    const key = isoDate(delivery.scheduledFor);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(delivery);
  }

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push({ empty: true });
  for (let day = 1; day <= length; day++) {
    const g = toGregorian({ year: now.year, month: now.month, day });
    const date = new Date(g.year, g.month - 1, g.day);
    const info = describe(date);
    const items = byDate.get(info.iso) ?? [];
    cells.push({ ...info, items, count: items.length, isToday: info.iso === isoDate(new Date()) });
  }
  return { label: `${now.monthName} ${now.year}`, monthName: now.monthName, year: now.year, cells, weekdays: WEEKDAYS.map((w) => w.fa) };
}

export function scheduleDelivery(deliveryId, isoDay) {
  /* `2026-11-20` is parsed by JS as UTC midnight, placing the item on the
     previous jalali day for every timezone east of UTC. Anchor a bare date to
     local noon so a scheduled day always lands on the day the user picked. */
  const date = isoDay ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(isoDay) ? `${isoDay}T12:00:00` : isoDay) : null;
  if (date && Number.isNaN(date.getTime())) throw new HttpError(400, 'تاریخ نامعتبر است', 'INVALID_DATE');
  db.prepare('UPDATE delivery SET scheduled_for=?, status = CASE WHEN status = \'published\' THEN status ELSE \'scheduled\' END WHERE delivery_id=?').run(
    date ? date.toISOString() : null,
    deliveryId
  );
  const row = db.prepare('SELECT * FROM delivery WHERE delivery_id = ?').get(deliveryId);
  if (!row) throw new Error('تحویل پیدا نشد');
  return rowToDelivery(row);
}

export function rollover(deliveryId, days = 1) {
  const row = db.prepare('SELECT * FROM delivery WHERE delivery_id = ?').get(deliveryId);
  if (!row) throw new Error('تحویل پیدا نشد');
  const base = row.scheduled_for ? new Date(row.scheduled_for) : new Date();
  base.setDate(base.getDate() + days);
  db.prepare('UPDATE delivery SET scheduled_for=?, rollover_count=rollover_count+1 WHERE delivery_id=?').run(
    base.toISOString(),
    deliveryId
  );
  return rowToDelivery(db.prepare('SELECT * FROM delivery WHERE delivery_id = ?').get(deliveryId));
}

export function publishDelivery(deliveryId, platformPostId = null) {
  db.prepare("UPDATE delivery SET status='published', platform_post_id=?, published_at=? WHERE delivery_id=?").run(
    platformPostId || `MANUAL-${Date.now()}`,
    nowIso(),
    deliveryId
  );
  return rowToDelivery(db.prepare('SELECT * FROM delivery WHERE delivery_id = ?').get(deliveryId));
}

export { WEEKDAYS };
