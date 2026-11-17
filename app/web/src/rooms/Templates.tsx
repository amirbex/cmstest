import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { templateApi, type Template, type TemplateFacets, type TemplatePage } from '../lib/api';
import { Card, Empty, Button, fa, Modal, Field, Spinner } from '../components/ui';
import type { RoomProps } from './index';

/**
 * Template & motion-recipe browser.
 *
 * The catalogue is generated from orthogonal axes (intent × motion × layout ×
 * style), so facet counts are always live and every card maps to something the
 * renderer can actually draw. Nothing here is a screenshot of a template we
 * cannot produce.
 */
export function TemplatesRoom({ onNavigate }: RoomProps) {
  const [page, setPage] = useState<TemplatePage | null>(null);
  const [facets, setFacets] = useState<TemplateFacets | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [family, setFamily] = useState('');
  const [aspect, setAspect] = useState('');
  const [motion, setMotion] = useState('');
  const [pageNo, setPageNo] = useState(1);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Template | null>(null);

  const loadFacets = useCallback(async () => {
    const f = await templateApi.facets().catch(() => null);
    setFacets(f);
  }, []);

  const loadPage = useCallback(async () => {
    setLoading(true);
    const result = await templateApi
      .query({ q: query, category, family, aspect, motion, page: pageNo, pageSize: 36 })
      .catch(() => null);
    setPage(result);
    setLoading(false);
  }, [query, category, family, aspect, motion, pageNo]);

  useEffect(() => {
    void loadFacets();
  }, [loadFacets]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  /* every filter change resets paging — otherwise page 12 of a 2-page result is blank */
  const resetTo = (fn: () => void) => {
    setPageNo(1);
    fn();
  };

  const activeFilters = [category, family, aspect, motion].filter(Boolean).length + (query ? 1 : 0);

  const CATEGORY_LABELS: Record<string, string> = {
    cover: 'کاور',
    carousel: 'کاروسل',
    reel: 'ریلز',
    story: 'استوری',
    chart: 'نمودار',
    'logo-intro': 'اینترو لوگو',
    anatomy: 'کالبدشکافی',
    'web-to-video': 'وب به ویدیو',
    'kinetic-type': 'تایپوگرافی',
    transition: 'گذار',
    outro: 'پایانی',
    post: 'پست',
  };

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <Card accent>
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="stack" style={{ gap: 2 }}>
            <span className="text-xs muted">کتابخانهٔ رسپی‌های حرکت</span>
            <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
              <span className="num font-black" style={{ fontSize: 28, color: 'var(--gold)' }}>
                {fa(facets?.total ?? 0)}
              </span>
              <span className="text-2xs dim">رسپی · {fa(page?.total ?? 0)} نتیجه</span>
            </div>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {(facets?.families ?? []).map((f) => (
              <button
                key={f.id}
                className={`chip ${family === f.id ? 'chip--gold' : ''}`}
                style={{ cursor: 'pointer', fontFamily: 'inherit' }}
                onClick={() => resetTo(() => setFamily(family === f.id ? '' : f.id))}
                title={f.note}
              >
                {f.name} <span className="dim">({fa(f.count)})</span>
              </button>
            ))}
          </div>
        </div>
      </Card>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(220px, 260px) 1fr', gap: 'var(--s-5)', alignItems: 'start' }}>
        {/* facet rail */}
        <Card title="فیلترها" tight>
          <div className="stack" style={{ gap: 14 }}>
            <Field label="جستجو">
              <input
                className="input"
                value={query}
                onChange={(e) => resetTo(() => setQuery(e.target.value))}
                placeholder="نام، توضیح یا شناسه…"
              />
            </Field>

            <div>
              <div className="label">دسته</div>
              <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                {(facets?.categories ?? []).map((c) => (
                  <button
                    key={c.name}
                    className={`row-between text-2xs ${category === c.name ? 'font-bold' : ''}`}
                    style={{
                      background: category === c.name ? 'rgba(255,180,0,0.12)' : 'none',
                      border: 0,
                      padding: '5px 8px',
                      borderRadius: 'var(--r-sm)',
                      cursor: 'pointer',
                      color: category === c.name ? 'var(--gold)' : 'inherit',
                      fontFamily: 'inherit',
                      width: '100%',
                    }}
                    onClick={() => resetTo(() => setCategory(category === c.name ? '' : c.name))}
                  >
                    <span>{CATEGORY_LABELS[c.name] ?? c.name}</span>
                    <span className="num dim">{fa(c.count)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="label">نسبت ابعاد</div>
              <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                {(facets?.aspects ?? []).map((a) => (
                  <button
                    key={a.name}
                    className={`chip ${aspect === a.name ? 'chip--gold' : ''}`}
                    style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: 'var(--fs-2xs)' }}
                    onClick={() => resetTo(() => setAspect(aspect === a.name ? '' : a.name))}
                  >
                    {fa(a.name)}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="label">حرکت</div>
              <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                {(facets?.presets ?? []).map((p) => (
                  <button
                    key={p.key}
                    className={`row-between text-2xs ${motion === p.key ? 'font-bold' : ''}`}
                    style={{
                      background: motion === p.key ? 'rgba(255,180,0,0.12)' : 'none',
                      border: 0,
                      padding: '4px 8px',
                      borderRadius: 'var(--r-sm)',
                      cursor: 'pointer',
                      color: motion === p.key ? 'var(--gold)' : 'inherit',
                      fontFamily: 'inherit',
                      width: '100%',
                    }}
                    onClick={() => resetTo(() => setMotion(motion === p.key ? '' : p.key))}
                  >
                    <span>{p.label}</span>
                    <span className="dim code" style={{ fontSize: 10 }}>{p.key}</span>
                  </button>
                ))}
              </div>
            </div>

            {activeFilters > 0 && (
              <Button
                size="sm"
                variant="ghost"
                block
                onClick={() =>
                  resetTo(() => {
                    setQuery('');
                    setCategory('');
                    setFamily('');
                    setAspect('');
                    setMotion('');
                  })
                }
              >
                پاک‌کردن {fa(activeFilters)} فیلتر
              </Button>
            )}
          </div>
        </Card>

        {/* results */}
        <div className="stack" style={{ gap: 'var(--s-4)' }}>
          {loading && !page && <div className="row" style={{ gap: 8 }}><Spinner size={16} /> در حال بارگذاری…</div>}

          {!loading && (page?.items.length ?? 0) === 0 && (
            <Empty icon="🔍" title="قالبی با این فیلترها پیدا نشد" text="فیلترها را ساده‌تر کن." />
          )}

          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12 }}>
            {(page?.items ?? []).map((t) => (
              <button
                key={t.id}
                className="card card--tight card--interactive"
                style={{ textAlign: 'right', cursor: 'pointer', padding: 0, overflow: 'hidden', background: 'var(--surface-2)' }}
                onClick={() => setDetail(t)}
              >
                {/* preview swatch: the accent + aspect are the actual render parameters */}
                <div
                  style={{
                    aspectRatio: t.aspect === '9:16' ? '9/16' : t.aspect === '16:9' ? '16/9' : t.aspect === '1:1' ? '1/1' : '4/5',
                    maxHeight: 170,
                    background: `linear-gradient(140deg, ${t.accent}33, var(--surface) 60%)`,
                    borderBottom: '1px solid var(--border)',
                    display: 'grid',
                    placeItems: 'center',
                    position: 'relative',
                  }}
                >
                  <span style={{ fontSize: 22, opacity: 0.75 }} aria-hidden>
                    {t.sceneKind === 'reel' ? '🎬' : t.sceneKind === 'carousel' ? '🖼️' : t.sceneKind.startsWith('chart') ? '📊' : t.sceneKind === 'outro' ? '✨' : t.sceneKind === 'web' ? '🌐' : t.sceneKind === 'anatomy' ? '🔍' : '🎨'}
                  </span>
                  <span
                    className="chip"
                    style={{ position: 'absolute', top: 6, insetInlineEnd: 6, fontSize: 10, background: 'rgba(0,0,0,0.45)' }}
                  >
                    {fa(t.aspect)}
                  </span>
                </div>
                <div style={{ padding: 10 }}>
                  <div className="text-xs font-bold clamp-2" style={{ lineHeight: 1.6 }}>{t.name}</div>
                  <div className="text-2xs dim clamp-2" style={{ lineHeight: 1.7, marginTop: 4 }}>{t.description}</div>
                  <div className="row" style={{ gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                    <span className="chip" style={{ fontSize: 10 }}>{CATEGORY_LABELS[t.category] ?? t.category}</span>
                    {t.durationSec && <span className="chip" style={{ fontSize: 10 }}>{fa(t.durationSec)}s</span>}
                  </div>
                </div>
              </button>
            ))}
          </div>

          {(page?.pages ?? 1) > 1 && (
            <div className="row" style={{ gap: 8, justifyContent: 'center', marginTop: 8 }}>
              <Button size="sm" variant="ghost" disabled={pageNo <= 1} onClick={() => setPageNo((p) => p - 1)}>
                قبلی
              </Button>
              <span className="text-xs muted num" style={{ alignSelf: 'center' }}>
                {fa(pageNo)} / {fa(page?.pages ?? 1)}
              </span>
              <Button size="sm" variant="ghost" disabled={pageNo >= (page?.pages ?? 1)} onClick={() => setPageNo((p) => p + 1)}>
                بعدی
              </Button>
            </div>
          )}
        </div>
      </div>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.name ?? ''} width={640}>
        {detail && (
          <div className="stack" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span className="chip chip--gold">{CATEGORY_LABELS[detail.category] ?? detail.category}</span>
              <span className="chip">{fa(detail.aspect)}</span>
              {detail.durationSec && <span className="chip">{fa(detail.durationSec)} ثانیه</span>}
              <span className="chip" style={{ borderColor: `${detail.accent}88`, color: detail.accent }}>{detail.accent}</span>
            </div>
            <p className="text-sm muted" style={{ lineHeight: 2, margin: 0 }}>{detail.description}</p>
            <div>
              <div className="label">حرکت‌ها</div>
              <div className="row" style={{ gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                {detail.motions.map((m) => (
                  <span key={m} className="chip code" style={{ fontSize: 10 }}>{m}</span>
                ))}
              </div>
            </div>
            <div>
              <div className="label">برچسب‌ها</div>
              <div className="row" style={{ gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                {detail.tags.map((t) => (
                  <span key={t} className="chip" style={{ fontSize: 10 }}>{t}</span>
                ))}
              </div>
            </div>
            <div className="text-2xs dim code">{detail.id}</div>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="ghost" onClick={() => setDetail(null)}>بستن</Button>
              <Button variant="primary" onClick={() => { setDetail(null); onNavigate('production'); }}>
                استفاده در صف تولید
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
