import React, { useEffect, useState } from 'react';
import { api, type Content, type Delivery } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Card, Empty, Field, Modal, SectionBadge, Tabs, fa } from '../components/ui';
import type { RoomProps } from './index';

/**
 * Real funnel analytics: every delivery carries measured KPIs computed on the
 * server (save rate, CTR, watch ratio). No invented numbers.
 */
export function InsightsRoom(_props: RoomProps) {
  const { state, run } = useStore();
  const [contents, setContents] = useState<Content[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [tab, setTab] = useState<'funnel' | 'kpi'>('funnel');
  const [editing, setEditing] = useState<(Delivery & { title?: string }) | null>(null);
  const [form, setForm] = useState({ reach: 0, saves: 0, shares: 0, clicks: 0, avgWatchTimeSec: 0, videoDurationSec: 30 });

  const load = async () => {
    const list = await api.contents();
    setContents(list);
    const all: Delivery[] = [];
    for (const content of list.slice(0, 40)) {
      try {
        const detail = await api.content(content.contentId);
        all.push(...detail.deliveries);
      } catch {
        /* skip */
      }
    }
    setDeliveries(all);
  };

  useEffect(() => {
    void load();
  }, []);

  const funnel = (['TOFU', 'MOFU', 'BOFU'] as const).map((stage) => ({
    stage,
    label: stage === 'TOFU' ? 'آگاهی (TOFU)' : stage === 'MOFU' ? 'در نظر گرفتن (MOFU)' : 'تصمیم (BOFU)',
    contents: contents.filter((c) => c.funnelStage === stage),
  }));

  const measured = deliveries.filter((d) => d.metrics.reach > 0);
  const avg = (key: keyof Delivery['kpis']) =>
    measured.length ? +(measured.reduce((sum, d) => sum + (d.kpis[key] ?? 0), 0) / measured.length).toFixed(2) : 0;

  const openMetrics = (delivery: Delivery, title?: string) => {
    setEditing({ ...delivery, title });
    setForm({
      reach: delivery.metrics.reach ?? 0,
      saves: delivery.metrics.saves ?? 0,
      shares: delivery.metrics.shares ?? 0,
      clicks: delivery.metrics.clicks ?? 0,
      avgWatchTimeSec: delivery.metrics.avgWatchTimeSec ?? 0,
      videoDurationSec: delivery.metrics.videoDurationSec ?? 30,
    });
  };

  const saveMetrics = async () => {
    if (!editing) return;
    await run(() => api.metrics(editing.deliveryId, form), { success: 'شاخص‌ها ثبت شد' });
    setEditing(null);
    await load();
  };

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <div className="grid grid-4">
        <Card tight>
          <div className="kpi">
            <span className="kpi-label">میانگین نرخ ذخیره</span>
            <span className="kpi-value" style={{ fontSize: 'var(--fs-2xl)', color: 'var(--ok)' }}>{fa(avg('saveRate'))}٪</span>
          </div>
        </Card>
        <Card tight>
          <div className="kpi">
            <span className="kpi-label">میانگین CTR</span>
            <span className="kpi-value" style={{ fontSize: 'var(--fs-2xl)', color: 'var(--info)' }}>{fa(avg('ctr'))}٪</span>
          </div>
        </Card>
        <Card tight>
          <div className="kpi">
            <span className="kpi-label">نرخ اشتراک</span>
            <span className="kpi-value" style={{ fontSize: 'var(--fs-2xl)', color: 'var(--gold)' }}>{fa(avg('shareRate'))}٪</span>
          </div>
        </Card>
        <Card tight>
          <div className="kpi">
            <span className="kpi-label">نسبت تماشا</span>
            <span className="kpi-value" style={{ fontSize: 'var(--fs-2xl)' }}>{fa(avg('avgWatchRatio'))}٪</span>
          </div>
        </Card>
      </div>

      <Tabs<'funnel' | 'kpi'>
        tabs={[
          { key: 'funnel', label: 'قیف محتوا', count: contents.length },
          { key: 'kpi', label: 'شاخص‌های اندازه‌گیری‌شده', count: measured.length },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'funnel' && (
        <div className="grid grid-3">
          {funnel.map((column) => (
            <Card key={column.stage} title={column.label} subtitle={`${fa(column.contents.length)} محتوا`}>
              {column.contents.length === 0 ? (
                <div className="text-2xs dim" style={{ padding: '16px 0', textAlign: 'center' }}>خالی</div>
              ) : (
                <div className="stack" style={{ gap: 8 }}>
                  {column.contents.slice(0, 8).map((content) => (
                    <div key={content.contentId} className="card card--tight" style={{ background: 'var(--surface-2)', padding: 8 }}>
                      <div className="text-2xs font-bold clamp-2" style={{ lineHeight: 1.6 }}>{content.title}</div>
                      <div className="row" style={{ gap: 4, marginTop: 4 }}>
                        <SectionBadge section={content.sectionCode} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {tab === 'kpi' && (
        measured.length === 0 ? (
          <Empty
            icon="📈"
            title="هیچ شاخصی ثبت نشده"
            text="پس از انتشار، اعداد واقعی هر پست را وارد کن تا نرخ ذخیره، CTR و نسبت تماشا محاسبه شود."
          />
        ) : (
          <Card title="کارایی تحویل‌ها" actions={<Button size="sm" variant="ghost" onClick={() => void load()}>↻</Button>}>
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>تحویل</th>
                    <th>ریچ</th>
                    <th>ذخیره</th>
                    <th>نرخ ذخیره</th>
                    <th>CTR</th>
                    <th>تماشا</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {measured.map((delivery) => (
                    <tr key={delivery.deliveryId}>
                      <td><span className="code">{delivery.deliveryId}</span></td>
                      <td className="num">{fa(delivery.metrics.reach)}</td>
                      <td className="num">{fa(delivery.metrics.saves)}</td>
                      <td className="num" style={{ color: 'var(--ok)' }}>{fa(delivery.kpis.saveRate)}٪</td>
                      <td className="num" style={{ color: 'var(--info)' }}>{fa(delivery.kpis.ctr)}٪</td>
                      <td className="num">{fa(delivery.kpis.avgWatchRatio)}٪</td>
                      <td>
                        <Button size="sm" variant="ghost" onClick={() => openMetrics(delivery)}>ویرایش</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )
      )}

      <Card title="همه تحویل‌ها" subtitle="برای ثبت شاخص روی هر ردیف کلیک کن">
        {deliveries.length === 0 ? (
          <div className="text-2xs dim">هنوز تحویلی ایجاد نشده است.</div>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {deliveries.slice(0, 12).map((delivery) => {
              const content = contents.find((c) => c.contentId === delivery.contentId);
              return (
                <div key={delivery.deliveryId} className="row-between card card--tight" style={{ background: 'var(--surface-2)', padding: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="text-2xs font-bold truncate">{content?.title ?? delivery.contentId}</div>
                    <div className="row" style={{ gap: 6, marginTop: 3 }}>
                      <span className="code">{delivery.deliveryId}</span>
                      <span className="chip">{delivery.platform}</span>
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => openMetrics(delivery, content?.title)}>
                    ثبت شاخص
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={`ثبت شاخص — ${editing?.deliveryId ?? ''}`}>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field label="ریچ (Reach)"><input className="input num" type="number" value={form.reach} onChange={(e) => setForm({ ...form, reach: Number(e.target.value) || 0 })} /></Field>
          <Field label="ذخیره (Saves)"><input className="input num" type="number" value={form.saves} onChange={(e) => setForm({ ...form, saves: Number(e.target.value) || 0 })} /></Field>
          <Field label="اشتراک (Shares)"><input className="input num" type="number" value={form.shares} onChange={(e) => setForm({ ...form, shares: Number(e.target.value) || 0 })} /></Field>
          <Field label="کلیک (Clicks)"><input className="input num" type="number" value={form.clicks} onChange={(e) => setForm({ ...form, clicks: Number(e.target.value) || 0 })} /></Field>
          <Field label="میانگین تماشا (ثانیه)"><input className="input num" type="number" value={form.avgWatchTimeSec} onChange={(e) => setForm({ ...form, avgWatchTimeSec: Number(e.target.value) || 0 })} /></Field>
          <Field label="مدت ویدئو (ثانیه)"><input className="input num" type="number" value={form.videoDurationSec} onChange={(e) => setForm({ ...form, videoDurationSec: Number(e.target.value) || 30 })} /></Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <Button variant="ghost" onClick={() => setEditing(null)}>انصراف</Button>
          <Button variant="primary" onClick={() => void saveMetrics()}>ذخیره</Button>
        </div>
      </Modal>
    </div>
  );
}
