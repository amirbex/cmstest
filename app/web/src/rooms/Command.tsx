import React from 'react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import { Card, Empty, Kpi, Progress, StatusChip, Button, fa, fmtRelative } from '../components/ui';
import type { RoomProps } from './index';

export function CommandRoom({ onNavigate }: RoomProps) {
  const { state, jobs, run, refresh } = useStore();
  const stats = state?.stats;
  const brand = state?.brand;

  const running = jobs.filter((j) => j.status === 'running');
  const queued = jobs.filter((j) => j.status === 'queued');
  const recentFailures = jobs.filter((j) => j.status === 'failed').slice(0, 3);

  const pipeline = [
    { label: 'در انتظار تایید', value: stats?.pending ?? 0, color: 'var(--warn)', room: 'plan' as const },
    { label: 'در صف تولید', value: stats?.approved ?? 0, color: 'var(--info)', room: 'studio' as const },
    { label: 'تولیدشده', value: stats?.produced ?? 0, color: 'var(--ok)', room: 'gallery' as const },
    { label: 'منتشرشده', value: stats?.published ?? 0, color: 'var(--gold)', room: 'calendar' as const },
  ];
  const total = Math.max(1, pipeline.reduce((sum, p) => sum + p.value, 0));

  return (
    <div className="stack" style={{ gap: 'var(--s-6)' }}>
      {/* KPI row */}
      <div className="grid grid-4">
        <Kpi label="در انتظار تایید" value={fa(stats?.pending ?? 0)} icon="🕒" tone="warn" hint="نیازمند تصمیم شما" />
        <Kpi label="در صف تولید" value={fa(stats?.approved ?? 0)} icon="⚙️" tone="info" hint="آماده رندر" />
        <Kpi label="تولیدشده" value={fa(stats?.produced ?? 0)} icon="🎞️" tone="ok" hint={`${fa(stats?.assets ?? 0)} فایل خروجی`} />
        <Kpi label="منتشرشده" value={fa(stats?.published ?? 0)} icon="🚀" tone="gold" hint="در تقویم انتشار" />
      </div>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        {/* pipeline */}
        <Card title="قیف تولید محتوا" subtitle="از ایده تا انتشار — وضعیت لحظه‌ای">
          <div className="stack" style={{ gap: 'var(--s-4)' }}>
            {pipeline.map((step) => (
              <button
                key={step.label}
                className="card card--tight card--interactive"
                onClick={() => onNavigate(step.room)}
                style={{ background: 'var(--surface-2)', textAlign: 'right', width: '100%', border: '1px solid var(--border)' }}
              >
                <div className="row-between" style={{ marginBottom: 8 }}>
                  <span className="font-bold text-sm">{step.label}</span>
                  <span className="num font-black" style={{ color: step.color, fontSize: 'var(--fs-lg)' }}>
                    {fa(step.value)}
                  </span>
                </div>
                <div className="progress">
                  <div
                    className="progress-bar"
                    style={{ width: `${Math.max(3, (step.value / total) * 100)}%`, background: step.color }}
                  />
                </div>
              </button>
            ))}
          </div>
        </Card>

        {/* live jobs */}
        <Card
          title="صف رندر زنده"
          subtitle={running.length ? `${fa(running.length)} جاب در حال اجرا` : 'صف خالی است'}
          actions={<Button size="sm" variant="ghost" onClick={() => onNavigate('monitor')}>جزئیات</Button>}
        >
          {running.length === 0 && queued.length === 0 ? (
            <Empty
              icon="✅"
              title="هیچ جابی در صف نیست"
              text="یک محتوا را در استودیو باز کن و رندر را بزن؛ پیشرفت اینجا زنده نمایش داده می‌شود."
              action={<Button size="sm" variant="primary" onClick={() => onNavigate('studio')}>رفتن به استودیو</Button>}
            />
          ) : (
            <div className="stack" style={{ gap: 'var(--s-4)' }}>
              {[...running, ...queued].slice(0, 5).map((job) => (
                <div key={job.jobId} className="stack" style={{ gap: 6 }}>
                  <div className="row-between">
                    <span className="text-sm font-bold">
                      {job.kind === 'reel' ? '🎬 ریلز' : job.kind === 'carousel' ? '📑 کاروسل' : job.kind === 'cover' ? '🖼️ کاور' : '📦 بسته کامل'}
                      <span className="code" style={{ marginInlineStart: 8 }}>{job.contentId}</span>
                    </span>
                    <span className="text-2xs muted">{job.status === 'queued' ? 'در انتظار' : job.step}</span>
                  </div>
                  <Progress value={job.progress} />
                </div>
              ))}
            </div>
          )}
          {recentFailures.length > 0 && (
            <>
              <div className="divider" />
              <div className="text-2xs muted" style={{ marginBottom: 8 }}>آخرین خطاها</div>
              {recentFailures.map((job) => (
                <div key={job.jobId} className="row-between text-2xs" style={{ padding: '4px 0' }}>
                  <span className="truncate" style={{ maxWidth: '70%', color: 'var(--danger)' }}>{job.error}</span>
                  <span className="code">{job.contentId}</span>
                </div>
              ))}
            </>
          )}
        </Card>
      </div>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        {/* agents */}
        <Card title="تیم ایجنت‌ها" subtitle="هر نقش، یک مسئولیت مشخص در خط تولید">
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
            {AGENTS.map((agent) => (
              <div key={agent.id} className="card card--tight" style={{ background: 'var(--surface-2)' }}>
                <div className="row" style={{ gap: 10, marginBottom: 6 }}>
                  <span style={{ fontSize: 20 }} aria-hidden>{agent.icon}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="text-sm font-black truncate">{agent.name}</div>
                    <div className="text-2xs" style={{ color: 'var(--gold)' }}>{agent.role}</div>
                  </div>
                </div>
                <div className="text-2xs dim" style={{ lineHeight: 1.7 }}>{agent.bio}</div>
              </div>
            ))}
          </div>
        </Card>

        {/* notifications + brand */}
        <Card title="اعلان‌های سیستم" subtitle="آخرین رویدادهای خط تولید">
          {(state?.notifications.length ?? 0) === 0 ? (
            <Empty icon="🔔" title="اعلانی نیست" text="پس از اولین رندر یا تایید، رویدادها اینجا ثبت می‌شوند." />
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {state?.notifications.slice(0, 6).map((n) => (
                <div key={n.id} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                  <span
                    aria-hidden
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      marginTop: 8,
                      flexShrink: 0,
                      background:
                        n.level === 'success' ? 'var(--ok)' : n.level === 'error' ? 'var(--danger)' : 'var(--info)',
                    }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div className="text-xs" style={{ lineHeight: 1.7 }}>{n.message}</div>
                    <div className="text-2xs dim">{fmtRelative(n.created_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="divider" />
          <div className="row-between text-2xs muted">
            <span>{brand?.brandName}</span>
            <span className="ltr">{brand?.domain}</span>
          </div>
        </Card>
      </div>

      {/* first-run helper */}
      {(stats?.pending === 0 && stats?.produced === 0 && stats?.assets === 0) && (
        <Card accent title="شروع سریع" subtitle="سه گام تا اولین خروجی">
          <div className="grid grid-3">
            {[
              { n: '۱', t: 'بلوک محتوا را وارد کن', d: 'فایل JSON هفتگی را آپلود کن یا از داده نمونه استفاده کن.', room: 'plan' as const, action: 'رفتن به برنامه' },
              { n: '۲', t: 'الگوها را تایید کن', d: 'پس از بازبینی، محتواها به صف تولید می‌روند.', room: 'plan' as const, action: 'بازبینی الگوها' },
              { n: '۳', t: 'رندر بگیر', d: 'کاور، کاروسل و ریلز آفلاین ساخته می‌شوند.', room: 'studio' as const, action: 'باز کردن استودیو' },
            ].map((step) => (
              <div key={step.n} className="card card--tight stack" style={{ background: 'var(--surface-2)' }}>
                <div className="row" style={{ gap: 10 }}>
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 9,
                      display: 'grid',
                      placeItems: 'center',
                      background: 'rgba(255,180,0,0.18)',
                      color: 'var(--gold)',
                      fontWeight: 900,
                      flexShrink: 0,
                    }}
                  >
                    {step.n}
                  </span>
                  <span className="text-sm font-black">{step.t}</span>
                </div>
                <div className="text-2xs muted" style={{ lineHeight: 1.8 }}>{step.d}</div>
                <Button size="sm" variant="solid" onClick={() => onNavigate(step.room)}>{step.action}</Button>
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void run(() => api.seedDemo(), { success: 'داده نمونه بارگذاری شد' }).then(refresh)}
            >
              بارگذاری داده نمونه
            </Button>
            <span className="text-2xs dim">اگر می‌خواهی بدون فایل، سریع خط تولید را ببینی</span>
          </div>
        </Card>
      )}
    </div>
  );
}

const AGENTS = [
  { id: 'atooz', name: 'آتوز', role: 'دستیار فرماندهی', icon: '🧠', bio: 'ثبت ایده، اجرای فرمان و پاسخ به وضعیت سیستم.' },
  { id: 'producer', name: 'آرش', role: 'مدیر تولید', icon: '🎬', bio: 'صف رندر، اولویت‌بندی و تحویل خروجی.' },
  { id: 'writer', name: 'پارسا', role: 'سناریونویس', icon: '✍️', bio: 'تبدیل کانسپت به ساختار صحنه و نریشن.' },
  { id: 'art', name: 'نگار', role: 'کارگردان هنری', icon: '🎨', bio: 'چیدمان لایه‌ها، رنگ زیربرند و حریم امن.' },
  { id: 'voice', name: 'رامتین', role: 'کارگردان صدا', icon: '🎙️', bio: 'تولید نریشن فارسی و زمان‌بندی زیرنویس.' },
  { id: 'growth', name: 'کیانوش', role: 'استراتژیست رشد', icon: '📈', bio: 'زاویه دید داده‌محور و انتخاب قیف.' },
];
