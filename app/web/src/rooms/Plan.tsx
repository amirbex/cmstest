import React, { useEffect, useRef, useState } from 'react';
import { api, type Content } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Card, Empty, Modal, SectionBadge, StatusChip, Tabs, fa, fmtRelative } from '../components/ui';
import type { RoomProps } from './index';

type Tab = 'blocks' | 'pending' | 'ingest';

const BLOCK_STATUS: Record<string, { label: string; tone: string; icon: string }> = {
  waiting_upload: { label: 'در انتظار فایل', tone: 'muted', icon: '⬜' },
  blueprint_pending: { label: 'در انتظار تایید', tone: 'warn', icon: '🟨' },
  approved_for_production: { label: 'تاییدشده', tone: 'ok', icon: '🟩' },
};

export function PlanRoom({ onNavigate }: RoomProps) {
  const { run, refresh } = useStore();
  const [tab, setTab] = useState<Tab>('pending');
  const [blocks, setBlocks] = useState<Awaited<ReturnType<typeof api.blocks>>>([]);
  const [pending, setPending] = useState<Content[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Content | null>(null);
  const [ingestResult, setIngestResult] = useState<{ contentsCreated: number; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const [b, p] = await Promise.all([api.blocks(), api.contents({ status: 'blueprint_pending' })]);
    setBlocks(b);
    setPending(p);
  };

  useEffect(() => {
    void load();
  }, []);

  const approve = async (ids?: string[]) => {
    setBusy(true);
    const target = ids ?? [...selected];
    const result = await run(
      () => api.approve(target.length ? target : undefined),
      { success: 'الگوها تایید شدند' }
    );
    setBusy(false);
    if (result) {
      setSelected(new Set());
      await load();
      await refresh();
    }
  };

  const onFile = async (file: File) => {
    setBusy(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('فایل JSON معتبر نیست');
      }
      const result = await run(() => api.ingest(parsed), { success: 'بلوک با موفقیت ثبت شد' });
      if (result) {
        setIngestResult({ contentsCreated: result.contentsCreated, warnings: result.warnings ?? [] });
        await load();
        await refresh();
        setTab('pending');
      }
    } catch (err) {
      await run(async () => {
        throw err;
      });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const downloadSample = () => {
    const sample = {
      schema_metadata: { period_code: 'M01-W01-PART2', batch_id: 'ATZ-B-M01-W01-P2' },
      content_ideas: [
        { title: 'چطور منوی فصلی را بدون افزایش هزینه طراحی کنیم', thread: 'طراحی منو با حاشیه سود', pillar: 'P5' },
      ],
      deliveries: [
        {
          content_id: 'ATZ-C-910001',
          delivery_id: 'ATZ-D-910001',
          format_type: 'reel',
          schedule_key: 'M01-W01-D03-IG-ANM-01',
          funnel_stage: 'TOFU',
          content_pillar: 'P5',
          strategic_positioning: { topic: 'منوی فصلی سودآور' },
          exact_content: {
            ready_caption: 'منوی فصلی می‌تواند حاشیه سود را بالا ببرد — اگر درست طراحی شود.',
            timeline: [
              { time: '۰–۳ ثانیه', on_screen_text: 'منوی فصلی = سود بیشتر؟', narration_script: 'منوی فصلی اگر درست طراحی شود، هم هزینه را کم می‌کند هم تجربه را بهتر.' },
              { time: '۳–۹ ثانیه', on_screen_text: 'سه معیار انتخاب آیتم', narration_script: 'سه معیار: حاشیه سود، سرعت آماده‌سازی و دسترسی مواد اولیه.' },
            ],
          },
        },
      ],
    };
    const blob = new Blob([JSON.stringify(sample, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'atoz-block-sample.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <div className="row-between">
        <Tabs<Tab>
          tabs={[
            { key: 'pending', label: 'الگوهای در انتظار تایید', count: pending.length },
            { key: 'blocks', label: 'بلوک‌های ۳ ماهه', count: blocks.length },
            { key: 'ingest', label: 'ورود بلوک جدید' },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="row">
          <Button size="sm" variant="ghost" onClick={() => void load()}>↻</Button>
          {tab === 'pending' && pending.length > 0 && (
            <>
              <Button size="sm" variant="solid" onClick={() => setSelected(new Set(pending.map((p) => p.contentId)))}>
                انتخاب همه
              </Button>
              <Button size="sm" variant="primary" loading={busy} onClick={() => void approve()}>
                {selected.size > 0 ? `تایید ${fa(selected.size)} مورد` : 'تایید همه'} ✅
              </Button>
            </>
          )}
        </div>
      </div>

      {ingestResult && (
        <Card accent tight title="نتیجه ورود بلوک">
          <div className="text-sm">
            {fa(ingestResult.contentsCreated)} محتوا ثبت شد و در انتظار تایید است.
          </div>
          {ingestResult.warnings.map((w, i) => (
            <div key={i} className="text-2xs" style={{ color: 'var(--warn)', marginTop: 6 }}>⚠ {w}</div>
          ))}
          <Button size="sm" variant="ghost" style={{ marginTop: 8 }} onClick={() => setIngestResult(null)}>بستن</Button>
        </Card>
      )}

      {tab === 'pending' && (
        pending.length === 0 ? (
          <Empty
            icon="✨"
            title="هیچ الگویی در انتظار تایید نیست"
            text="یک بلوک JSON وارد کن یا از اتاق فکر یک بسته محتوا بساز."
            action={
              <div className="row">
                <Button size="sm" variant="primary" onClick={() => setTab('ingest')}>ورود بلوک</Button>
                <Button size="sm" variant="solid" onClick={() => onNavigate('ideation')}>اتاق فکر</Button>
              </div>
            }
          />
        ) : (
          <div className="grid grid-auto">
            {pending.map((content) => (
              <div
                key={content.contentId}
                className="card stack"
                style={{
                  gap: 10,
                  borderColor: selected.has(content.contentId) ? 'var(--gold)' : undefined,
                  boxShadow: selected.has(content.contentId) ? '0 0 0 1px var(--gold)' : undefined,
                }}
              >
                <div className="row-between">
                  <span className="code">{content.contentId}</span>
                  <input
                    type="checkbox"
                    checked={selected.has(content.contentId)}
                    onChange={() => toggle(content.contentId)}
                    aria-label={`انتخاب ${content.title}`}
                    style={{ width: 16, height: 16, accentColor: 'var(--gold)', cursor: 'pointer' }}
                  />
                </div>
                <div className="text-sm font-black clamp-2" style={{ lineHeight: 1.6 }}>{content.title}</div>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <SectionBadge section={content.sectionCode} />
                  <span className="chip">{content.deliverableType}</span>
                  <span className="chip">{content.funnelStage}</span>
                </div>
                <div className="text-2xs dim">
                  {content.plan.scenes.length} صحنه · {content.plan.carouselSlides.length} اسلاید · {fmtRelative(content.createdAt)}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <Button size="sm" variant="solid" style={{ flex: 1 }} onClick={() => setPreview(content)}>
                    پیش‌نمایش
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    style={{ flex: 1 }}
                    onClick={() => void approve([content.contentId])}
                  >
                    تایید
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'blocks' && (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
          {blocks.map((block) => {
            const meta = BLOCK_STATUS[block.status] ?? BLOCK_STATUS.waiting_upload;
            return (
              <div
                key={block.periodCode}
                className="card card--tight stack"
                style={{
                  gap: 6,
                  borderColor: block.status !== 'waiting_upload' ? 'rgba(255,180,0,0.4)' : undefined,
                }}
              >
                <div className="row-between">
                  <span className="code" style={{ color: 'var(--gold)', fontWeight: 800 }}>{block.periodCode}</span>
                  <span aria-hidden>{meta.icon}</span>
                </div>
                <div className="text-2xs font-bold">{block.phaseTitle}</div>
                <div className="text-2xs dim">{block.daysLabel}</div>
                <div className="text-2xs" style={{ color: meta.tone === 'ok' ? 'var(--ok)' : meta.tone === 'warn' ? 'var(--warn)' : 'var(--text-dim)' }}>
                  {meta.label}
                </div>
                {(block.ideasCount > 0 || block.deliveriesCount > 0) && (
                  <div className="text-2xs dim">
                    {fa(block.ideasCount)} ایده · {fa(block.deliveriesCount)} تحویل
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'ingest' && (
        <div className="grid grid-2" style={{ alignItems: 'start' }}>
          <Card title="ورود بلوک هفتگی" subtitle="فایل JSON آماده — بدون مصرف توکن">
            <div
              className="empty"
              style={{ padding: 'var(--s-8) var(--s-4)', cursor: 'pointer' }}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) void onFile(file);
              }}
            >
              <div className="empty-icon" aria-hidden>📥</div>
              <div className="empty-title">فایل JSON را اینجا رها کن</div>
              <div className="empty-text">یا کلیک کن تا انتخاب کنی. ساختار فایل باید شامل schema_metadata و content_ideas باشد.</div>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onFile(file);
                }}
              />
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <Button size="sm" variant="solid" loading={busy} onClick={() => fileRef.current?.click()}>
                انتخاب فایل
              </Button>
              <Button size="sm" variant="ghost" onClick={downloadSample}>دانلود فایل نمونه</Button>
            </div>
          </Card>

          <Card title="قرارداد داده" subtitle="هر بلوک دقیقاً همین ساختار را دارد">
            <pre className="logbox" style={{ maxHeight: 300, color: '#a5f3fc' }}>{`{
  "schema_metadata": {
    "period_code": "M01-W01-PART1",
    "batch_id": "ATZ-B-M01-W01-P1"
  },
  "content_ideas": [
    { "title": "...", "thread": "...", "pillar": "P1" }
  ],
  "deliveries": [
    {
      "content_id": "ATZ-C-910001",
      "delivery_id": "ATZ-D-910001",
      "format_type": "reel",
      "schedule_key": "M01-W01-D03-IG-ANM-01",
      "funnel_stage": "TOFU",
      "exact_content": { "timeline": [], "slides": [] }
    }
  ]
}`}</pre>
            <div className="text-2xs dim" style={{ marginTop: 10, lineHeight: 1.8 }}>
              قاعده: <b>یک محتوا = یک تحویل</b>. اگر چند تحویل به یک content_id اشاره کنند، به‌صورت هوشمند ادغام می‌شوند و هشدار می‌گیری.
            </div>
          </Card>
        </div>
      )}

      <Modal open={Boolean(preview)} onClose={() => setPreview(null)} title={preview?.title ?? ''} width={720}>
        {preview && (
          <div className="stack">
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span className="code">{preview.contentId}</span>
              <StatusChip status={preview.status} />
              <SectionBadge section={preview.sectionCode} />
            </div>
            <div>
              <div className="label">نریشن</div>
              <p className="text-xs muted" style={{ lineHeight: 2 }}>{preview.plan.voiceoverScript || '—'}</p>
            </div>
            <div>
              <div className="label">صحنه‌ها ({fa(preview.plan.scenes.length)})</div>
              {preview.plan.scenes.map((scene, i) => (
                <div key={i} className="card card--tight" style={{ background: 'var(--surface-2)', marginTop: 6 }}>
                  <div className="row-between">
                    <span className="text-xs font-bold">{scene.cardTitle}</span>
                    <span className="chip chip--gold">{scene.metric}</span>
                  </div>
                  {scene.items.length > 0 && (
                    <ul className="text-2xs muted" style={{ margin: '6px 0 0', paddingInlineStart: 16 }}>
                      {scene.items.map((item, j) => <li key={j}>{item}</li>)}
                    </ul>
                  )}
                </div>
              ))}
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
              <Button variant="ghost" onClick={() => setPreview(null)}>بستن</Button>
              <Button
                variant="primary"
                onClick={() => {
                  void approve([preview.contentId]);
                  setPreview(null);
                }}
              >
                تایید و ارسال به صف
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
