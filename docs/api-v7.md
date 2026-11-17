# API نسخهٔ ۷

همهٔ پاسخ‌ها یک پوشش ثابت دارند:

```json
{ "success": true, "data": ... }
{ "success": false, "error": "پیام فارسی", "code": "MACHINE_CODE" }
```

خطاهای داخلی هرگز متن پشته یا مسیر فایل را برنمی‌گردانند. برای دیدن جزئیات در حالت
توسعه، `ATOZ_DEBUG=1` بگذارید.

---

## پلن (plan)

| متد | مسیر | کار |
|---|---|---|
| `GET` | `/api/plan/batches` | فهرست بچ‌ها با شمارش ایده/انتشار/دارایی |
| `POST` | `/api/plan/ingest` | وارد کردن فایل پلن؛ ایدمپوتنت |
| `DELETE` | `/api/plan/batches/:batchId` | حذف کامل یک بچ |
| `GET` | `/api/plan/ideas` | ایده‌ها؛ فیلتر `batchId`, `status` |
| `GET` | `/api/plan/ideas/:id` | یک ایده با انتشارها و دارایی‌هایش |
| `GET` | `/api/plan/publishes` | انتشارها؛ فیلتر `batchId`, `contentId`, `platform`, `status`, `from`, `to`, `limit` |
| `GET` | `/api/plan/publishes/:id` | یک انتشار + snapshotها |
| `PATCH` | `/api/plan/publishes/:id/content` | ویرایش کپشن/اسلاید/تایم‌لاین |
| `POST` | `/api/plan/publishes/:id/schedule` | جابه‌جایی ← کلید جدید + `scheduled_for` بازمحاسبه‌شده |
| `POST` | `/api/plan/publishes/:id/rollover` | انتقال به روز بعد |
| `POST` | `/api/plan/publishes/:id/publish` | ثبت انتشار واقعی + `platform_post_id` |
| `POST` | `/api/plan/publishes/:id/status` | تغییر وضعیت |
| `GET` | `/api/plan/publishes/:id/snapshots` | سه پنجره: ۲۴ ساعت / ۷ روز / ۳۰ روز |
| `POST` | `/api/plan/publishes/:id/snapshots` | ثبت **آمار خام**؛ KPI را سرور می‌سازد |
| `POST` | `/api/plan/publishes/:id/quality` | ارزیابی کیفیت انسانی (چهار محور ۱..۵) |
| `GET` | `/api/plan/assets` | دارایی‌های پلن؛ فیلتر `contentId` |
| `GET` | `/api/plan/board` | تقویم هفته؛ `from`, `to` |
| `GET` | `/api/plan/analytics` | تحلیل؛ `batchId`, `window` |

### نمونه: ingest

```bash
curl -X POST localhost:4000/api/plan/ingest \
  -H 'content-type: application/json' \
  -d "{\"plan\": $(cat docs/reference/ATZ-B-M01-W01-P1_ContentPlan.json)}"
```

```json
{
  "batchId": "ATZ-B-M01-W01-P1",
  "weekStart": "2026-11-14",
  "ideas":     { "added": 19, "updated": 0 },
  "assets":    { "added": 25, "updated": 0 },
  "publishes": { "added": 48, "updated": 0 },
  "removed": 0,
  "warnings": []
}
```

اجرای دوباره: `{"added": 0, "updated": 48}` — بدون ردیف تکراری.

### نمونه: ثبت آمار خام

```bash
curl -X POST localhost:4000/api/plan/publishes/ATZ-D-000001/snapshots \
  -H 'content-type: application/json' \
  -d '{"window":"24h","raw":{"reach":9000,"likes":640,"comments":58,"saves":210,"shares":74,"clicks":430,"views":15300,"avg_watch_time_sec":7.4,"video_duration_sec":12.6}}'
```

پاسخ، شاخص‌های محاسبه‌شده را برمی‌گرداند:

```json
"kpis": {
  "save_rate": 2.33, "share_rate": 0.82, "ctr": 4.78,
  "engagement_rate_by_reach": 10.91, "avg_watch_ratio": 58.73
}
```

ارسال `window: "bogus"` با کد `VALIDATION` و پیام فارسی رد می‌شود.

---

## قالب‌ها (templates)

| متد | مسیر | کار |
|---|---|---|
| `GET` | `/api/templates` | جست‌وجو و صفحه‌بندی؛ `q`, `category`, `family`, `aspect`, `motion`, `tag`, `page`, `pageSize` |
| `GET` | `/api/templates/facets` | شمارش همهٔ وجه‌ها برای نوار فیلتر |
| `GET` | `/api/templates/suggest/:intent` | پیشنهاد برای یک intent |
| `GET` | `/api/templates/:id` | یک قالب؛ مثلاً `cover.fade.editorial.navy` |

