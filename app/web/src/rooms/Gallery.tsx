import React, { useEffect, useMemo, useState } from 'react';
import { api, type Asset, type Content } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Card, Empty, MediaPreview, SectionBadge, StatusChip, Tabs, fa, fmtBytes, fmtRelative } from '../components/ui';
import type { RoomProps } from './index';

type Filter = 'all' | 'video' | 'image';

export function GalleryRoom({ onNavigate }: RoomProps) {
  const { run, refresh } = useStore();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [contents, setContents] = useState<Content[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<Asset | null>(null);

  const load = async () => {
    setLoading(true);
    const [a, c] = await Promise.all([api.assets(), api.contents()]);
    setAssets(a);
    setContents(c);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const byContent = useMemo(() => {
    const map = new Map<string, Asset[]>();
    for (const asset of assets) {
      if (!map.has(asset.contentId)) map.set(asset.contentId, []);
      map.get(asset.contentId)!.push(asset);
    }
    return map;
  }, [assets]);

  const filtered = assets.filter((a) =>
    filter === 'all' ? true : filter === 'video' ? a.kind === 'video' : a.kind === 'image'
  );

  if (!loading && assets.length === 0) {
    return (
      <Empty
        icon="🎞️"
        title="گالری خالی است"
        text="پس از رندر در استودیو، ویدئوها، کاروسل‌ها و کاورها همراه با پخش‌کننده و دانلود اینجا نمایش داده می‌شوند."
        action={
          <div className="row">
            <Button variant="primary" onClick={() => onNavigate('studio')}>رفتن به استودیو</Button>
            <Button variant="solid" onClick={() => onNavigate('plan')}>تایید الگوها</Button>
          </div>
        }
      />
    );
  }

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <div className="row-between">
        <Tabs<Filter>
          tabs={[
            { key: 'all', label: 'همه', count: assets.length },
            { key: 'video', label: 'ویدئو', count: assets.filter((a) => a.kind === 'video').length },
            { key: 'image', label: 'تصویر', count: assets.filter((a) => a.kind === 'image').length },
          ]}
          value={filter}
          onChange={setFilter}
        />
        <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading}>↻ بروزرسانی</Button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
        {filtered.map((asset) => {
          const content = contents.find((c) => c.contentId === asset.contentId);
          return (
            <div key={asset.assetId} className="card stack" style={{ gap: 12, padding: 14 }}>
              <div className="row-between">
                <span className="code">{asset.contentId}</span>
                <span className={`chip ${asset.kind === 'video' ? 'chip--gold' : 'chip--info'}`}>
                  {asset.kind === 'video' ? 'ویدئو' : 'تصویر'}
                </span>
              </div>

              <div
                style={{ borderRadius: 'var(--r-md)', overflow: 'hidden', background: '#000', cursor: 'pointer' }}
                onClick={() => setActive(asset)}
              >
                {asset.kind === 'video' ? (
                  <video
                    src={asset.url}
                    preload="metadata"
                    muted
                    playsInline
                    style={{ width: '100%', display: 'block', maxHeight: 260, objectFit: 'cover' }}
                  />
                ) : (
                  <img
                    src={asset.url}
                    alt={content?.title ?? ''}
                    loading="lazy"
                    style={{ width: '100%', display: 'block', maxHeight: 260, objectFit: 'cover' }}
                  />
                )}
              </div>

              <div className="text-sm font-bold clamp-2" style={{ lineHeight: 1.6 }}>
                {content?.title ?? asset.file.split('/').pop()}
              </div>

              <div className="row" style={{ gap: 6, flexWrap: 'wrap', fontSize: 10 }}>
                {content && <SectionBadge section={content.sectionCode} />}
                {content && <StatusChip status={content.status} />}
                <span className="chip">{fmtBytes(asset.bytes)}</span>
                {asset.durationSec && <span className="chip">{fa(asset.durationSec.toFixed(1))}ث</span>}
              </div>

              <div className="row" style={{ gap: 6 }}>
                <Button size="sm" variant="solid" style={{ flex: 1 }} onClick={() => setActive(asset)}>
                  نمایش
                </Button>
                <a href={asset.url} download className="btn btn--primary btn--sm" style={{ flex: 1, textDecoration: 'none' }}>
                  ⬇ دانلود
                </a>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void run(() => api.setStatus(asset.contentId, 'archived'), { success: 'بایگانی شد' });
                    void refresh();
                    void load();
                  }}
                  title="بایگانی محتوا"
                >
                  🗄️
                </Button>
              </div>
              <div className="text-2xs dim">{fmtRelative(asset.createdAt)}</div>
            </div>
          );
        })}
      </div>

      {active && (
        <div className="overlay" onClick={() => setActive(null)}>
          <div className="modal" style={{ width: 'min(860px, calc(100vw - 32px))' }} onClick={(e) => e.stopPropagation()}>
            <div className="row-between" style={{ marginBottom: 14 }}>
              <span className="code">{active.contentId}</span>
              <Button variant="ghost" size="sm" onClick={() => setActive(null)}>✕</Button>
            </div>
            <MediaPreview url={active.url} kind={active.kind} />
            <div className="row-between" style={{ marginTop: 14 }}>
              <div className="text-2xs muted">
                {fmtBytes(active.bytes)} · {active.width ? `${fa(active.width)}×${fa(active.height)}` : '—'}
                {active.durationSec ? ` · ${fa(active.durationSec.toFixed(1))} ثانیه` : ''}
              </div>
              <div className="row">
                <a href={active.url} download className="btn btn--primary btn--sm" style={{ textDecoration: 'none' }}>
                  ⬇ دانلود فایل
                </a>
                <a href={`/api/export/${active.contentId}`} download className="btn btn--solid btn--sm" style={{ textDecoration: 'none' }}>
                  📋 بسته JSON
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
