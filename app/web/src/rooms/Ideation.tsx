import React, { useState } from 'react';
import { api, type Concept, type ConceptsResult, type Subbrand } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Card, Empty, Field, Spinner, fa } from '../components/ui';
import type { RoomProps } from './index';

const SECTIONS: { key: Subbrand; label: string }[] = [
  { key: 'Library', label: 'کتابخانه و SOP' },
  { key: 'Magazine', label: 'مجله' },
  { key: 'Calculators', label: 'ماشین‌حساب‌ها' },
  { key: 'AI', label: 'هوش مصنوعی' },
  { key: 'Solutions', label: 'راهکارها' },
  { key: 'Academy', label: 'آکادمی' },
];

const FUNNEL_LABEL: Record<string, string> = { TOFU: 'آگاهی', MOFU: 'در نظر گرفتن', BOFU: 'تصمیم' };

const STAGES = ['تحلیل موضوع', 'ساخت کانسپت', 'بسته تولید', 'ثبت الگوها'];

export function IdeationRoom({ onNavigate }: RoomProps) {
  const { run, refresh, toast } = useStore();
  const [idea, setIdea] = useState('');
  const [section, setSection] = useState<Subbrand>('Library');
  const [web, setWeb] = useState(false);
  const [concepts, setConcepts] = useState<ConceptsResult | null>(null);
  const [selected, setSelected] = useState<number>(0);
  const [counts, setCounts] = useState({ reels: 1, carousels: 1, article: 1, posts: 0, youtube: 0 });
  const [stage, setStage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [records, setRecords] = useState<{ contentId: string; type: string; title: string }[]>([]);

  const expand = async () => {
    if (idea.trim().length < 3) {
      toast('error', 'موضوع را وارد کنید (حداقل ۳ حرف)');
      return;
    }
    setBusy(true);
    setStage(1);
    const result = await run(() => api.concepts(idea, section, web));
    if (result) {
      setConcepts(result);
      setSelected(0);
      setStage(2);
    } else {
      setStage(0);
    }
    setBusy(false);
  };

  const generate = async () => {
    if (!concepts) return;
    const concept = concepts.concepts[selected];
    setBusy(true);
    setStage(3);
    const result = await run(
      () =>
        api.generate({
          conceptTitle: concept.angleTitle,
          conceptSummary: concept.summary,
          sectionCode: section,
          counts,
        }),
      { success: 'بسته‌ی محتوا ساخته شد' }
    );
    if (result) {
      setRecords(result.records);
      setStage(4);
      await refresh();
    } else {
      setStage(2);
    }
    setBusy(false);
  };

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      {/* pipeline indicator */}
      <Card tight>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {STAGES.map((label, index) => {
            const active = stage === index + 1;
            const done = stage > index + 1;
            return (
              <React.Fragment key={label}>
                <span
                  className="chip"
                  style={{
                    borderColor: active ? 'var(--gold)' : done ? 'rgba(16,185,129,0.5)' : undefined,
                    background: active ? 'rgba(255,180,0,0.16)' : done ? 'rgba(16,185,129,0.12)' : undefined,
                    color: active ? 'var(--gold)' : done ? 'var(--ok)' : undefined,
                    fontWeight: 800,
                  }}
                >
                  {done ? '✓' : fa(index + 1)} {label}
                </span>
                {index < STAGES.length - 1 && <span className="dim" aria-hidden>←</span>}
              </React.Fragment>
            );
          })}
        </div>
      </Card>

      <Card title="موضوع خام را بنویس" subtitle="ایده لازم نیست کامل باشد؛ ایجنت آن را به کانسپت اجرایی تبدیل می‌کند">
        <div className="stack" style={{ gap: 'var(--s-4)' }}>
          <Field label="موضوع / مسئله">
            <textarea
              className="textarea"
              rows={3}
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              placeholder="مثلاً: چگونه ضایعات کافه را کم کنیم؟ یا: ماشین‌حساب نقطه سربه‌سر برای رستوران"
            />
          </Field>
          <div className="grid grid-2">
            <Field label="زیربرند">
              <select className="select" value={section} onChange={(e) => setSection(e.target.value as Subbrand)}>
                {SECTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="جستجوی وب" hint="در حالت آفلاین غیرفعال است و بی‌صدا نادیده گرفته می‌شود">
              <label className="row" style={{ gap: 8, minHeight: 40 }}>
                <input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} style={{ accentColor: 'var(--gold)', width: 16, height: 16 }} />
                <span className="text-xs muted">داده‌های واقعی وب را هم بررسی کن</span>
              </label>
            </Field>
          </div>
          <div className="row">
            <Button variant="primary" loading={busy && stage <= 2} onClick={() => void expand()}>
              تحلیل و ساخت ۳ کانسپت ⚡
            </Button>
            {concepts && <span className="chip chip--gold">منبع: {concepts.mode === 'cloud' ? 'مدل ابری' : 'قالب آفلاین'}</span>}
          </div>
        </div>
      </Card>

      {concepts && (
        <>
          {concepts.topicAnalysis && (
            <Card tight title="تحلیل استراتژیک">
              <p className="text-sm muted" style={{ lineHeight: 2, margin: 0 }}>{concepts.topicAnalysis}</p>
            </Card>
          )}

          <div className="grid grid-3">
            {concepts.concepts.map((concept, index) => (
              <ConceptCard
                key={index}
                concept={concept}
                active={selected === index}
                onSelect={() => setSelected(index)}
              />
            ))}
          </div>

          <Card title="بسته تولید" subtitle="تعداد خروجی‌های هر نوع را تعیین کن">
            <div className="grid grid-5" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px,1fr))', gap: 10 }}>
              {[
                { key: 'reels', label: 'ریلز' },
                { key: 'carousels', label: 'کاروسل' },
                { key: 'article', label: 'مقاله' },
                { key: 'posts', label: 'پست تکی' },
                { key: 'youtube', label: 'یوتیوب' },
              ].map((item) => (
                <Field key={item.key} label={item.label}>
                  <input
                    className="input num"
                    type="number"
                    min={0}
                    max={5}
                    value={counts[item.key as keyof typeof counts]}
                    onChange={(e) =>
                      setCounts((prev) => ({
                        ...prev,
                        [item.key]: Math.max(0, Math.min(5, Number(e.target.value) || 0)),
                      }))
                    }
                  />
                </Field>
              ))}
            </div>
            <div className="row-between" style={{ marginTop: 16 }}>
              <span className="text-xs muted">
                مجموع: <b className="num">{fa(total)}</b> خروجی
                {total === 0 && ' — حداقل یکی لازم است'}
              </span>
              <Button
                variant="primary"
                loading={busy && stage === 3}
                disabled={total === 0}
                onClick={() => void generate()}
              >
                ساخت بسته محتوا ⚡
              </Button>
            </div>
          </Card>
        </>
      )}

      {records.length > 0 && (
        <Card accent title="الگوهای ساخته‌شده" subtitle="برای تولید، ابتدا تایید کن">
          <div className="grid grid-auto">
            {records.map((record) => (
              <div key={record.contentId} className="card card--tight stack" style={{ background: 'var(--surface-2)', gap: 8 }}>
                <div className="row-between">
                  <span className="code">{record.contentId}</span>
                  <span className="chip">{record.type}</span>
                </div>
                <div className="text-sm font-bold clamp-2">{record.title}</div>
                <div className="row" style={{ gap: 6 }}>
                  <Button
                    size="sm"
                    variant="ok"
                    style={{ flex: 1 }}
                    onClick={async () => {
                      await run(() => api.approve([record.contentId]), { success: 'تایید شد' });
                      await refresh();
                    }}
                  >
                    تایید
                  </Button>
                  <Button size="sm" variant="solid" style={{ flex: 1 }} onClick={() => onNavigate('production')}>
                    بازبینی
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {!concepts && !busy && (
        <Empty
          icon="💡"
          title="شروع از یک جمله"
          text="یک مسئله یا فرصت واقعی از کسب‌وکار F&B بنویس. ایجنت سه زاویه دید متمایز با شاخص عددی پیشنهاد می‌دهد."
        />
      )}
    </div>
  );
}

function ConceptCard({ concept, active, onSelect }: { concept: Concept; active: boolean; onSelect: () => void }) {
  return (
    <button
      className="card card--interactive stack"
      onClick={onSelect}
      style={{
        gap: 10,
        textAlign: 'right',
        borderColor: active ? 'var(--gold)' : undefined,
        boxShadow: active ? '0 0 0 1px var(--gold), var(--shadow)' : undefined,
        cursor: 'pointer',
        background: active ? 'rgba(255,180,0,0.05)' : undefined,
      }}
    >
      <div className="row-between">
        <span className="chip chip--gold">{concept.keyMetric || '—'}</span>
        <span className="chip">{FUNNEL_LABEL[concept.recommendedFunnel] ?? concept.recommendedFunnel}</span>
      </div>
      <div className="text-sm font-black" style={{ lineHeight: 1.6 }}>{concept.angleTitle}</div>
      {concept.hook && <div className="text-2xs" style={{ color: 'var(--gold)', fontWeight: 700 }}>«{concept.hook}»</div>}
      <div className="text-2xs muted clamp-2" style={{ lineHeight: 1.8 }}>{concept.summary}</div>
      <div className="row" style={{ marginTop: 'auto' }}>
        <span className={`chip ${active ? 'chip--gold' : ''}`}>{active ? '✓ انتخاب‌شده' : 'انتخاب'}</span>
      </div>
    </button>
  );
}
