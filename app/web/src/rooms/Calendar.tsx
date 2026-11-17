import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { planApi, planApi as P, type PlanPublish, type PublishBoard } from '../lib/api';
import { Card, Empty, Button, Modal, Field, fa, Tabs, Spinner } from '../components/ui';
import type { RoomProps } from './index';

/**
 * Publish calendar, Saturday-first, driven by schedule keys.
 *
 * Moving a publish edits its `schedule_key` server-side and re-derives
 * `scheduled_for` from the batch's week anchor — which is why the week stays
 * coherent no matter how many times you drag something around.
 */
export function CalendarRoom({ onNavigate }: RoomProps) {
  const { run, toast } = useStore();
  const [board, setBoard] = useState<PublishBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [weekOffset, setWeekOffset] = useState(0);
  const [openPublish, setOpenPublish] = useState<PlanPublish | null>(null);
  const [filter, setFilter] = useState<'all' | 'instagram' | 'telegram' | 'website'>('all');

  const weekStartIso = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    /* Saturday = 6; roll back to the most recent Saturday then apply the offset */
    const shift = (d.getDay() + 1) % 7;
    d.setDate(d.getDate() - shift + weekOffset * 7);
    return d.toISOString().slice(0, 10);
  }, [weekOffset]);

  const load = useCallback(async () => {
    setLoading(true);
    const b = await planApi.board(weekStartIso).catch(() => null);
    setBoard(b);
    setLoading(false);
  }, [weekStartIso]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const pubs = board?.publishes ?? [];
    return filter === 'all' ? pubs : pubs.filter((p) => p.platform === filter);
  }, [board, filter]);

  const byDay = useMemo(() => {
    const map = new Map<string, PlanPublish[]>();
    for (const p of visible) {
      const key = p.scheduledFor?.slice(0, 10) ?? 'unscheduled';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    /* chronological order, unscheduled last */
    return [...map.entries()].sort((a, b) => (a[0] === 'unscheduled' ? 1 : b[0] === 'unscheduled' ? -1 : a[0].localeCompare(b[0])));
  }, [visible]);

  const move = async (publish: PlanPublish, direction: -1 | 1) => {
    const base = publish.scheduledFor ? new Date(publish.scheduledFor) : new Date();
    if (Number.isNaN(base.getTime())) return;
    base.setDate(base.getDate() + direction);
    const result = await run(() => planApi.schedule(publish.deliveryId, base.toISOString().slice(0, 10), publish.timeSlot), {
      success: 'زمان‌بندی به‌روز شد',
    });
    if (result) {
      toast('info', `کلید جدید: ${result.scheduleKey}`);
      await load();
    }
  };

  const rollover = async (publish: PlanPublish) => {
    const result = await run(() => planApi.rollover(publish.deliveryId, 1), { success: 'به روز بعد منتقل شد' });
    if (result) await load();
  };

  const markPublished = async (publish: PlanPublish) => {
    const result = await run(() => planApi.markPublished(publish.deliveryId), { success: 'منتشرشده ثبت شد' });
    if (result) {
      setOpenPublish(result);
      await load();
    }
  };

  const total = visible.length;
  const published = visible.filter((p) => p.publishStatus === 'published').length;

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <Card>
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" onClick={() => setWeekOffset((w) => w - 1)}>→ هفته قبل</Button>
            <Button size="sm" variant={weekOffset === 0 ? 'primary' : 'default'} onClick={() => setWeekOffset(0)}>
              هفته جاری
            </Button>
            <Button size="sm" onClick={() => setWeekOffset((w) => w + 1)}>هفته بعد ←</Button>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <span className="chip chip--gold">{fa(total)} انتشار</span>
            <span className="chip chip--ok">{fa(published)} منتشرشده</span>
            {loading && <Spinner size={14} />}
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <Tabs
            value={filter}
            onChange={setFilter}
            tabs={[
              { key: 'all', label: 'همه', count: board?.publishes.length ?? 0 },
              { key: 'instagram', label: 'اینستاگرام' },
              { key: 'telegram', label: 'تلگرام' },
              { key: 'website', label: 'وب‌سایت' },
            ]}
          />
        </div>
      </Card>

      {!loading && byDay.length === 0 && (
        <Empty
          icon="🗓️"
          title="این هفته انتشار برنامه‌ریزی‌شده‌ای ندارد"
          text="فایل پلن را از داشبورد وارد کن یا هفتهٔ دیگری را ببین."
          action={<Button variant="primary" onClick={() => onNavigate('command')}>رفتن به داشبورد</Button>}
        />
      )}

      {byDay.map(([date, pubs]) => (
        <Card
          key={date}
          title={
            date === 'unscheduled'
              ? 'بدون زمان'
              : `${fa(new Date(`${date}T00:00:00`).toLocaleDateString('fa-IR', { weekday: 'long', day: 'numeric', month: 'long' }))}`
          }
          subtitle={`${fa(pubs.length)} انتشار`}
        >
          <div className="stack" style={{ gap: 8 }}>
            {pubs.map((p) => (
              <div
                key={p.deliveryId}
                className="card card--tight card--interactive"
                style={{
                  background: 'var(--surface-2)',
                  borderInlineStartWidth: 3,
                  borderInlineStartStyle: 'solid',
                  borderInlineStartColor: p.visual?.accent_hex ?? 'var(--gold)',
                }}
              >
                <div className="row-between" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <span className="chip chip--gold">{p.timeSlot}</span>
                    <span className="chip">{p.platformLabel}</span>
                    <span className="chip">{p.formatLabel}</span>
                    {p.funnelStage && <span className="chip">{p.funnelStage}</span>}
                    <span className={`chip ${p.publishStatus === 'published' ? 'chip--ok' : 'chip--info'}`}>
                      {p.publishStatus === 'published' ? 'منتشرشده' : 'زمان‌بندی‌شده'}
                    </span>
                  </div>
                  <div className="row" style={{ gap: 4 }}>
                    <Button size="sm" variant="ghost" onClick={() => void move(p, -1)} title="یک روز زودتر">↑</Button>
                    <Button size="sm" variant="ghost" onClick={() => void move(p, 1)} title="یک روز دیرتر">↓</Button>
                    <Button size="sm" variant="ghost" onClick={() => void rollover(p)} title="انتقال به روز بعد">↷</Button>
                    <Button size="sm" onClick={() => setOpenPublish(p)}>جزئیات</Button>
                  </div>
                </div>
                <div className="text-xs clamp-2" style={{ marginTop: 6, lineHeight: 1.8 }}>
                  {p.content?.ready_caption?.slice(0, 160) || p.positioning?.topic?.toString() || p.deliveryId}
                </div>
                <div className="row text-2xs dim" style={{ gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
                  <span className="code">{p.scheduleKey}</span>
                  <span>{p.contentId}</span>
                  {p.rolloverCount > 0 && <span className="chip chip--warn">{fa(p.rolloverCount)} بار تعویق</span>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}

      <Modal
        open={!!openPublish}
        onClose={() => setOpenPublish(null)}
        title={openPublish ? `${openPublish.platformLabel} · ${openPublish.formatLabel}` : ''}
        width={820}
      >
        {openPublish && (
          <div className="stack" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span className="code">{openPublish.deliveryId}</span>
              <span className="code">{openPublish.scheduleKey}</span>
              <span className="chip">{openPublish.platformLabel}</span>
              <span className="chip">{openPublish.formatLabel}</span>
              <span className="chip">{openPublish.funnelStage}</span>
            </div>

            <Field label="کپشن آماده">
              <textarea
                className="textarea"
                rows={4}
                defaultValue={openPublish.content?.ready_caption ?? ''}
                onBlur={async (e) => {
                  const value = e.target.value;
                  if (value === (openPublish.content?.ready_caption ?? '')) return;
                  const updated = await run(
                    () => P.updateContent(openPublish.deliveryId, { ready_caption: value }),
                    { success: 'کپشن ذخیره شد' }
                  );
                  if (updated) {
                    setOpenPublish(updated);
                    await load();
                  }
                }}
              />
            </Field>

            {openPublish.content?.cta && (
              <div>
                <div className="label">دعوت به اقدام</div>
                <div className="text-xs" style={{ lineHeight: 1.9 }}>{openPublish.content.cta}</div>
              </div>
            )}

            {openPublish.content?.timeline && openPublish.content.timeline.length > 0 && (
              <div>
                <div className="label">تایم‌لاین ({fa(openPublish.content.timeline.length)} صحنه)</div>
                <div className="stack" style={{ gap: 6, marginTop: 6 }}>
                  {openPublish.content.timeline.map((t, i) => (
                    <div key={i} className="card card--tight" style={{ background: 'var(--surface-2)' }}>
                      <div className="row-between text-2xs">
                        <span className="chip chip--gold">{t.time}</span>
                        <span className="dim">{t.on_screen_text?.slice(0, 40)}</span>
                      </div>
                      <div className="text-2xs muted" style={{ marginTop: 4, lineHeight: 1.8 }}>{t.narration_script}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setOpenPublish(null)}>بستن</Button>
              <Button onClick={() => void markPublished(openPublish)} variant="ok">
                ثبت به‌عنوان منتشرشده
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
