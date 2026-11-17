import React, { useEffect, useState } from 'react';
import { api, type MonthBoard, type WeekBoard, type CalendarItem } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Card, Empty, SectionBadge, StatusChip, Tabs, fa } from '../components/ui';
import type { RoomProps } from './index';

type View = 'week' | 'month';

export function CalendarRoom({ onNavigate }: RoomProps) {
  const { state, run, refresh } = useStore();
  const [view, setView] = useState<View>('week');
  const [week, setWeek] = useState<WeekBoard | null>(null);
  const [month, setMonth] = useState<MonthBoard | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [w, m] = await Promise.all([api.week(), api.month()]);
      setWeek(w);
      setMonth(m);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const doPublish = async (deliveryId: string) => {
    await run(() => api.publish(deliveryId), { success: 'به‌عنوان منتشرشده ثبت شد' });
    await load();
    await refresh();
  };

  const doRollover = async (deliveryId: string) => {
    await run(() => api.rollover(deliveryId, 1), { success: 'یک روز به تعویق افتاد' });
    await load();
  };

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <div className="row-between">
        <div className="row">
          <Tabs<View>
            tabs={[
              { key: 'week', label: 'نمای هفته' },
              { key: 'month', label: 'نمای ماه' },
            ]}
            value={view}
            onChange={setView}
          />
          {week?.today && (
            <span className="chip chip--gold">
              امروز: {week.today.weekday} {week.today.jalaliDigits}
            </span>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading}>↻ بروزرسانی</Button>
      </div>

      {view === 'week' && (
        <div className="calendar-week">
          {week?.days.map((day) => (
            <div
              key={day.iso}
              className="card card--tight stack"
              style={{
                minHeight: 260,
                gap: 10,
                borderColor: day.isToday ? 'rgba(255,180,0,0.5)' : undefined,
                background: day.isToday ? 'rgba(255,180,0,0.05)' : undefined,
              }}
            >
              <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                <div className="row-between">
                  <span className="text-xs font-black">{day.weekday}</span>
                  {day.isToday && <span className="chip chip--gold" style={{ fontSize: 9, padding: '1px 6px' }}>امروز</span>}
                </div>
                <div className="text-2xs" style={{ color: 'var(--gold)', fontWeight: 700 }}>{day.jalaliDigits}</div>
              </div>
              <div className="stack" style={{ gap: 6 }}>
                {day.count === 0 ? (
                  <div className="text-2xs dim" style={{ textAlign: 'center', padding: '20px 0' }}>—</div>
                ) : (
                  day.items.map((item: CalendarItem) => (
                    <div
                      key={item.deliveryId}
                      className="stack"
                      style={{
                        gap: 4,
                        padding: 8,
                        borderRadius: 'var(--r-sm)',
                        border: '1px solid var(--border)',
                        background: 'var(--surface-2)',
                      }}
                    >
                      <div className="text-2xs font-bold clamp-2" style={{ lineHeight: 1.6 }}>{item.title}</div>
                      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                        <StatusChip status={item.status} />
                      </div>
                      {item.status === 'published' ? (
                        <span className="text-2xs" style={{ color: 'var(--ok)' }}>✓ منتشر شد</span>
                      ) : (
                        <div className="row" style={{ gap: 4 }}>
                          <button className="btn btn--ok btn--sm" style={{ flex: 1, minHeight: 24, fontSize: 10 }} onClick={() => void doPublish(item.deliveryId)}>
                            انتشار
                          </button>
                          <button
                            className="btn btn--ghost btn--sm btn--icon"
                            style={{ minHeight: 24, minWidth: 24 }}
                            title="یک روز تعویق"
                            onClick={() => void doRollover(item.deliveryId)}
                          >
                            ⏭
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'month' && month && (
        <Card title={`${month.monthName} ${fa(month.year)}`} subtitle="تقویم شمسی واقعی — هفته از شنبه">
          <div className="grid" style={{ gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
            {month.weekdays.map((name) => (
              <div key={name} className="text-2xs font-bold muted" style={{ textAlign: 'center', padding: '4px 0' }}>
                {name}
              </div>
            ))}
            {month.cells.map((cell, index) =>
              cell.empty ? (
                <div key={`e-${index}`} />
              ) : (
                <div
                  key={cell.iso}
                  className="card card--tight"
                  style={{
                    minHeight: 72,
                    padding: 8,
                    background: cell.isToday ? 'rgba(255,180,0,0.08)' : 'var(--surface-2)',
                    borderColor: cell.isToday ? 'rgba(255,180,0,0.5)' : undefined,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <div className="row-between">
                    <span className="text-2xs font-black" style={{ color: cell.isToday ? 'var(--gold)' : undefined }}>
                      {fa(cell.day ?? '')}
                    </span>
                    {(cell.count ?? 0) > 0 && (
                      <span className="chip chip--gold" style={{ fontSize: 9, padding: '0 5px' }}>{fa(cell.count ?? 0)}</span>
                    )}
                  </div>
                  {(cell.count ?? 0) > 0 && (
                    <div className="text-2xs dim" style={{ lineHeight: 1.5 }}>
                      {fa(cell.count ?? 0)} محتوا
                    </div>
                  )}
                </div>
              )
            )}
          </div>
        </Card>
      )}

      {week && week.days.every((d) => d.count === 0) && (
        <Empty
          icon="📅"
          title="هیچ محتوایی زمان‌بندی نشده"
          text="پس از تولید خروجی در استودیو، محتواها با تاریخ خودکار در این تقویم قرار می‌گیرند."
          action={<Button size="sm" variant="primary" onClick={() => onNavigate('studio')}>رفتن به استودیو</Button>}
        />
      )}

      <Card title="راهنمای تقویم" subtitle="چطور از این صفحه استفاده کنم؟">
        <ul className="text-xs muted" style={{ lineHeight: 2, paddingInlineStart: 18, margin: 0 }}>
          <li>هفته از <b>شنبه</b> شروع می‌شود و تاریخ‌ها شمسی واقعی هستند (نه برچسب ثابت).</li>
          <li>تنها محتوای <b>تولیدشده</b> در تقویم نمایش داده می‌شود؛ ایده‌های خام اینجا نمی‌آیند.</li>
          <li>دکمه «انتشار» وضعیت را به منتشرشده تغییر می‌دهد و شناسه پست را ثبت می‌کند.</li>
          <li>دکمه ⏭ تحویل را یک روز جابه‌جا می‌کند و تعداد تعویق‌ها را می‌شمارد.</li>
        </ul>
      </Card>
    </div>
  );
}
