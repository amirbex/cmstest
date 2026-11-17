import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { planApi, productionApi, templateApi, type AnalyticsOverview, type PublishBoard, type TemplateFacets } from '../lib/api';
import { Card, Empty, Kpi, Button, Progress, fa, Tabs } from '../components/ui';
import type { RoomProps } from './index';

/**
 * Command dashboard, rebuilt on the real v3.0 model.
 *
 * The old dashboard counted the app's own content rows. This one counts the
 * user's actual plan: how many publishes exist this week, what is ready, what
 * the last measured week actually did, and what is blocked.
 */
export function DashboardRoom({ onNavigate }: RoomProps) {
  const { run, toast } = useStore();
  const [board, setBoard] = useState<PublishBoard | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsOverview | null>(null);
  const [queue, setQueue] = useState<Awaited<ReturnType<typeof productionApi.queue>> | null>(null);
  const [facets, setFacets] = useState<TemplateFacets | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [b, a, q, f] = await Promise.all([
      planApi.board().catch(() => null),
      planApi.analytics({ window: '7d' }).catch(() => null),
      productionApi.queue().catch(() => null),
      templateApi.facets().catch(() => null),
    ]);
    setBoard(b);
    setAnalytics(a);
    setQueue(q);
    setFacets(f);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* Import a plan file from disk — the first thing a new user needs. */
  const importPlan = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const plan = JSON.parse(text);
      const diff = await run(() => planApi.ingest(plan), { success: 'پلن وارد شد' });
      if (diff) {
        toast('info', `${fa(diff.publishes?.added ?? 0)} انتشار افزوده شد؛ ${fa(diff.warnings?.length ?? 0)} هشدار`);
        await load();
      }
    } catch (err) {
      toast('error', `فایل پلن خوانده نشد: ${(err as Error).message}`);
    }
    setImporting(false);
  };

  const weekStats = useMemo(() => {
    const pubs = board?.publishes ?? [];
    const byPlatform = pubs.reduce<Record<string, number>>((acc, p) => {
      acc[p.platformLabel] = (acc[p.platformLabel] ?? 0) + 1;
      return acc;
    }, {});
    return {
      total: pubs.length,
      published: pubs.filter((p) => p.publishStatus === 'published').length,
      dueToday: pubs.filter((p) => p.scheduledFor?.slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
      byPlatform,
    };
  }, [board]);

  const readiness = queue
    ? Math.round(queue.items.reduce((sum, i) => sum + i.readiness.percent, 0) / Math.max(1, queue.items.length))
    : 0;

  const blocked = (queue?.items ?? []).filter((i) => !i.readiness.checks.find((c) => c.key === 'copy')?.ok);

  if (!loading && !(board?.publishes?.length ?? 0)) {
    return (
      <div className="stack" style={{ gap: 'var(--s-5)' }}>
        <Card title="شروع: فایل پلن محتوایی را وارد کن" accent subtitle="فایل JSON تولیدشده توسط ایجنت پلن‌ریز">
          <div className="stack" style={{ gap: 'var(--s-4)' }}>
            <p className="text-sm muted" style={{ lineHeight: 2, margin: 0 }}>
              این نسخه روی مدل واقعی پلن شما کار می‌کند: هر «ایده» چند «دارایی» دارد و هر دارایی در یک یا چند
              «انتشار» زمان‌بندی‌شده روی پلتفرم‌ها می‌رود. فایل پلن را انتخاب کن تا ایده‌ها، دارایی‌ها، انتشارها و
              متادیتای قیف یک‌جا خوانده شوند.
            </p>
            <label
              className="card card--tight"
              style={{
                display: 'grid',
                placeItems: 'center',
                padding: 32,
                borderStyle: 'dashed',
                borderWidth: 2,
                cursor: importing ? 'wait' : 'pointer',
                background: 'var(--surface-2)',
              }}
            >
              <input
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                disabled={importing}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void importPlan(file);
                  e.currentTarget.value = '';
                }}
              />
              <div className="stack" style={{ alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 32 }} aria-hidden>{importing ? '⏳' : '📥'}</span>
                <span className="font-bold text-sm">{importing ? 'در حال خواندن پلن…' : 'انتخاب فایل پلن JSON'}</span>
                <span className="text-2xs dim">مثلاً ATZ-B-M01-W01-P1_ContentPlan.json</span>
              </div>
            </label>
            <div className="text-2xs dim" style={{ lineHeight: 1.9 }}>
              فایل در <span className="code">docs/reference/</span> مخزن هم نمونه دارد. پس از ورود، همین صفحه به داشبورد
              زنده تبدیل می‌شود.
            </div>
          </div>
        </Card>
        <Empty icon="🧭" title="هنوز پلنی وارد نشده" text="بعد از ورود فایل، تقویم، صف تولید و تحلیل‌ها پر می‌شوند." />
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 'var(--s-6)' }}>
      <div className="grid grid-4">
        <Kpi
          label="انتشار این هفته"
          value={fa(weekStats.total)}
          icon="🗓️"
          tone="gold"
          hint={loading ? 'در حال بارگذاری' : `${fa(weekStats.published)} منتشرشده`}
        />
        <Kpi
          label="آمادگی تولید"
          value={`${fa(readiness)}٪`}
          icon="⚙️"
          tone={readiness > 70 ? 'ok' : readiness > 40 ? 'warn' : 'danger'}
          hint={queue ? `${fa(queue.total)} انتشار در صف` : '—'}
        />
        <Kpi
          label="نرخ تعامل (۷ روز)"
          value={analytics?.rates?.engagement_rate_by_reach != null ? `${fa(analytics.rates.engagement_rate_by_reach.toFixed(1))}٪` : '—'}
          icon="📈"
          tone="info"
          hint={analytics ? `${fa(analytics.totals?.reach ?? 0)} ریچ ثبت‌شده` : 'داده‌ای نیست'}
        />
        <Kpi
          label="شاخص کیفیت انسانی"
          value={analytics?.quality?.average != null ? `${fa(analytics.quality.average.toFixed(1))}/۵` : '—'}
          icon="⭐"
          tone={analytics?.quality.average != null && analytics.quality.average >= 4 ? 'ok' : 'warn'}
          hint={analytics ? `${fa(analytics.quality?.evaluated ?? 0)} ارزیابی‌شده` : '—'}
        />
      </div>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card
          title="هفتهٔ جاری"
          subtitle={board?.weekStart ? `شروع: ${fa(new Date(board.weekStart).toLocaleDateString('fa-IR'))}` : ''}
          actions={<Button size="sm" variant="ghost" onClick={() => onNavigate('calendar')}>تقویم کامل ←</Button>}
        >
          <div className="stack" style={{ gap: 8 }}>
            {(board?.days ?? []).map((day) => {
              const isToday = day.date === new Date().toISOString().slice(0, 10);
              const dayPubs = (board?.publishes ?? []).filter((p) => (p.scheduledFor ?? '').slice(0, 10) === day.date);
              return (
                <div
                  key={day.date}
                  className="card card--tight"
                  style={{
                    background: isToday ? 'rgba(255,180,0,0.08)' : 'var(--surface-2)',
                    borderColor: isToday ? 'var(--gold)' : 'var(--border)',
                  }}
                >
                  <div className="row-between">
                    <div className="row" style={{ gap: 8 }}>
                      <span className="font-bold text-sm">{day.weekday}</span>
                      {isToday && <span className="chip chip--gold">امروز</span>}
                    </div>
                    <span className="num text-2xs dim">{fa(dayPubs.length)} انتشار</span>
                  </div>
                  {dayPubs.length > 0 && (
                    <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
                      {dayPubs.slice(0, 8).map((p) => (
                        <span
                          key={p.deliveryId}
                          className="chip"
                          style={{ fontSize: 'var(--fs-2xs)', borderColor: `${p.visual?.accent_hex ?? '#FFB400'}55` }}
                          title={`${p.platformLabel} · ${p.formatLabel}`}
                        >
                          {p.timeSlot} · {p.platformLabel}
                        </span>
                      ))}
                      {dayPubs.length > 8 && <span className="chip">+{fa(dayPubs.length - 8)}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        <div className="stack" style={{ gap: 'var(--s-5)' }}>
          <Card title="توزیع پلتفرم" subtitle="کل انتشارهای این هفته">
            <div className="stack" style={{ gap: 10 }}>
              {Object.entries(weekStats.byPlatform).length === 0 && <span className="text-xs dim">—</span>}
              {Object.entries(weekStats.byPlatform).map(([label, count]) => (
                <div key={label} className="stack" style={{ gap: 4 }}>
                  <div className="row-between text-2xs">
                    <span className="font-bold">{label}</span>
                    <span className="num muted">{fa(count)}</span>
                  </div>
                  <Progress value={(count / Math.max(1, weekStats.total)) * 100} />
                </div>
              ))}
            </div>
          </Card>

          {blocked.length > 0 && (
            <Card title="مسدودها" subtitle="انتشارهایی که کپشن آماده ندارند" accent>
              <div className="stack" style={{ gap: 6 }}>
                {blocked.slice(0, 5).map((item) => (
                  <div key={item.deliveryId} className="row-between text-2xs">
                    <span className="clamp-1">{item.title || item.deliveryId}</span>
                    <span className="chip chip--warn">{fa(item.readiness.percent)}٪</span>
                  </div>
                ))}
                <Button size="sm" variant="ghost" block onClick={() => onNavigate('production')}>
                  رفتن به صف تولید ←
                </Button>
              </div>
            </Card>
          )}

          <Card title="کتابخانهٔ قالب‌ها" subtitle="رسپی‌های حرکت آماده" >
            <div className="row-between">
              <div className="stack" style={{ gap: 2 }}>
                <span className="num font-black" style={{ fontSize: 'var(--fs-xl)', color: 'var(--gold)' }}>
                  {fa(facets?.total ?? 0)}
                </span>
                <span className="text-2xs dim">رسپی در {fa(facets?.families?.length ?? 0)} خانواده</span>
              </div>
              <Button size="sm" onClick={() => onNavigate('templates')}>مرور گالری</Button>
            </div>
          </Card>
        </div>
      </div>

      {analytics && (analytics.byFormat?.length ?? 0) > 0 && (
        <Card title="فرمت‌های برتر" subtitle="بر اساس تعامل اندازه‌گیری‌شده">
          <div className="grid grid-3">
            {(analytics.byFormat ?? []).slice(0, 6).map((f) => (
              <div key={f.format} className="card card--tight" style={{ background: 'var(--surface-2)' }}>
                <div className="text-xs font-bold clamp-2">{f.label}</div>
                <div className="row-between" style={{ marginTop: 6 }}>
                  <span className="text-2xs dim">{fa(f.publishes)} انتشار</span>
                  <span className="text-2xs num" style={{ color: 'var(--ok)' }}>
                    {f.avgEngagement != null ? `${fa(f.avgEngagement.toFixed(1))}٪` : '—'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
