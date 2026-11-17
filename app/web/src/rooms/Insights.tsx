import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { planApi, type AnalyticsOverview, type PlanPublish, type RawMetrics, type Snapshot } from '../lib/api';
import { Card, Empty, Button, fa, Tabs, Field, Modal, Progress, Spinner, Kpi } from '../components/ui';
import type { RoomProps } from './index';

/**
 * Insights.
 *
 * Two hard rules, enforced by the server:
 *   • the operator enters *raw* metrics only — impressions, saves, watch time
 *   • every rate is derived, so a typo in one field can never masquerade as a KPI
 *
 * The three measurement windows (24h / 7d / 30d) are always visible, because a
 * post's "engagement" at 24h and at 30d are different questions.
 */
export function InsightsRoom({ onNavigate }: RoomProps) {
  const { run, toast } = useStore();
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [publishes, setPublishes] = useState<PlanPublish[]>([]);
  const [windowKey, setWindowKey] = useState<'24h' | '7d' | '30d'>('7d');
  const [loading, setLoading] = useState(true);
  const [entry, setEntry] = useState<PlanPublish | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [draft, setDraft] = useState<RawMetrics>({});

  const load = useCallback(async () => {
    setLoading(true);
    const [a, p] = await Promise.all([
      planApi.analytics({ window: windowKey }).catch(() => null),
      planApi.publishes({ limit: 200 }).catch(() => []),
    ]);
    setOverview(a);
    setPublishes(p);
    setLoading(false);
  }, [windowKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEntry = async (publish: PlanPublish) => {
    setEntry(publish);
    setDraft({});
    const snaps = await planApi.snapshots(publish.deliveryId).catch(() => []);
    setSnapshots(snaps);
    /* prefill with whatever was last measured in this window */
    const existing = snaps.find((s) => s.window === windowKey);
    if (existing) setDraft(existing.raw ?? {});
  };

  const saveSnapshot = async () => {
    if (!entry) return;
    const result = await run(() => planApi.addSnapshot(entry.deliveryId, windowKey, draft), {
      success: 'آمار ثبت شد؛ شاخص‌ها محاسبه شدند',
    });
    if (result) {
      setSnapshots(result);
      await load();
    }
  };

  const measured = publishes.filter((p) => snapshots.length > 0);
  const unmeasured = publishes.filter((p) => p.publishStatus === 'published');

  const topByReach = useMemo(() => overview?.topPublishes ?? [], [overview]);

  if (!loading && !overview?.totals.publishes) {
    return (
      <Empty
        icon="📊"
        title="داده‌ای برای تحلیل نیست"
        text="اول پلن را وارد کن، بعد از انتشار، آمار خام را ثبت کن."
        action={<Button variant="primary" onClick={() => onNavigate('command')}>داشبورد</Button>}
      />
    );
  }

  const METRIC_FIELDS: { key: keyof RawMetrics; label: string; hint?: string }[] = [
    { key: 'reach', label: 'ریچ (Reach)', hint: 'تعداد حساب‌های یکتا' },
    { key: 'views', label: 'بازدید (Views)' },
    { key: 'likes', label: 'لایک' },
    { key: 'comments', label: 'کامنت' },
    { key: 'saves', label: 'ذخیره (Saves)' },
    { key: 'shares', label: 'اشتراک‌گذاری' },
    { key: 'clicks', label: 'کلیک روی لینک' },
    { key: 'replies_and_sticker_taps', label: 'پاسخ/استیکر تلگرام' },
    { key: 'avg_watch_time_sec', label: 'میانگین زمان تماشا (ثانیه)' },
    { key: 'video_duration_sec', label: 'مدت ویدیو (ثانیه)' },
    { key: 'unique_page_views', label: 'بازدید یکتای صفحه وب' },
    { key: 'asset_downloads_or_tool_runs', label: 'اجرای ابزار/دانلود' },
    { key: 'newsletter_signups', label: 'عضویت خبرنامه' },
    { key: 'avg_time_on_page_sec', label: 'میانگین زمان روی صفحه (ثانیه)' },
  ];

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <Card tight>
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 12 }}>
          <Tabs
            value={windowKey}
            onChange={setWindowKey}
            tabs={[
              { key: '24h', label: '۲۴ ساعت' },
              { key: '7d', label: '۷ روز' },
              { key: '30d', label: '۳۰ روز' },
            ]}
          />
          {loading && <Spinner size={14} />}
        </div>
      </Card>

      <div className="grid grid-4">
        <Kpi
          label="ریچ کل"
          value={fa(overview?.totals.reach ?? 0)}
          icon="👁️"
          tone="info"
          hint={`${fa(overview?.totals.measured ?? 0)} اندازه‌گیری‌شده`}
        />
        <Kpi
          label="نرخ تعامل"
          value={overview?.rates.engagement_rate_by_reach != null ? `${fa(overview.rates.engagement_rate_by_reach.toFixed(1))}٪` : '—'}
          icon="💬"
          tone="gold"
          hint={`${fa(overview?.totals.engagement ?? 0)} تعامل`}
        />
        <Kpi
          label="نرخ ذخیره"
          value={overview?.rates.save_rate != null ? `${fa(overview.rates.save_rate.toFixed(1))}٪` : '—'}
          icon="🔖"
          tone="ok"
          hint="نشانهٔ ارزش ماندگار"
        />
        <Kpi
          label="پوشش اندازه‌گیری"
          value={`${fa(overview?.rates.measured_share ?? 0)}٪`}
          icon="📏"
          tone={(overview?.rates.measured_share ?? 0) > 60 ? 'ok' : 'warn'}
          hint="نسبت انتشارهای دارای داده"
        />
      </div>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card title="عملکرد پلتفرم" subtitle="نسبت به ریچ همان پلتفرم">
          <div className="stack" style={{ gap: 12 }}>
            {(overview?.byPlatform ?? []).map((p) => (
              <div key={p.platform} className="stack" style={{ gap: 4 }}>
                <div className="row-between text-2xs">
                  <span className="font-bold">{p.label}</span>
                  <span className="num dim">
                    {fa(p.reach)} ریچ · {fa(p.publishes)} انتشار
                  </span>
                </div>
                <Progress value={p.reach ? Math.min(100, (p.engagement / p.reach) * 100) : 0} />
              </div>
            ))}
            {(overview?.byPlatform ?? []).length === 0 && <span className="text-xs dim">داده‌ای نیست</span>}
          </div>
        </Card>

        <Card title="قیف محتوا" subtitle="تعداد انتشار در هر مرحله">
          <div className="stack" style={{ gap: 10 }}>
            {(overview?.byFunnel ?? []).map((f) => (
              <div key={f.stage} className="card card--tight" style={{ background: 'var(--surface-2)' }}>
                <div className="row-between">
                  <span className="text-xs font-bold">{FUNNEL_LABEL[f.stage] ?? f.stage}</span>
                  <span className="num text-sm">{fa(f.publishes)}</span>
                </div>
                <div className="text-2xs dim" style={{ marginTop: 3 }}>
                  {fa(f.published)} منتشرشده
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {topByReach.length > 0 && (
        <Card title="بهترین انتشارها" subtitle={`بر اساس ریچ در بازهٔ ${windowKey}`}>
          <div className="stack" style={{ gap: 6 }}>
            {topByReach.map((p) => (
              <div key={p.deliveryId} className="row-between text-2xs" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <span className="clamp-1" style={{ maxWidth: '55%' }}>{p.title || p.deliveryId}</span>
                <div className="row" style={{ gap: 8 }}>
                  <span className="chip">{p.platformLabel}</span>
                  <span className="num" style={{ color: 'var(--gold)' }}>{fa(p.reach)}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card
        title="ثبت آمار خام"
        subtitle="فقط اعداد واقعی پلتفرم؛ شاخص‌ها را سرور محاسبه می‌کند"
        actions={<span className="chip chip--info">{fa(measured.length > 0 ? measured.length : publishes.length)} انتشار</span>}
      >
        <div className="stack" style={{ gap: 4, maxHeight: 380, overflowY: 'auto' }}>
          {publishes.map((p) => (
            <button
              key={p.deliveryId}
              className="row-between card card--tight"
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                cursor: 'pointer',
                textAlign: 'right',
                fontFamily: 'inherit',
                color: 'inherit',
                width: '100%',
                padding: '8px 10px',
              }}
              onClick={() => void openEntry(p)}
            >
              <div className="stack" style={{ gap: 2, maxWidth: '70%' }}>
                <span className="text-2xs font-bold clamp-1">
                  {p.content?.ready_caption?.slice(0, 70) || p.deliveryId}
                </span>
                <span className="text-2xs dim">
                  {p.platformLabel} · {p.formatLabel} · {p.scheduleKey}
                </span>
              </div>
              <span className={`chip ${p.publishStatus === 'published' ? 'chip--ok' : 'chip--info'}`}>
                {p.publishStatus === 'published' ? 'منتشرشده' : 'زمان‌بندی‌شده'}
              </span>
            </button>
          ))}
        </div>
      </Card>

      <Modal open={!!entry} onClose={() => setEntry(null)} title="ثبت آمار خام" width={720}>
        {entry && (
          <div className="stack" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span className="chip chip--gold">{entry.platformLabel}</span>
              <span className="chip">{entry.formatLabel}</span>
              <span className="code">{entry.deliveryId}</span>
            </div>

            <div className="text-2xs muted">
              پنجرهٔ فعال: <b>{windowKey}</b> — برای هر پنجره یک ردیف جدا ذخیره می‌شود.
            </div>

            <div className="grid grid-2" style={{ gap: 10 }}>
              {METRIC_FIELDS.map((f) => (
                <Field key={String(f.key)} label={f.label} hint={f.hint}>
                  <input
                    className="input num"
                    type="number"
                    min={0}
                    value={(draft[f.key] as number | null | undefined) ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        [f.key]: e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                  />
                </Field>
              ))}
            </div>

            {snapshots.filter((s) => s.window === windowKey && s.capturedAt).length > 0 && (
              <div>
                <div className="label">شاخص‌های محاسبه‌شدهٔ فعلی</div>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                  {Object.entries(snapshots.find((s) => s.window === windowKey)?.kpis ?? {})
                    .filter(([, v]) => v != null)
                    .map(([k, v]) => (
                      <span key={k} className="chip chip--ok" style={{ fontSize: 10 }}>
                        {KPI_LABEL[k] ?? k}: {fa(Number(v).toFixed(2))}٪
                      </span>
                    ))}
                </div>
              </div>
            )}

            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="ghost" onClick={() => setEntry(null)}>بستن</Button>
              <Button variant="primary" onClick={() => void saveSnapshot()}>ثبت و محاسبه</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

const FUNNEL_LABEL: Record<string, string> = {
  TOFU: 'آگاهی (TOFU)',
  MOFU: 'در نظر گرفتن (MOFU)',
  BOFU: 'تصمیم (BOFU)',
};

const KPI_LABEL: Record<string, string> = {
  save_rate: 'نرخ ذخیره',
  share_rate: 'نرخ اشتراک',
  ctr: 'نرخ کلیک',
  engagement_rate_by_reach: 'تعامل به ریچ',
  avg_watch_ratio: 'نسبت تماشا',
  story_reply_rate: 'پاسخ استوری',
  web_asset_conversion: 'تبدیل ابزار وب',
};
