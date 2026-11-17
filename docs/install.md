# راهنمای نصب روی سیستم

نصب کامل روی لینوکس، مک و ویندوز. زمان لازم: حدود ۵ دقیقه.

---

## ۰. پیش‌نیازها

| مورد | نسخه | چرا |
| --- | --- | --- |
| **Node.js** | ۲۲.۵ یا بالاتر | `node:sqlite` داخلی از این نسخه آمده — بدون کامپایل بومی |
| npm | همراه Node | مدیریت workspaces |
| فونت وزیرمتن | همراه مخزن | در `app/web/public/fonts` هست |

بررسی نسخه:

```bash
node -v      # باید v22.5.0 یا بالاتر باشد
```

اگر نسخه پایین‌تر است:

```bash
# لینوکس / مک (nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22 && nvm use 22

# ویندوز: از nodejs.org نصب کن یا winget install OpenJS.NodeJS
```

**چیز دیگری لازم نیست.** نه ffmpeg سیستمی، نه Remotion، نه Chromium، نه Python،
نه PowerShell. باینری ffmpeg همراه پکیج می‌آید.

---

## ۱. گرفتن کد

```bash
git clone -b arena/73760e88-cmstest https://github.com/amirbex/cmstest.git
cd cmstest
```

---

## ۲. نصب وابستگی‌ها

```bash
npm install
```

این کار هر سه workspace را نصب می‌کند (`packages/contracts`, `app/server`, `app/web`).
حدود ۹۰ مگابایت، بیشترش ffmpeg و Vite.

---

## ۳. بررسی سیستم

```bash
npm run setup
```

گزارش صادقانه می‌دهد — چه چیزی هست و چه چیزی نیست:

```
✔ Node 22.22.3 (node:sqlite available)
✔ SVG rasteriser (resvg)
✔ ffmpeg bundled → node_modules/@ffmpeg-installer/linux-x64/ffmpeg
✔ Vazirmatn fonts       7 woff2 files
✔ Skills                6 SKILL.md files
✔ Knowledge base        1 documents
! Piper TTS             optional
! AI provider key       absent — cloud agents will fall back
! Local LLM             not configured
```

علامت `!` یعنی اختیاری، نه خطا. اپ بدون هیچ‌کدامشان کار می‌کند.

---

## ۴. وصل کردن Gemini (توصیه‌شده)

```bash
npm run setup:ai
```

اسکریپت از تو کلید می‌خواهد. کلید رایگان از **https://aistudio.google.com/apikey**.

تفاوت این اسکریپت با «کلید را در فایل بگذار»: **کلید را با یک فراخوانی واقعی به API
آزمایش می‌کند**، مدل‌های در دسترس همین کلید را از خود گوگل می‌پرسد، و زنجیره‌ی مدل
را در `.env` می‌نویسد.

```
۱. کلید Gemini
✔ کلید در محیط یا .env پیدا شد AIza…9x2f

۲. آزمایش کلید و کشف مدل‌ها
✔ کلید معتبر است — ۲۳ مدل قابل استفاده پیدا شد

۳. آزمایش واقعی مدل gemini-3.8-flash
✔ مدل پاسخ JSON معتبر داد ۱۲ توکن

۴. نوشتن تنظیمات
✔ .env نوشته شد
✔ زنجیره مدل gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite
```

بعد از آن همه چیز را تأیید کن:

```bash
npm run verify:ai
```

---

## ۵. بارگذاری داده نمونه

```bash
npm run seed
```

دو محتوای نمونه می‌سازد و تأیید می‌کند، آماده‌ی رندر. غیرمخرب است — چند بار اجرا
کنی داده تکرار نمی‌شود.

---

## ۶. اجرا

```bash
npm run dev
```

```
  ▸ AtoZ Content Studio v6 — development
    API  http://localhost:4000
    Web  http://localhost:5173
```

مرورگر: **http://localhost:5173**

`Ctrl+C` هر دو پروسه را با هم می‌بندد.

---

## ۷. اولین تولید واقعی