شناسه‌ها قطعی‌اند: `intent.motion.layout.style`.

---

## تولید (production)

| متد | مسیر | کار |
|---|---|---|
| `GET` | `/api/production/queue` | صف تولید با چک‌لیست آمادگی هر انتشار |
| `GET` | `/api/production/guides` | راهنماهای ساخت |
| `GET`/`POST` | `/api/production/concept/:deliveryId` | ساخت کانسپت زمان‌بندی‌شده (بدون ذخیره) |
| `GET` | `/api/production/suggest-guide/:deliveryId` | انتخاب خودکار راهنما از نوع دارایی و قیف |
| `GET` | `/api/edits` | اسناد تدوین |
| `POST` | `/api/edits` | ساخت سند از یک انتشار |
| `GET`/`PUT`/`DELETE` | `/api/edits/:docId` | خواندن / ذخیره / حذف |

قاعدهٔ سرور: در ذخیره، `durationSec` از انتهای آخرین صحنه بازمحاسبه می‌شود؛ به عدد
ارسال‌شدهٔ کلاینت اعتماد نمی‌شود.

### نمونه: صف تولید

```json
{
  "total": 48,
  "grouped": { "scheduled": 48 },
  "items": [{
    "deliveryId": "ATZ-D-000004",
    "title": "…",
    "platformLabel": "اینستاگرام",
    "formatLabel": "ریلز",
    "scheduledFor": "2026-11-15T18:00:00.000Z",
    "suggestedGuide": { "id": "hook-problem-solve-cta", "name": "قلاب / مسئله / راه‌حل / دعوت" },
    "readiness": {
      "checks": [{ "key": "copy", "ok": true, "label": "کپشن آماده" }, …],
      "done": 3, "total": 5, "percent": 60, "ready": false
    }
  }]
}
```

---

## رسانه و زیرنویس (media)

| متد | مسیر | کار |
|---|---|---|
| `GET` | `/api/media` | کتابخانه؛ `folder`, `kind`, `contentId`, `limit` |
| `GET` | `/api/media/stats` | آمار حجم |
| `GET` | `/api/media/folders` | پوشه‌های واقعی روی دیسک |
| `GET`/`DELETE` | `/api/media/:id` | یک رسانه / حذف |
| `POST` | `/api/media/upload` | آپلود: multipart، باینری خام، یا `{"path": "..."}` |
| `POST` | `/api/media/import` | ایندکس یک پوشه |
| `POST` | `/api/media/:id/probe` | فراداده |
| `POST` | `/api/media/:id/compress` | فشرده‌سازی |
| `POST` | `/api/media/:id/transcribe` | رونویسی؛ `mode`: `auto` \| `gemini` \| `estimate` |
| `GET`/`PUT` | `/api/media/:id/transcript` | خواندن / ذخیره؛ `?format=srt` یا `vtt` |
| `POST` | `/api/media/:id/subtitles` | سوختن زیرنویس روی ویدیو |

### نمونه: آپلود با فشرده‌سازی خودکار

```bash
curl -X POST "localhost:4000/api/media/upload?name=clip.mp4&compress=1" \
  -H 'content-type: video/mp4' --data-binary @clip.mp4
```

فایل اصلی و نسخهٔ فشرده هر دو نگه داشته می‌شوند؛ نسخهٔ فشرده `parentId` فایل اصلی را دارد.

### کدهای خطای مهم

| کد | معنی |
|---|---|
| `NO_AUDIO_STREAM` | فایل صدا ندارد؛ متن نریشن بده یا فایل صوتی آپلود کن |
| `AUDIO_EXTRACT_FAILED` | ffmpeg نتوانست صدا را جدا کند |
| `VALIDATION` | ورودی با اسکیمای `@atoz/contracts` نمی‌خواند |
| `NOT_FOUND` | شناسه پیدا نشد |
| `PAYLOAD_TOO_LARGE` | بیشتر از ۵۱۲ مگابایت |

### نمونه: سوختن زیرنویس

```bash
curl -X POST localhost:4000/api/media/MDA-…/subtitles \
  -H 'content-type: application/json' \
  -d '{"style":{"fontSize":54,"karaoke":true,"position":"bottom","pill":true}}'
```

پاسخ: `media` (فایل جدید)، `srt` و `vtt`.

---

## فایل‌های استاتیک

| پیشوند | پوشه |
|---|---|
| `/media/outputs` | `storage/outputs` |
| `/media/assets` | `storage/assets` |
| `/media/fonts` | `app/web/public/fonts` |
| `/media/uploads` | `storage/media` |
| `/files` | `assets/` (دارایی‌های شما) |

> `/assets` عمداً برای فایل‌های شما استفاده نشده: آن مسیر باندل Vite است و تداخل، کل
> رابط را می‌شکند.
