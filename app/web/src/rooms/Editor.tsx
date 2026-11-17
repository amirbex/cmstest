import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import {
  productionApi,
  mediaApi,
  type Concept,
  type ConceptScene,
  type EditDocRecord,
  type MediaItem,
  type SubtitleStyle,
  type Transcript,
  type TranscriptCue,
} from '../lib/api';
import { Card, Empty, Button, fa, Field, Spinner, Progress, Modal } from '../components/ui';
import type { RoomProps } from './index';

/**
 * The editor.
 *
 * Three synchronised panes over one document:
 *   left   — the scene list (the document's structure)
 *   centre — a live canvas rendered from the current scene
 *   right  — the inspector for whatever is selected (scene, or subtitle track)
 *
 * The timeline is derived, not stored separately: scene durations are the truth,
 * and dragging a boundary rewrites the neighbouring scenes so the timeline always
 * tiles without gaps. That is the invariant the renderer depends on.
 */
export function EditorRoom({ onNavigate }: RoomProps) {
  const { run, toast } = useStore();
  const [docs, setDocs] = useState<EditDocRecord[]>([]);
  const [active, setActive] = useState<EditDocRecord | null>(null);
  const [concept, setConcept] = useState<Concept | null>(null);
  const [selected, setSelected] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [tab, setTab] = useState<'scene' | 'subtitle' | 'meta'>('scene');
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [subStyle, setSubStyle] = useState<SubtitleStyle>({ fontSize: 54, position: 'bottom', karaoke: true, pill: true });
  const [burning, setBurning] = useState(false);
  const [burnResult, setBurnResult] = useState<{ url: string; mediaId: string } | null>(null);
  const rafRef = useRef<number | null>(null);

  const loadDocs = useCallback(async () => {
    const list = await productionApi.edits().catch(() => []);
    setDocs(list);
    return list;
  }, []);

  useEffect(() => {
    void (async () => {
      const list = await loadDocs();
      /* honour #editor?doc=… so the queue can deep-link a document */
      const hash = window.location.hash;
      const requested = /doc=([^&]+)/.exec(hash)?.[1];
      const pick = (requested && list.find((d) => d.docId === requested)) || list[0] || null;
      if (pick) {
        setActive(pick);
        setConcept(pick.doc);
      }
      setMedia(await mediaApi.list({ limit: 40 }).catch(() => []));
    })();
  }, [loadDocs]);

  /* playback: a real clock over the document's duration, not a fake tween */
  useEffect(() => {
    if (!playing || !concept) return;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setPlayhead((t) => {
        const next = t + dt;
        if (next >= concept.durationSec) {
          setPlaying(false);
          return 0;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, concept]);

  /* keep the selection in sync with the playhead while playing */
  useEffect(() => {
    if (!playing || !concept) return;
    const index = concept.scenes.findIndex((s) => playhead >= s.startSec && playhead < s.endSec);
    if (index >= 0 && index !== selected) setSelected(index);
  }, [playhead, playing, concept, selected]);

  const openDoc = async (doc: EditDocRecord) => {
    setActive(doc);
    setConcept(doc.doc);
    setSelected(0);
    setPlayhead(0);
    setDirty(false);
    setBurnResult(null);
    setTranscript(null);
    window.location.hash = `editor?doc=${doc.docId}`;
  };

  const patchScene = (index: number, patch: Partial<ConceptScene>) => {
    if (!concept) return;
    const scenes = concept.scenes.map((s, i) => (i === index ? { ...s, ...patch } : s));
    setConcept({ ...concept, scenes });
    setDirty(true);
  };

  /**
   * Change a scene's duration and push the difference into its neighbour, so the
   * scenes still tile the timeline exactly. Without this the render has gaps.
   */
  const resizeScene = (index: number, newDuration: number) => {
    if (!concept) return;
    const clamped = Math.max(0.5, Math.round(newDuration * 10) / 10);
    const scenes = [...concept.scenes];
    const target = scenes[index];
    const delta = clamped - target.durationSec;
    if (index === scenes.length - 1) {
      if (target.durationSec + delta < 0.5) return;
    } else {
      const nextScene = scenes[index + 1];
      if (nextScene.durationSec - delta < 0.5) return;
      scenes[index + 1] = { ...nextScene, durationSec: round2(nextScene.durationSec - delta) };
    }
    scenes[index] = { ...target, durationSec: clamped };
    /* re-derive absolute times from the durations, which are now the truth */
    let cursor = 0;
    const retimed = scenes.map((s) => {
      const startSec = round2(cursor);
      cursor += s.durationSec;
      return { ...s, startSec, endSec: round2(cursor) };
    });
    setConcept({ ...concept, scenes: retimed, durationSec: round2(cursor) });
    setDirty(true);
  };

  const addScene = () => {
    if (!concept) return;
    const at = selected + 1;
    const template: ConceptScene = {
      index: at,
      beat: 'صحنه جدید',
      cardTitle: 'عنوان صحنه',
      narration: '',
      startSec: 0,
      endSec: 3,
      durationSec: 3,
      onScreenText: '',
      visual: '',
      iconPrompt: null,
      accent: concept.meta.accentHex,
      transition: 'fade-up',
    };
    const scenes = [...concept.scenes];
    scenes.splice(at, 0, template);
    let cursor = 0;
    const retimed = scenes.map((s, i) => {
      const startSec = round2(cursor);
      cursor += s.durationSec;
      return { ...s, index: i, startSec, endSec: round2(cursor) };
    });
    setConcept({ ...concept, scenes: retimed, durationSec: round2(cursor) });
    setSelected(at);
    setDirty(true);
  };

  const deleteScene = (index: number) => {
    if (!concept || concept.scenes.length <= 1) {
      toast('error', 'حداقل یک صحنه لازم است');
      return;
    }
    const scenes = concept.scenes.filter((_, i) => i !== index);
    let cursor = 0;
    const retimed = scenes.map((s, i) => {
      const startSec = round2(cursor);
      cursor += s.durationSec;
      return { ...s, index: i, startSec, endSec: round2(cursor) };
    });
    setConcept({ ...concept, scenes: retimed, durationSec: round2(cursor) });
    setSelected(Math.max(0, index - 1));
    setDirty(true);
  };

  const save = async () => {
    if (!active || !concept) return;
    setSaving(true);
    const saved = await run(() => productionApi.saveEdit(active.docId, concept), { success: 'سند ذخیره شد' });
    setSaving(false);
    if (saved) {
      setActive(saved);
      setDirty(false);
      await loadDocs();
    }
  };

  const transcribe = async () => {
    /* the editor's subtitle track is driven by the selected media asset */
    const video = media.find((m) => m.kind === 'video' || m.kind === 'audio');
    if (!video) {
      toast('error', 'اول یک فایل صوتی یا ویدیویی در مخزن بارگذاری کن');
      return;
    }
    const scriptText = concept?.scenes.map((s) => s.narration).join(' ') ?? '';
    const result = await run(() => mediaApi.transcribe(video.mediaId, { mode: 'auto', scriptText }), {
      success: 'زیرنویس آماده شد',
    });
    if (result) setTranscript(result);
  };

  const burn = async () => {
    const video = media.find((m) => m.kind === 'video' && !m.originalName.includes('subtitled'));
    if (!video || !transcript) {
      toast('error', 'ویدیو یا زیرنویس موجود نیست');
      return;
    }
    setBurning(true);
    const result = await run(() => mediaApi.burnSubtitles(video.mediaId, subStyle, transcript.cues), {
      success: 'زیرنویس روی ویدیو سوخت',
    });
    setBurning(false);
    if (result) {
      setBurnResult({ url: result.media.url, mediaId: result.media.mediaId });
      setMedia(await mediaApi.list({ limit: 40 }).catch(() => media));
    }
  };

  const current = concept?.scenes[selected] ?? null;
  const currentTime = playing ? playhead : current?.startSec ?? 0;
  const currentScene = useMemo(
    () => concept?.scenes.find((s) => currentTime >= s.startSec && currentTime < s.endSec) ?? current,
    [concept, currentTime, current]
  );

  if (!active) {
    return (
      <Empty
        icon="🎛️"
        title="سند تدوینی باز نیست"
        text="از صف تولید یک انتشار را انتخاب کن و «ساخت کانسپت» را بزن؛ سند اینجا باز می‌شود."
        action={<Button variant="primary" onClick={() => onNavigate('production')}>صف تولید</Button>}
      />
    );
  }

  return (
    <div className="stack" style={{ gap: 'var(--s-4)' }}>
      {/* toolbar */}
      <Card tight>
        <div className="row-between" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <select
              className="select"
              style={{ minWidth: 220 }}
              value={active.docId}
              onChange={(e) => {
                const next = docs.find((d) => d.docId === e.target.value);
                if (next) void openDoc(next);
              }}
            >
              {docs.map((d) => (
                <option key={d.docId} value={d.docId}>
                  {d.title} — {d.docId}
                </option>
              ))}
            </select>
            <span className="chip chip--gold">{fa(concept?.aspect ?? '')}</span>
            <span className="chip">{fa(concept?.durationSec.toFixed(1) ?? '0')}s</span>
            <span className="chip">{fa(concept?.scenes.length ?? 0)} صحنه</span>
            {dirty && <span className="chip chip--warn">ذخیره‌نشده</span>}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <Button size="sm" variant={playing ? 'danger' : 'default'} onClick={() => setPlaying((p) => !p)}>
              {playing ? '⏸ توقف' : '▶ پخش'}
            </Button>
            <Button size="sm" onClick={addScene}>+ صحنه</Button>
            <Button size="sm" variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty}>
              ذخیره
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid" style={{ gridTemplateColumns: '230px minmax(280px, 1fr) 300px', gap: 'var(--s-4)', alignItems: 'start' }}>
        {/* scene list */}
        <Card title="صحنه‌ها" tight flush>
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
            {(concept?.scenes ?? []).map((s, i) => {
              const isCurrent = playing ? currentScene?.index === i : selected === i;
              return (
                <button
                  key={i}
                  onClick={() => {
                    setSelected(i);
                    setPlayhead(s.startSec);
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'right',
                    background: isCurrent ? 'rgba(255,180,0,0.1)' : 'transparent',
                    border: 0,
                    borderInlineStart: isCurrent ? '3px solid var(--gold)' : '3px solid transparent',
                    borderBottom: '1px solid var(--border)',
                    padding: '9px 10px',
                    cursor: 'pointer',
                    color: 'inherit',
                    fontFamily: 'inherit',
                  }}
                >
                  <div className="row-between" style={{ gap: 6 }}>
                    <span className="text-2xs font-bold clamp-1">{s.beat || `صحنه ${i + 1}`}</span>
                    <span className="text-2xs num dim">{fa(Number(s.durationSec ?? 0).toFixed(1))}s</span>
                  </div>
                  <div className="text-2xs muted clamp-1" style={{ marginTop: 2 }}>{s.cardTitle}</div>
                </button>
              );
            })}
          </div>
        </Card>

        {/* canvas */}
        <div className="stack" style={{ gap: 'var(--s-4)' }}>
          <Card tight>
            <div style={{ display: 'grid', placeItems: 'center', background: '#0a0a0c', borderRadius: 'var(--r-md)', padding: 16 }}>
              <div
                style={{
                  width: '100%',
                  maxWidth: concept?.aspect === '1080x1920' ? 260 : concept?.aspect === '1080x1350' ? 340 : 360,
                  aspectRatio:
                    concept?.aspect === '1080x1920' ? '9/16' : concept?.aspect === '1080x1350' ? '4/5' : concept?.aspect === '1080x1080' ? '1/1' : '16/9',
                  background: `linear-gradient(160deg, ${currentScene?.accent ?? '#FFB400'}22, #101014 55%)`,
                  borderRadius: 10,
                  border: '1px solid rgba(255,255,255,0.08)',
                  position: 'relative',
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'flex-end',
                  padding: 18,
                  boxShadow: '0 18px 40px rgba(0,0,0,0.45)',
                  transition: 'background 260ms ease',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    top: 12,
                    insetInlineStart: 12,
                    fontSize: 10,
                    letterSpacing: 1,
                    color: 'rgba(255,255,255,0.5)',
                    fontFamily: 'monospace',
                  }}
                >
                  {fa(currentScene?.startSec.toFixed(1) ?? '0')}s · {currentScene?.beat}
                </div>

                <div
                  style={{
                    fontSize: concept?.aspect === '1080x1920' ? 16 : 19,
                    fontWeight: 900,
                    lineHeight: 1.5,
                    color: '#fff',
                    textShadow: '0 2px 12px rgba(0,0,0,0.6)',
                    direction: 'rtl',
                  }}
                >
                  {currentScene?.cardTitle || 'عنوان صحنه'}
                </div>

                {currentScene?.narration && (
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.68)', lineHeight: 1.8, marginTop: 8, direction: 'rtl' }}>
                    {currentScene.narration.slice(0, 120)}
                    {currentScene.narration.length > 120 ? '…' : ''}
                  </div>
                )}

                {concept?.meta.cta && selected === (concept.scenes.length - 1) && (
                  <div
                    style={{
                      marginTop: 12,
                      alignSelf: 'flex-start',
                      background: currentScene?.accent ?? '#FFB400',
                      color: '#0a0a0c',
                      fontSize: 10,
                      fontWeight: 800,
                      padding: '5px 10px',
                      borderRadius: 999,
                    }}
                  >
                    {concept.meta.cta.slice(0, 40)}
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* timeline */}
          <Card title="تایم‌لاین" subtitle="عرض هر بلوک = مدت صحنه؛ کشیدن لبه، صحنهٔ بعد را کوتاه می‌کند">
            <div className="stack" style={{ gap: 8 }}>
              <div style={{ position: 'relative', height: 44, display: 'flex', gap: 2, borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
                {(concept?.scenes ?? []).map((s, i) => (
                  <div
                    key={i}
                    onClick={() => {
                      setSelected(i);
                      setPlayhead(s.startSec);
                    }}
                    style={{
                      flex: `0 0 ${(s.durationSec / Math.max(0.1, concept?.durationSec ?? 1)) * 100}%`,
                      background:
                        currentScene?.index === i
                          ? 'rgba(255,180,0,0.55)'
                          : i % 2 === 0
                            ? 'rgba(255,255,255,0.1)'
                            : 'rgba(255,255,255,0.06)',
                      borderInlineEnd: '1px solid rgba(0,0,0,0.4)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 9,
                      color: 'rgba(255,255,255,0.85)',
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      padding: '0 4px',
                    }}
                    title={`${s.beat} — ${s.durationSec.toFixed(1)}s`}
                  >
                    {fa(Number(s.durationSec ?? 0).toFixed(1))}s
                  </div>
                ))}
                {/* playhead */}
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    insetInlineStart: `${(currentTime / Math.max(0.1, concept?.durationSec ?? 1)) * 100}%`,
                    width: 2,
                    background: 'var(--danger, #ef4444)',
                    pointerEvents: 'none',
                  }}
                />
              </div>

              <div className="row" style={{ gap: 6 }}>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, concept?.durationSec ?? 1)}
                  step={0.1}
                  value={currentTime}
                  onChange={(e) => {
                    setPlaying(false);
                    setPlayhead(Number(e.target.value));
                  }}
                  style={{ flex: 1, accentColor: 'var(--gold)' }}
                />
                <span className="text-2xs num dim" style={{ minWidth: 66, textAlign: 'center' }}>
                  {fa(currentTime.toFixed(1))} / {fa((concept?.durationSec ?? 0).toFixed(1))}
                </span>
              </div>
            </div>
          </Card>
        </div>

        {/* inspector */}
        <Card tight>
          <div className="tabs" role="tablist" style={{ marginBottom: 10 }}>
            {([
              ['scene', 'صحنه'],
              ['subtitle', 'زیرنویس'],
              ['meta', 'متادیتا'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                className="tab"
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'scene' && currentScene && (
            <div className="stack" style={{ gap: 10 }}>
              <Field label="نقش صحنه (beat)">
                <input className="input" value={currentScene.beat} onChange={(e) => patchScene(selected, { beat: e.target.value })} />
              </Field>
              <Field label="عنوان روی تصویر" hint="حداکثر ۹۰ کاراکتر">
                <textarea
                  className="textarea"
                  rows={2}
                  value={currentScene.cardTitle}
                  onChange={(e) => patchScene(selected, { cardTitle: e.target.value.slice(0, 90) })}
                />
              </Field>
              <Field label="نریشن">
                <textarea
                  className="textarea"
                  rows={4}
                  value={currentScene.narration}
                  onChange={(e) => patchScene(selected, { narration: e.target.value })}
                />
              </Field>
              <Field label="راهنمای بصری">
                <textarea
                  className="textarea"
                  rows={3}
                  value={currentScene.visual}
                  onChange={(e) => patchScene(selected, { visual: e.target.value })}
                />
              </Field>
              <div className="grid grid-2" style={{ gap: 8 }}>
                <Field label="مدت (ثانیه)">
                  <input
                    className="input num"
                    type="number"
                    min={0.5}
                    step={0.1}
                    value={currentScene.durationSec}
                    onChange={(e) => resizeScene(selected, Number(e.target.value))}
                  />
                </Field>
                <Field label="رنگ تاکید">
                  <input
                    className="input"
                    type="color"
                    value={currentScene.accent}
                    onChange={(e) => patchScene(selected, { accent: e.target.value })}
                    style={{ height: 36, padding: 4 }}
                  />
                </Field>
              </div>
              <Field label="گذار">
                <select
                  className="select"
                  value={currentScene.transition}
                  onChange={(e) => patchScene(selected, { transition: e.target.value })}
                >
                  {['fade-in', 'fade-up', 'slide-in-right', 'zoom-in', 'wipe-up', 'blur-in', 'spring-pop', 'kinetic-words'].map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </Field>
              <Button size="sm" variant="danger" block onClick={() => deleteScene(selected)}>
                حذف این صحنه
              </Button>
            </div>
          )}

          {tab === 'subtitle' && (
            <div className="stack" style={{ gap: 10 }}>
              <div className="text-2xs muted" style={{ lineHeight: 1.9 }}>
                زیرنویس از فایل صوتی/ویدیویی که انتخاب می‌کنی ساخته می‌شود. اگر کلید مدل نباشد، از متن نریشنِ همین سند
                زمان‌بندی برآوردی می‌سازد و صادقانه برچسب «برآوردی» می‌خورد.
              </div>

              <Field label="فایل منبع">
                <select
                  className="select"
                  value={media.find((m) => m.kind === 'video' || m.kind === 'audio')?.mediaId ?? ''}
                  onChange={() => undefined}
                  disabled
                >
                  {media
                    .filter((m) => m.kind === 'video' || m.kind === 'audio')
                    .map((m) => (
                      <option key={m.mediaId} value={m.mediaId}>
                        {m.originalName} ({fa(m.durationSec ?? 0)}s)
                      </option>
                    ))}
                  {media.filter((m) => m.kind === 'video' || m.kind === 'audio').length === 0 && (
                    <option value="">فایلی در مخزن نیست — از «مخزن دارایی» بارگذاری کن</option>
                  )}
                </select>
              </Field>

              <div className="grid grid-2" style={{ gap: 8 }}>
                <Field label="اندازه قلم">
                  <input
                    className="input num"
                    type="number"
                    min={28}
                    max={96}
                    value={subStyle.fontSize}
                    onChange={(e) => setSubStyle({ ...subStyle, fontSize: Number(e.target.value) })}
                  />
                </Field>
                <Field label="موقعیت">
                  <select
                    className="select"
                    value={subStyle.position}
                    onChange={(e) => setSubStyle({ ...subStyle, position: e.target.value as SubtitleStyle['position'] })}
                  >
                    <option value="bottom">پایین</option>
                    <option value="center">وسط</option>
                    <option value="top">بالا</option>
                  </select>
                </Field>
              </div>

              <div className="row" style={{ gap: 10 }}>
                <label className="row text-2xs" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={subStyle.karaoke}
                    onChange={(e) => setSubStyle({ ...subStyle, karaoke: e.target.checked })}
                    style={{ accentColor: 'var(--gold)' }}
                  />
                  کلمه‌به‌کلمه (کارائوکه)
                </label>
                <label className="row text-2xs" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={subStyle.pill}
                    onChange={(e) => setSubStyle({ ...subStyle, pill: e.target.checked })}
                    style={{ accentColor: 'var(--gold)' }}
                  />
                  پس‌زمینه پیل
                </label>
              </div>

              <Button size="sm" block onClick={() => void transcribe()}>
                🎙️ ساخت زیرنویس
              </Button>

              {transcript && (
                <div className="stack" style={{ gap: 6 }}>
                  <div className="row-between text-2xs">
                    <span className="dim">{fa(transcript.cues.length)} cue</span>
                    <span className={`chip ${transcript.source === 'gemini' ? 'chip--ok' : 'chip--warn'}`}>
                      {SOURCE_LABEL[transcript.source] ?? transcript.source}
                    </span>
                  </div>
                  <div className="stack" style={{ gap: 3, maxHeight: 150, overflowY: 'auto' }}>
                    {transcript.cues.slice(0, 30).map((cue, i) => (
                      <div key={i} className="text-2xs" style={{ lineHeight: 1.7 }}>
                        <span className="num dim">{fa(cue.start.toFixed(1))}–{fa(cue.end.toFixed(1))}</span> {cue.text}
                      </div>
                    ))}
                  </div>
                  <Button size="sm" variant="primary" block loading={burning} onClick={() => void burn()}>
                    🔥 سوختن روی ویدیو
                  </Button>
                  {burnResult && (
                    <video src={burnResult.url} controls style={{ width: '100%', borderRadius: 'var(--r-sm)', marginTop: 6 }} />
                  )}
                </div>
              )}
            </div>
          )}

          {tab === 'meta' && concept && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="text-xs font-bold">{concept.title}</div>
              <Field label="مدت کل (ثانیه)">
                <input
                  className="input num"
                  type="number"
                  value={concept.durationSec}
                  onChange={(e) => {
                    const target = Number(e.target.value);
                    if (!target || !concept.scenes.length) return;
                    /* scale every scene proportionally to hit the new total */
                    const factor = target / concept.durationSec;
                    let cursor = 0;
                    const scenes = concept.scenes.map((s) => {
                      const durationSec = round2(s.durationSec * factor);
                      const startSec = round2(cursor);
                      cursor += durationSec;
                      return { ...s, durationSec, startSec, endSec: round2(cursor) };
                    });
                    setConcept({ ...concept, scenes, durationSec: round2(cursor) });
                    setDirty(true);
                  }}
                />
              </Field>
              <div className="stack" style={{ gap: 4 }}>
                <MetaRow label="شناسه انتشار" value={concept.meta.deliveryId} />
                <MetaRow label="کلید تقویم" value={concept.meta.scheduleKey} />
                <MetaRow label="پلتفرم" value={concept.meta.platformLabel} />
                <MetaRow label="فرمت" value={concept.meta.formatLabel} />
                <MetaRow label="قیف" value={concept.meta.funnelStage} />
                <MetaRow label="راهنمای ساخت" value={concept.guide.name} />
              </div>
              {concept.meta.caption && (
                <Field label="کپشن">
                  <textarea
                    className="textarea"
                    rows={5}
                    value={concept.meta.caption}
                    onChange={(e) => {
                      setConcept({ ...concept, meta: { ...concept.meta, caption: e.target.value } });
                      setDirty(true);
                    }}
                  />
                </Field>
              )}
              {concept.meta.hashtags.length > 0 && (
                <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                  {concept.meta.hashtags.map((h) => (
                    <span key={h} className="chip" style={{ fontSize: 10 }}>{h}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const SOURCE_LABEL: Record<string, string> = {
  gemini: 'رونویسی مدل',
  local: 'مدل محلی',
  estimated: 'زمان‌بندی برآوردی',
  edited: 'ویرایش‌شده',
};

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between text-2xs">
      <span className="dim">{label}</span>
      <span className="code" style={{ fontSize: 10 }}>{value}</span>
    </div>
  );
}
