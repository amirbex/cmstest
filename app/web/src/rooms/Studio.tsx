import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Content, type Plan, type Scene, type VoiceEngine } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Card, CopyButton, Empty, Field, Progress, Spinner, Tabs, fa } from '../components/ui';
import type { RoomProps } from './index';

type LayerKey = 'logo' | 'title' | 'card';
type SideTab = 'content' | 'voice' | 'render';

/**
 * The layer canvas. This is a real drag surface: pointer events + a transform
 * model identical to the server renderer, so what you drag is what gets
 * rendered. v5.0 only offered numeric X/Y inputs and called it drag-and-drop.
 */
export function StudioRoom({ onNavigate }: RoomProps) {
  const { state, run, refresh, jobs, toast } = useStore();
  const [contents, setContents] = useState<Content[]>([]);
  const [content, setContent] = useState<Content | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<SideTab>('content');
  const [sceneIndex, setSceneIndex] = useState(0);
  const [layer, setLayer] = useState<LayerKey>('card');
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);
  const [saving, setSaving] = useState(false);
  const [engines, setEngines] = useState<VoiceEngine[]>([]);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null);

  /* ── load ── */
  useEffect(() => {
    (async () => {
      const list = await api.contents();
      setContents(list);
      const first = list.find((c) => c.status === 'approved_for_production') ?? list[0];
      if (first) void openContent(first.contentId);
      const e = await api.voiceEngines().catch(() => []);
      setEngines(e);
    })();
  }, []);

  const openContent = async (id: string) => {
    const detail = await api.content(id);
    setContent(detail.content);
    setPlan(structuredClone(detail.content.plan));
    setDirty(false);
    setSceneIndex(0);
    setFrame(0);
    setPreviewUrl(null);
  };

  const activeJob = useMemo(
    () => jobs.find((j) => content && j.contentId === content.contentId && (j.status === 'running' || j.status === 'queued')),
    [jobs, content]
  );

  /* ── playback ── */
  useEffect(() => {
    if (!playing || !plan) return;
    const perScene = 4;
    const total = plan.scenes.length * perScene + 2.5;
    const id = window.setInterval(() => {
      setFrame((prev) => {
        const next = prev + 0.1;
        if (next >= total) {
          setPlaying(false);
          return 0;
        }
        return next;
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [playing, plan]);

  const sceneFromFrame = plan?.scenes.length
    ? Math.min(plan.scenes.length - 1, Math.floor(frame / 4))
    : 0;

  /* ── mutation helpers ── */
  const patchPlan = useCallback(
    (patch: Partial<Plan>) => {
      setPlan((prev) => (prev ? { ...prev, ...patch } : prev));
      setDirty(true);
    },
    []
  );

  const patchScene = useCallback(
    (index: number, patch: Partial<Scene>) => {
      setPlan((prev) => {
        if (!prev) return prev;
        const scenes = prev.scenes.map((s, i) => (i === index ? { ...s, ...patch } : s));
        return { ...prev, scenes };
      });
      setDirty(true);
    },
    []
  );

  const save = async () => {
    if (!content || !plan) return;
    setSaving(true);
    const updated = await run(() => api.updatePlan(content.contentId, plan), { success: 'تغییرات ذخیره شد' });
    setSaving(false);
    if (updated) {
      setContent(updated);
      setDirty(false);
      setContents((prev) => prev.map((c) => (c.contentId === updated.contentId ? updated : c)));
    }
  };

  const render = async (kinds: string[]) => {
    if (!content || !plan) return;
    if (dirty) await save();
    const result = await run(() => api.render(content.contentId, kinds), { success: 'به صف رندر ارسال شد' });
    if (result) {
      await refresh();
      toast('info', 'پیشرفت را در «صف رندر» یا نوار بالا ببین');
    }
  };

  const synthesize = async () => {
    if (!content || !plan) return;
    if (!plan.voiceoverScript.trim()) {
      toast('error', 'ابتدا متن نریشن را بنویس');
      return;
    }
    setVoiceBusy(true);
    const result = await run(
      () => api.synthesize(plan.voiceoverScript, 'auto', content.contentId),
      { success: 'صدا ساخته شد' }
    );
    setVoiceBusy(false);
    if (result) {
      patchPlan({ audio: { ...plan.audio, file: result.file, durationSec: result.durationSec, engine: result.engine, words: result.words } });
      await refresh();
    }
  };

  /* ── drag interactions ── */
  const onPointerDown = (key: LayerKey) => (e: React.PointerEvent) => {
    if (!plan) return;
    setLayer(key);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      baseX: key === 'logo' ? plan.layout.logoX : 0,
      baseY: key === 'logo' ? plan.layout.logoY : key === 'title' ? plan.layout.titleY : plan.layout.cardY,
    };
  };

  const onPointerMove = (key: LayerKey) => (e: React.PointerEvent) => {
    if (!dragRef.current || !canvasRef.current || !plan) return;
    const rect = canvasRef.current.getBoundingClientRect();
    /* canvas is rendered at 1/4 of the real 1080×1920 output */
    const scale = 1080 / rect.width;
    const dx = (e.clientX - dragRef.current.x) * scale;
    const dy = (e.clientY - dragRef.current.y) * scale;
    const next = {
      ...plan.layout,
      ...(key === 'logo'
        ? { logoX: Math.round(dragRef.current.baseX + dx), logoY: Math.round(dragRef.current.baseY + dy) }
        : key === 'title'
          ? { titleY: Math.round(dragRef.current.baseY + dy) }
          : { cardY: Math.round(dragRef.current.baseY + dy) }),
    };
    patchPlan({ layout: next });
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  /* ── preview still from the real renderer ── */
  const requestPreview = async () => {
    if (!plan) return;
    const result = await run(() => api.preview(plan, frame, content?.contentId), { silent: true });
    if (result) setPreviewUrl(result.url);
    else toast('error', 'پیش‌نمایش رندر نشد');
  };

  if (!contents.length) {
    return (
      <Empty
        icon="🎬"
        title="هنوز محتوایی برای تدوین نیست"
        text="ابتدا از اتاق فکر یا برنامه ۳ ماهه یک الگو بساز و تایید کن."
        action={<Button variant="primary" onClick={() => onNavigate('ideation')}>رفتن به اتاق فکر</Button>}
      />
    );
  }

  const scene = plan?.scenes[sceneIndex];
  const theme = plan ? state?.brand.sectionThemes[plan.sectionCode] : undefined;

  return (
    <div className="stack" style={{ gap: 'var(--s-4)' }}>
      {/* content switcher */}
      <div className="row-between">
        <div className="row" style={{ minWidth: 0, flex: 1 }}>
          <select
            className="select"
            style={{ maxWidth: 380 }}
            value={content?.contentId ?? ''}
            onChange={(e) => void openContent(e.target.value)}
          >
            {contents.map((c) => (
              <option key={c.contentId} value={c.contentId}>
                {c.contentId} — {c.title.slice(0, 42)}
              </option>
            ))}
          </select>
          {content && <span className="code">{content.contentId}</span>}
          {dirty && <span className="chip chip--warn">تغییرات ذخیره نشده</span>}
        </div>
        <div className="row">
          <Button size="sm" variant="ghost" onClick={() => void requestPreview()}>پیش‌نمایش دقیق</Button>
          <Button size="sm" variant="solid" loading={saving} disabled={!dirty} onClick={() => void save()}>
            💾 ذخیره
          </Button>
        </div>
      </div>

      {activeJob && (
        <Card tight accent>
          <div className="row-between" style={{ marginBottom: 8 }}>
            <span className="text-sm font-bold">
              {activeJob.kind === 'reel' ? '🎬 رندر ریلز' : activeJob.kind === 'carousel' ? '📑 کاروسل' : '🖼️ کاور'} در حال اجرا
            </span>
            <span className="text-2xs muted">{activeJob.step}</span>
          </div>
          <Progress value={activeJob.progress} />
        </Card>
      )}

      <div className="studio-grid">
        {/* ── left: canvas + timeline ── */}
        <div className="stack" style={{ gap: 'var(--s-4)' }}>
          <Card
            title="بوم لایه‌ای"
            subtitle="هر لایه را با موس بگیر و بکش — همان چیزی که می‌بینی رندر می‌شود"
            actions={
              <span className="chip" style={{ direction: 'ltr' }}>
                {fa(1080)}×{fa(1920)}
              </span>
            }
          >
            <div className="row" style={{ justifyContent: 'center' }}>
              <div
                ref={canvasRef}
                className="canvas-frame"
                style={{ background: theme?.mode === 'dark' ? theme.bg : theme?.bg ?? '#F8FAFC' }}
              >
                <CanvasPreview
                  plan={plan}
                  sceneIndex={sceneFromFrame}
                  theme={theme}
                  layer={layer}
                  brandName={state?.brand.brandName ?? 'AtoZ'}
                  domain={state?.brand.domain ?? ''}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                />
              </div>
            </div>

            {/* scrubber */}
            <div className="stack" style={{ gap: 8, marginTop: 16 }}>
              <div className="row">
                <Button size="sm" variant={playing ? 'primary' : 'solid'} onClick={() => setPlaying((p) => !p)}>
                  {playing ? '⏸ مکث' : '▶ پخش'}
                </Button>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, (plan?.scenes.length ?? 1) * 4 + 2.5)}
                  step={0.1}
                  value={frame}
                  onChange={(e) => setFrame(Number(e.target.value))}
                  style={{ flex: 1, accentColor: 'var(--gold)' }}
                  aria-label="اسکرابر زمان"
                />
                <span className="mono text-xs" style={{ minWidth: 74, textAlign: 'center' }}>
                  {fa(frame.toFixed(1))}ث / {fa(((plan?.scenes.length ?? 1) * 4 + 2.5).toFixed(0))}ث
                </span>
              </div>
            </div>
          </Card>

          {/* timeline */}
          <Card title="تایم‌لاین چندتراکه" subtitle="برای پرش، روی هر بلوک کلیک کن">
            <div className="stack" style={{ gap: 8 }}>
              <Track label="صحنه‌ها" color="var(--info)">
                <div style={{ display: 'flex', gap: 4, width: '100%' }}>
                  {plan?.scenes.map((s, i) => {
                    const active = sceneFromFrame === i;
                    return (
                      <button
                        key={i}
                        onClick={() => {
                          setSceneIndex(i);
                          setFrame(i * 4);
                        }}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          padding: '6px 8px',
                          borderRadius: 'var(--r-xs)',
                          border: `1px solid ${active ? 'var(--gold)' : 'var(--border)'}`,
                          background: active ? 'rgba(255,180,0,0.16)' : 'var(--surface-2)',
                          color: 'inherit',
                          fontFamily: 'inherit',
                          fontSize: 10,
                          fontWeight: 700,
                          cursor: 'pointer',
                          textAlign: 'right',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {fa(i + 1)}. {s.cardTitle || '—'}
                      </button>
                    );
                  })}
                </div>
              </Track>
              <Track label="نریشن" color="#a78bfa">
                <div className="text-2xs muted truncate" style={{ padding: '6px 8px', background: 'var(--surface-2)', borderRadius: 'var(--r-xs)', width: '100%' }}>
                  {plan?.audio.file ? `🎙️ ${plan.audio.engine} — ${fa(plan.audio.durationSec.toFixed(1))} ثانیه` : 'بدون صدا — از تب صدا بساز'}
                </div>
              </Track>
              <Track label="لوگوموشن" color="var(--ok)">
                <div style={{ display: 'flex', gap: 4, width: '100%' }}>
                  <div className="text-2xs" style={{ flex: 4, padding: '6px 8px', background: 'var(--surface-2)', borderRadius: 'var(--r-xs)', color: 'var(--text-muted)' }}>
                    محتوای اصلی
                  </div>
                  <div className="text-2xs" style={{ flex: 1, padding: '6px 8px', background: 'rgba(255,180,0,0.18)', borderRadius: 'var(--r-xs)', color: 'var(--gold)', textAlign: 'center', fontWeight: 800 }}>
                    Outro
                  </div>
                </div>
              </Track>
            </div>
          </Card>
        </div>

        {/* ── right: inspector ── */}
        <div className="stack" style={{ gap: 'var(--s-4)' }}>
          <Card tight flush>
            <div style={{ padding: 12 }}>
              <Tabs<SideTab>
                tabs={[
                  { key: 'content', label: 'محتوا' },
                  { key: 'voice', label: 'صدا' },
                  { key: 'render', label: 'خروجی' },
                ]}
                value={tab}
                onChange={setTab}
              />
            </div>

            <div style={{ padding: '0 16px 16px' }}>
              {tab === 'content' && plan && (
                <div className="stack" style={{ gap: 12 }}>
                  <Field label="تیتر">
                    <input className="input" value={plan.title} onChange={(e) => patchPlan({ title: e.target.value })} />
                  </Field>
                  <Field label="زیرتیتر">
                    <input className="input" value={plan.subtitle} onChange={(e) => patchPlan({ subtitle: e.target.value })} />
                  </Field>
                  <div className="grid grid-2" style={{ gap: 10 }}>
                    <Field label="زیربرند">
                      <select
                        className="select"
                        value={plan.sectionCode}
                        onChange={(e) => patchPlan({ sectionCode: e.target.value as Plan['sectionCode'] })}
                      >
                        {Object.keys(state?.brand.sectionThemes ?? {}).map((key) => (
                          <option key={key} value={key}>{key}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="تم">
                      <select
                        className="select"
                        value={plan.layout.theme}
                        onChange={(e) => patchPlan({ layout: { ...plan.layout, theme: e.target.value as 'auto' | 'dark' | 'light' } })}
                      >
                        <option value="auto">خودکار</option>
                        <option value="dark">تاریک</option>
                        <option value="light">روشن</option>
                      </select>
                    </Field>
                  </div>

                  <div className="divider" />

                  <div className="row-between">
                    <span className="label">صحنه‌ها ({fa(plan.scenes.length)})</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        patchPlan({
                          scenes: [
                            ...plan.scenes,
                            {
                              id: plan.scenes.length + 1,
                              eyebrow: 'صحنه جدید',
                              cardTitle: 'عنوان صحنه',
                              metric: '',
                              metricCaption: '',
                              items: [],
                              chartData: [],
                              narration: '',
                              durationSec: 4,
                              motion: 'fade-up',
                            },
                          ],
                        })
                      }
                    >
                      + افزودن
                    </Button>
                  </div>

                  {plan.scenes.map((s, i) => (
                    <div
                      key={i}
                      className="card card--tight stack"
                      style={{
                        gap: 8,
                        background: 'var(--surface-2)',
                        borderColor: sceneIndex === i ? 'var(--gold)' : undefined,
                      }}
                    >
                      <div className="row-between">
                        <button className="btn btn--ghost btn--sm" onClick={() => setSceneIndex(i)}>
                          صحنه {fa(i + 1)}
                        </button>
                        <button
                          className="btn btn--ghost btn--sm btn--icon"
                          title="حذف"
                          onClick={() => patchPlan({ scenes: plan.scenes.filter((_, idx) => idx !== i) })}
                        >
                          ✕
                        </button>
                      </div>
                      <input
                        className="input"
                        value={s.cardTitle}
                        placeholder="عنوان کارت"
                        onChange={(e) => patchScene(i, { cardTitle: e.target.value })}
                      />
                      <div className="grid grid-2" style={{ gap: 8 }}>
                        <input
                          className="input"
                          value={s.metric}
                          placeholder="شاخص (+۴۰٪)"
                          onChange={(e) => patchScene(i, { metric: e.target.value })}
                        />
                        <input
                          className="input"
                          value={s.eyebrow}
                          placeholder="برچسب (گام اول)"
                          onChange={(e) => patchScene(i, { eyebrow: e.target.value })}
                        />
                      </div>
                      <textarea
                        className="textarea"
                        rows={2}
                        value={s.narration}
                        placeholder="متن نریشن این صحنه"
                        onChange={(e) => patchScene(i, { narration: e.target.value })}
                      />
                      <input
                        className="input"
                        value={s.items.join(' · ')}
                        placeholder="نکته‌ها با · جدا شوند"
                        onChange={(e) => patchScene(i, { items: e.target.value.split('·').map((x) => x.trim()).filter(Boolean) })}
                      />
                    </div>
                  ))}

                  <div className="divider" />

                  <div className="row-between">
                    <span className="label">لایه فعال: {layer === 'logo' ? 'لوگو' : layer === 'title' ? 'تیتر' : 'کارت شاخص'}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => patchPlan({ layout: { ...plan.layout, logoX: 0, logoY: 0, titleY: 0, cardY: 0 } })}
                    >
                      ↺ بازنشانی
                    </Button>
                  </div>
                  <div className="grid grid-3" style={{ gap: 8 }}>
                    <Field label="X لوگو">
                      <input
                        className="input num"
                        type="number"
                        value={plan.layout.logoX}
                        onChange={(e) => patchPlan({ layout: { ...plan.layout, logoX: Number(e.target.value) || 0 } })}
                      />
                    </Field>
                    <Field label="Y لوگو">
                      <input
                        className="input num"
                        type="number"
                        value={plan.layout.logoY}
                        onChange={(e) => patchPlan({ layout: { ...plan.layout, logoY: Number(e.target.value) || 0 } })}
                      />
                    </Field>
                    <Field label="Y کارت">
                      <input
                        className="input num"
                        type="number"
                        value={plan.layout.cardY}
                        onChange={(e) => patchPlan({ layout: { ...plan.layout, cardY: Number(e.target.value) || 0 } })}
                      />
                    </Field>
                  </div>
                </div>
              )}

              {tab === 'voice' && plan && (
                <div className="stack" style={{ gap: 12 }}>
                  <Field label="متن نریشن" hint="فارسی روان بنویس؛ اعداد را با کلمه بنویس تا صدا طبیعی‌تر شود">
                    <textarea
                      className="textarea"
                      rows={7}
                      value={plan.voiceoverScript}
                      onChange={(e) => patchPlan({ voiceoverScript: e.target.value })}
                    />
                  </Field>
                  <div className="text-2xs dim">{fa(plan.voiceoverScript.length)} کاراکتر</div>

                  <div className="row-between">
                    <span className="label">موتورهای صدا</span>
                  </div>
                  <div className="stack" style={{ gap: 6 }}>
                    {engines.length === 0 && <div className="text-2xs dim">در حال بررسی موتورها…</div>}
                    {engines.map((engine) => (
                      <div key={engine.id} className="row-between text-2xs" style={{ padding: '5px 8px', background: 'var(--surface-2)', borderRadius: 'var(--r-sm)' }}>
                        <span>{engine.label}</span>
                        <span className={`chip ${engine.available ? 'chip--ok' : 'chip--danger'}`} style={{ fontSize: 9 }}>
                          {engine.available ? 'در دسترس' : 'نصب نیست'}
                        </span>
                      </div>
                    ))}
                  </div>

                  <Button variant="primary" block loading={voiceBusy} onClick={() => void synthesize()}>
                    🎙️ ساخت صدا
                  </Button>

                  {plan.audio.file && (
                    <div className="card card--tight stack" style={{ background: 'var(--surface-2)', gap: 8 }}>
                      <div className="text-2xs muted">
                        {plan.audio.engine} — {fa(plan.audio.durationSec.toFixed(1))} ثانیه
                        {plan.audio.words.length > 0 && ` · ${fa(plan.audio.words.length)} کلمه زمان‌بندی‌شده`}
                      </div>
                      <audio controls src={`/media/audio/${plan.audio.file.split('/').pop()}`} style={{ width: '100%' }} />
                    </div>
                  )}

                  {!plan.audio.file && (
                    <div className="text-2xs dim" style={{ lineHeight: 1.9 }}>
                      اگر هیچ موتور صدایی نصب نباشد، رندر ویدئو بی‌صدا انجام می‌شود و همینجا هشدار می‌گیری — هیچ‌وقت فایل خالی جعل نمی‌شود.
                    </div>
                  )}
                </div>
              )}

              {tab === 'render' && plan && (
                <div className="stack" style={{ gap: 12 }}>
                  <div className="text-2xs muted" style={{ lineHeight: 1.9 }}>
                    رندر کاملاً آفلاین انجام می‌شود (SVG → PNG → ffmpeg). هیچ مرورگر یا سرویس ابری لازم نیست.
                  </div>
                  <Button variant="primary" block onClick={() => void render(['cover'])}>🖼️ رندر کاور</Button>
                  <Button variant="solid" block onClick={() => void render(['carousel'])}>📑 رندر کاروسل</Button>
                  <Button variant="solid" block onClick={() => void render(['reel'])}>🎬 رندر ریلز (MP4)</Button>
                  <Button variant="ok" block onClick={() => void render(['cover', 'carousel', 'reel'])}>📦 بسته کامل</Button>
                  <div className="divider" />
                  <div className="row-between">
                    <span className="text-2xs muted">صحت خروجی</span>
                    <Button size="sm" variant="ghost" onClick={() => void requestPreview()}>پیش‌نمایش PNG</Button>
                  </div>
                  {previewUrl && (
                    <div className="stack" style={{ gap: 6 }}>
                      <img src={previewUrl} alt="پیش‌نمایش فریم" style={{ width: '100%', borderRadius: 'var(--r-md)' }} />
                      <a href={previewUrl} target="_blank" rel="noreferrer" className="btn btn--ghost btn--sm">باز کردن تصویر</a>
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────── canvas ────────────────────────── */

function CanvasPreview({
  plan,
  sceneIndex,
  theme,
  layer,
  brandName,
  domain,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  plan: Plan | null;
  sceneIndex: number;
  theme?: { accent: string; bg: string; mode: string; name: string };
  layer: LayerKey;
  brandName: string;
  domain: string;
  onPointerDown: (key: LayerKey) => (e: React.PointerEvent) => void;
  onPointerMove: (key: LayerKey) => (e: React.PointerEvent) => void;
  onPointerUp: () => void;
}) {
  if (!plan) return null;
  const scene = plan.scenes[sceneIndex] ?? plan.scenes[0];
  const isDark = (theme?.mode ?? 'light') === 'dark';
  const fg = isDark ? '#F8FAFC' : '#0A1931';
  const layout = plan.layout;
  const S = 300 / 1080; /* canvas scale factor */

  const layerStyle = (key: LayerKey, extra?: React.CSSProperties): React.CSSProperties => ({
    cursor: 'grab',
    outline: layer === key ? '2px dashed var(--gold)' : 'none',
    outlineOffset: 2,
    touchAction: 'none',
    ...extra,
  });

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 12 * (300 / 300), direction: 'rtl' }}>
      {/* header */}
      <div
        onPointerDown={onPointerDown('logo')}
        onPointerMove={onPointerMove('logo')}
        onPointerUp={onPointerUp}
        style={layerStyle('logo', {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          transform: `translate(${layout.logoX * S}px, ${layout.logoY * S}px)`,
        })}
      >
        <span style={{ fontSize: 10, fontWeight: 900, color: fg }}>{brandName}</span>
        <span
          style={{
            fontSize: 8,
            fontWeight: 800,
            padding: '2px 7px',
            borderRadius: 999,
            background: theme?.accent ?? '#3B5998',
            color: '#fff',
          }}
        >
          {plan.sectionCode}
        </span>
      </div>

      <div style={{ height: 3, background: 'var(--gold)', borderRadius: 2, margin: '6px 0', width: '62%' }} />

      {/* title */}
      <div
        onPointerDown={onPointerDown('title')}
        onPointerMove={onPointerMove('title')}
        onPointerUp={onPointerUp}
        style={layerStyle('title', {
          background: isDark ? 'rgba(255,255,255,0.07)' : '#EAF2FE',
          borderRadius: 8,
          padding: '7px 8px',
          transform: `translateY(${layout.titleY * S}px)`,
        })}
      >
        <div style={{ fontSize: 11, fontWeight: 900, color: fg, lineHeight: 1.5, textAlign: 'center' }}>
          {plan.title || 'عنوان محتوا'}
        </div>
      </div>

      {/* hero card */}
      <div
        onPointerDown={onPointerDown('card')}
        onPointerMove={onPointerMove('card')}
        onPointerUp={onPointerUp}
        style={layerStyle('card', {
          marginTop: 10,
          background: isDark ? '#101B33' : '#0A1931',
          borderRadius: 10,
          padding: 9,
          transform: `translateY(${layout.cardY * S}px)`,
        })}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 900, color: '#F8FAFC', lineHeight: 1.5, flex: 1 }}>
            {scene?.cardTitle ?? '—'}
          </div>
          {scene?.metric && (
            <span style={{ fontSize: 13, fontWeight: 900, color: 'var(--gold)', flexShrink: 0 }}>{scene.metric}</span>
          )}
        </div>
        {scene?.chartData && scene.chartData.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {scene.chartData.map((d, i) => {
              const max = Math.max(...scene.chartData.map((x) => x.value), 1);
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 26, fontSize: 7, color: '#94a3b8', textAlign: 'right', flexShrink: 0 }}>{d.label}</div>
                  <div style={{ flex: 1, height: 5, background: 'rgba(255,255,255,0.1)', borderRadius: 3 }}>
                    <div
                      style={{
                        width: `${(d.value / max) * 100}%`,
                        height: '100%',
                        borderRadius: 3,
                        background: i === 0 ? 'var(--gold)' : i === 1 ? (theme?.accent ?? '#3B5998') : '#5D5FEF',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* bullets */}
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {(scene?.items ?? []).slice(0, 3).map((item, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: isDark ? 'rgba(255,255,255,0.07)' : '#fff',
              borderRadius: 6,
              padding: '4px 6px',
            }}
          >
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: 4,
                background: i === 1 ? 'var(--gold)' : (theme?.accent ?? '#3B5998'),
                color: i === 1 ? '#0A0A0C' : '#fff',
                fontSize: 7,
                fontWeight: 900,
                display: 'grid',
                placeItems: 'center',
                flexShrink: 0,
              }}
            >
              {fa(i + 1)}
            </span>
            <span style={{ fontSize: 8, fontWeight: 700, color: fg, lineHeight: 1.4 }}>{item}</span>
          </div>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      {/* caption band */}
      <div
        style={{
          background: 'rgba(10,25,49,0.94)',
          borderRadius: 7,
          padding: '5px 7px',
          borderRight: '3px solid var(--gold)',
          marginBottom: 6,
        }}
      >
        <div style={{ fontSize: 8, fontWeight: 800, color: '#fff', lineHeight: 1.5, textAlign: 'right' }}>
          {scene?.narration || scene?.cardTitle || 'متن نریشن'}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 7, color: isDark ? 'rgba(248,250,252,0.55)' : 'rgba(10,25,49,0.55)' }}>
        <span className="ltr">{domain}</span>
        <span>{fa(sceneIndex + 1)} / {fa(plan.scenes.length)}</span>
      </div>
    </div>
  );
}

function Track({ label, color, children }: { label: string; color: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="text-2xs font-bold" style={{ width: 66, flexShrink: 0, color }}>{label}</span>
      <div style={{ flex: 1, display: 'flex', minWidth: 0 }}>{children}</div>
    </div>
  );
}