۱. اتاق **اتاق فکر** (`#ideation`) → یک موضوع بنویس، مثلاً «کاهش ضایعات کافه»
۲. سه کانسپت می‌آید (اگر Gemini وصل باشد، از مدل؛ وگرنه از قالب)
۳. یکی را انتخاب کن، تعداد تولید را بگذار، **تولید کن**
۴. اتاق **برنامه** (`#plan`) → تأیید کن
۵. اتاق **استودیو** (`#studio`) → رندر بگیر
۶. اتاق **گالری** (`#gallery`) → فایل نهایی را ببین و دانلود کن

اولین ریلز حدود ۳۰ ثانیه طول می‌کشد (۳۶۰ فریم × ~۸۰ms).

---

## ۸. نصب به‌عنوان سرویس دائمی

### لینوکس — systemd

```bash
npm run build      # بسته تولیدی وب

sudo tee /etc/systemd/system/atoz.service > /dev/null <<EOF
[Unit]
Description=AtoZ Content Studio
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$PWD
Environment=NODE_ENV=production
ExecStart=$(which node) --experimental-sqlite app/server/src/main.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now atoz
```

سرور، فایل‌های ساخته‌شده‌ی `app/web/dist` را هم سرو می‌کند، پس روی پورت ۴۰۰۰
همه چیز آماده است.

### مک — launchd

```bash
npm run build
# از pm2 ساده‌تر است:
npx pm2 start "node --experimental-sqlite app/server/src/main.js" --name atoz
npx pm2 save && npx pm2 startup
```

### ویندوز — Task Scheduler

```powershell
npm run build
# ساخت اسکریپت اجرا
"@echo off`ncd /d %~dp0`nnode --experimental-sqlite app/server/src/main.js" | Out-File -Encoding ascii start-atoz.cmd
# سپس در Task Scheduler یک تسک At startup با اجرای start-atoz.cmd بساز
```

---

## ۹. متغیرهای مهم

| متغیر | پیش‌فرض | کار |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | فعال‌سازی Gemini (مسیر اصلی) |
| `ATOZ_MODEL_CHAIN` | `gemini-3.8-flash,…` | ترتیب مدل‌ها |
| `ATOZ_LOCAL_AI_URL` | — | مدل محلی اختیاری (Ollama) |
| `PORT` | `4000` | پورت سرور |
| `ATOZ_DATA_DIR` | `storage/data` | پایگاه‌داده |
| `ATOZ_DEBUG` | `0` | نمایش خطای داخلی در HTTP |

فهرست کامل: `.env.example`

---

## ۱۰. عیب‌یابی نصب

| نشانه | علت | راه‌حل |
| --- | --- | --- |
| `node:sqlite` پیدا نمی‌شود | Node قدیمی | Node ۲۲.۵+ نصب کن |
| `EADDRINUSE :4000` | پروسه قبلی زنده است | `pkill -f app/server/src/main.js` |
| `EADDRINUSE :5173` | Vite قبلی زنده است | `pkill -f vite` |
| صفحه سفید در ۵۱۷۳ | API بالا نیامده | لاگ ترمینال را ببین؛ باید هر دو خط `ready` باشد |
| `npm run setup:ai` به گوگل وصل نمی‌شود | پروکسی / فایروال | `HTTPS_PROXY=... npm run setup:ai` |
| رندر ویدیو شکست می‌خورد | ffmpeg | `npm run setup` ببین؛ اگر bundled نیست `ATOZ_FFMPEG` بگذار |
| فونت فارسی درست نیست | فایل‌های woff2 | `app/web/public/fonts` باید ۷ فایل داشته باشد |

---

## ۱۱. حذف کامل

```bash
# توقف
pkill -f app/server/src/main.js

# حذف سرویس (اگر ساختی)
sudo systemctl disable --now atoz && sudo rm /etc/systemd/system/atoz.service

# داده‌ها و خروجی‌ها
rm -rf storage/data storage/outputs

# همه چیز
cd .. && rm -rf cmstest
```
