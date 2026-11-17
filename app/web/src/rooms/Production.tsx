import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { productionApi, type BuildGuide, type ProductionQueue, type QueueItem } from '../lib/api';
import { Card, Empty, Button, Progress, fa, Tabs, Field, Spinner } from '../components/ui';
import type { RoomProps } from './index';

/**
 * The production queue.
 *
 * One row per publish that still needs work, ordered by schedule, each carrying a
 * concrete readiness checklist. The two actions that matter — "build the timed
 * concept" and "open in the editor" — are one click from the row.
 */
export function ProductionRoom({ onNavigate }: RoomProps) {
  const { run, toast } = useStore();
  const [queue, setQueue] = useState<ProductionQueue | null>(null);
  const [guides, setGuides] = useState<BuildGuide[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedGuide, setSelectedGuide] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [q, g] = await Promise.all([
      productionApi.queue().catch(() => null),
      productionApi.guides().catch(() => []),
    ]);
    setQueue(q);
    setGuides(g ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => {
    const all = queue?.items ?? [];
    return statusFilter === 'all' ? all : all.filter((i) => i.status === statusFilter);
  }, [queue, statusFilter]);

  const buildConcept = async (item: QueueItem) => {
    setBusy(item.deliveryId);
    const guideId = selectedGuide[item.deliveryId] ?? item.suggestedGuide.id;
    const result = await run(() => productionApi.createEdit(item.deliveryId, { guideId }), {
      success: 'سند تدوین ساخته شد',
    });
    setBusy(null);
    if (result) {
      toast('info', result.created ? 'سند جدید ساخته شد' : 'سند موجود باز شد');
      await load();
      onNavigate('editor');
    }
  };

  const openEditor = async (item: QueueItem) => {
    if (item.editDoc) {
      window.location.hash = `editor?doc=${item.editDoc.docId}`;
      onNavigate('editor');
      return;
    }
    await buildConcept(item);
  };

  const grouped = queue?.grouped ?? {};

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <Card subtitle="هر ردیف یک انتشار واقعی است؛ درصد آمادگی از چک‌لیست همان انتشار می‌آید">
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 12 }}>
          <Tabs
            value={statusFilter}
            onChange={setStatusFilter}
            tabs={[
              { key: 'all', label: 'همه', count: queue?.total ?? 0 },
              ...Object.entries(grouped).map(([key, count]) => ({ key, label: statusLabel(key), count })),
            ]}
          />
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Spinner size={12} /> : '↻'} بازخوانی
          </Button>
        </div>
      </Card>

      {!loading && items.length === 0 && (
        <Empty
          icon="🎬"
          title="صف تولید خالی است"
          text="یا همه منتشر شده‌اند، یا هنوز پلنی وارد نشده."
          action={<Button variant="primary" onClick={() => onNavigate('command')}>داشبورد</Button>}
        />
      )}

      <div className="stack" style={{ gap: 10 }}>
        {items.map((item) => {
          const guideId = selectedGuide[item.deliveryId] ?? item.suggestedGuide.id;
          const guide = guides.find((g) => g.id === guideId);
          const isBusy = busy === item.deliveryId;
          return (
            <Card key={item.deliveryId} tight>
              <div className="stack" style={{ gap: 10 }}>
                <div className="row-between" style={{ gap: 12, flexWrap: 'wrap' }}>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <span className="chip chip--gold">{item.platformLabel}</span>
                    <span className="chip">{item.formatLabel}</span>
                    {item.assetType && <span className="chip">{item.assetType}</span>}
                    <span className={`chip ${item.status === 'published' ? 'chip--ok' : 'chip--info'}`}>
                      {statusLabel(item.status)}
                    </span>
                    {item.editDoc && <span className="chip chip--ok">سند تدوین دارد</span>}
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <Button size="sm" variant="ghost" onClick={() => void openEditor(item)} disabled={isBusy}>
                      {item.editDoc ? 'ویرایش' : 'ساخت کانسپت'}
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => void buildConcept(item)} loading={isBusy}>
                      {item.isVideo ? 'کانسپت ریلز' : item.isCarousel ? 'کانسپت کاروسل' : 'کانسپت پست'}
                    </Button>
                  </div>
                </div>

                <div className="text-sm font-bold clamp-2" style={{ lineHeight: 1.7 }}>
                  {item.title || item.deliveryId}
                </div>

                <div className="grid grid-2" style={{ gap: 16, alignItems: 'center' }}>
                  <div className="stack" style={{ gap: 6 }}>
                    <div className="row-between text-2xs">
                      <span className="muted">آمادگی</span>
                      <span className="num" style={{ color: item.readiness.ready ? 'var(--ok)' : 'var(--warn)' }}>
                        {fa(item.readiness.done)}/{fa(item.readiness.total)}
                      </span>
                    </div>
                    <Progress value={item.readiness.percent} />
                    <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                      {item.readiness.checks.map((c) => (
                        <span
                          key={c.key}
                          className={`chip ${c.ok ? 'chip--ok' : 'chip--warn'}`}
                          style={{ fontSize: 'var(--fs-2xs)' }}
                        >
                          {c.ok ? '✓' : '○'} {c.label}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="stack" style={{ gap: 6 }}>
                    <Field label="راهنمای ساخت (build guide)" hint={guide?.note}>
                      <select
                        className="select"
                        value={guideId}
                        onChange={(e) => setSelectedGuide((prev) => ({ ...prev, [item.deliveryId]: e.target.value }))}
                      >
                        {guides.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div className="row text-2xs dim" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <span className="code">{item.scheduleKey}</span>
                      {item.scheduledFor && (
                        <span>{fa(new Date(item.scheduledFor).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' }))}</span>
                      )}
                    </div>
                  </div>
                </div>

                {item.suggestedTemplates.length > 0 && (
                  <div className="row text-2xs" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <span className="dim">قالب پیشنهادی:</span>
                    {item.suggestedTemplates.map((t) => (
                      <span key={t.id} className="chip" style={{ fontSize: 'var(--fs-2xs)' }}>{t.name}</span>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  planned: 'برنامه‌ریزی‌شده',
  scheduled: 'زمان‌بندی‌شده',
  producing: 'در تولید',
  ready: 'آماده انتشار',
  published: 'منتشرشده',
  failed: 'ناموفق',
  skipped: 'رد‌شده',
};

function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status;
}
