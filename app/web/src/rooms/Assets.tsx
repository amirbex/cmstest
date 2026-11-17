import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { mediaApi, type MediaItem } from '../lib/api';
import { Card, Empty, Button, fa, fmtBytes, Tabs, Field, Spinner, Progress } from '../components/ui';
import type { RoomProps } from './index';

/**
 * Asset library.
 *
 * Everything the user drops here becomes addressable by the editor and the
 * subtitle pipeline. Uploads go over XHR so a 300 MB clip shows real progress,
 * and video is compressed on arrival (`compress=1`) because every downstream step
 * — transcription, burn-in, preview — is faster with a smaller file.
 */
export function AssetsRoom({ onNavigate }: RoomProps) {
  const { run, toast } = useStore();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [folders, setFolders] = useState<{ folder: string; path: string; exists: boolean; files: number }[]>([]);
  const [stats, setStats] = useState<{ total: { n: number; bytes: number } } | null>(null);
  const [kind, setKind] = useState<'all' | 'video' | 'audio' | 'image' | 'document'>('all');
  const [folder, setFolder] = useState('');
  const [uploading, setUploading] = useState<{ name: string; pct: number } | null>(null);
  const [compressOnUpload, setCompressOnUpload] = useState(true);
  const [importPath, setImportPath] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [list, f, s] = await Promise.all([
      mediaApi.list({ kind: kind === 'all' ? undefined : kind, folder: folder || undefined, limit: 300 }).catch(() => []),
      mediaApi.folders().catch(() => []),
      mediaApi.stats().catch(() => null),
    ]);
    setItems(list);
    setFolders(f);
    setStats(s);
  }, [kind, folder]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (files: FileList) => {
    for (const file of Array.from(files)) {
      setUploading({ name: file.name, pct: 0 });
      try {
        const result = await mediaApi.upload(file, {
          folder: folder || 'incoming',
          compress: compressOnUpload && file.type.startsWith('video'),
          onProgress: (pct) => setUploading({ name: file.name, pct }),
        });
        if (result.compressed) {
          const saved = Number((result.compressed.meta as { savedPct?: number })?.savedPct ?? 0);
          toast('success', `${file.name} آپلود و ${fa(saved)}٪ فشرده شد`);
        } else {
          toast('success', `${file.name} آپلود شد`);
        }
      } catch (err) {
        toast('error', `${file.name}: ${(err as Error).message}`);
      }
    }
    setUploading(null);
    await load();
  };

  const importFolder = async () => {
    if (!importPath.trim()) return;
    const result = await run(() => mediaApi.importFolder(importPath.trim(), folder || 'incoming'), {
      success: 'پوشه ایندکس شد',
    });
    if (result) {
      toast('info', `${fa(result.imported)} فایل وارد شد، ${fa(result.skipped)} نادیده`);
      await load();
    }
  };

  const remove = async (item: MediaItem) => {
    const result = await run(() => mediaApi.remove(item.mediaId), { success: 'حذف شد' });
    if (result) await load();
  };

  const grouped = useMemo(() => {
    const map = new Map<string, MediaItem[]>();
    for (const item of items) {
      if (!map.has(item.folder)) map.set(item.folder, []);
      map.get(item.folder)!.push(item);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <div className="grid grid-3">
        <Card tight>
          <div className="row-between">
            <span className="kpi-label">کل فایل‌ها</span>
            <span aria-hidden>🗂️</span>
          </div>
          <div className="kpi-value">{fa(stats?.total.n ?? 0)}</div>
          <div className="kpi-delta muted">{fmtBytes(stats?.total.bytes ?? 0)}</div>
        </Card>
        <Card tight>
          <div className="row-between">
            <span className="kpi-label">پوشه‌های مخزن</span>
            <span aria-hidden>📁</span>
          </div>
          <div className="kpi-value">{fa(folders.filter((f) => f.exists).length)}</div>
          <div className="kpi-delta muted">assets/ و storage/media/</div>
        </Card>
        <Card tight>
          <div className="row-between">
            <span className="kpi-label">ویدیوهای قابل تدوین</span>
            <span aria-hidden>🎬</span>
          </div>
          <div className="kpi-value">{fa(items.filter((i) => i.kind === 'video').length)}</div>
          <div className="kpi-delta muted">آمادهٔ زیرنویس خودکار</div>
        </Card>
      </div>

      <Card title="بارگذاری" subtitle="فایل‌ها با همان نام و ساختار روی دیسک ذخیره می‌شوند" accent>
        <div className="stack" style={{ gap: 12 }}>
          <label
            className="card card--tight"
            style={{
              display: 'grid',
              placeItems: 'center',
              padding: 26,
              borderStyle: 'dashed',
              borderWidth: 2,
              cursor: uploading ? 'wait' : 'pointer',
              background: 'var(--surface-2)',
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
            }}
          >
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files?.length) void upload(e.target.files);
                e.currentTarget.value = '';
              }}
            />
            <div className="stack" style={{ alignItems: 'center', gap: 6, width: '100%' }}>
              <span style={{ fontSize: 26 }} aria-hidden>{uploading ? '⏳' : '⬆️'}</span>
              <span className="text-sm font-bold">{uploading ? uploading.name : 'فایل را اینجا رها کن یا کلیک کن'}</span>
              {uploading ? (
                <div style={{ width: '70%', marginTop: 4 }}>
                  <Progress value={uploading.pct} label="در حال آپلود" />
                </div>
              ) : (
                <span className="text-2xs dim">ویدیو، صدا، تصویر، PDF و JSON</span>
              )}
            </div>
          </label>

          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <label className="row text-2xs" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={compressOnUpload}
                onChange={(e) => setCompressOnUpload(e.target.checked)}
                style={{ accentColor: 'var(--gold)' }}
              />
              فشرده‌سازی خودکار ویدیو هنگام آپلود
            </label>
            <div className="row" style={{ gap: 6, marginInlineStart: 'auto' }}>
              <input
                className="input"
                style={{ minWidth: 240 }}
                placeholder="/home/user/cmstest/assets "
                value={importPath}
                onChange={(e) => setImportPath(e.target.value)}
              />
              <Button size="sm" onClick={() => void importFolder()}>ایندکس پوشه</Button>
            </div>
          </div>

          {/* the real folders on disk, so the user can see what exists */}
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {folders.map((f) => (
              <span
                key={f.folder}
                className={`chip ${f.exists ? '' : 'chip--warn'}`}
                title={f.path}
                style={{ fontSize: 10 }}
              >
                {f.folder}: {fa(f.files)}
              </span>
            ))}
          </div>
        </div>
      </Card>

      <Card tight>
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
          <Tabs
            value={kind}
            onChange={setKind}
            tabs={[
              { key: 'all', label: 'همه' },
              { key: 'video', label: 'ویدیو' },
              { key: 'audio', label: 'صدا' },
              { key: 'image', label: 'تصویر' },
              { key: 'document', label: 'سند' },
            ]}
          />
          <select className="select" style={{ maxWidth: 200 }} value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="">همه پوشه‌ها</option>
            {folders.map((f) => (
              <option key={f.folder} value={f.folder}>{f.folder}</option>
            ))}
          </select>
        </div>
      </Card>

      {items.length === 0 && (
        <Empty
          icon="📦"
          title="مخزن خالی است"
          text="یک فایل آپلود کن، یا مسیر پوشهٔ دارایی‌های خودت را بنویس تا ایندکس شود."
        />
      )}

      {grouped.map(([folderName, folderItems]) => (
        <Card key={folderName} title={folderName} subtitle={`${fa(folderItems.length)} فایل`} tight>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
            {folderItems.map((item) => (
              <div key={item.mediaId} className="card card--tight" style={{ background: 'var(--surface-2)', overflow: 'hidden', padding: 0 }}>
                <div
                  style={{
                    height: 100,
                    background: '#0a0a0c',
                    display: 'grid',
                    placeItems: 'center',
                    overflow: 'hidden',
                    position: 'relative',
                  }}
                >
                  {item.kind === 'image' ? (
                    <img src={item.url} alt={item.originalName} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : item.kind === 'video' ? (
                    <video src={item.url} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" />
                  ) : (
                    <span style={{ fontSize: 26 }} aria-hidden>{item.kind === 'audio' ? '🎵' : '📄'}</span>
                  )}
                  {item.parentId && (
                    <span className="chip" style={{ position: 'absolute', top: 4, insetInlineEnd: 4, fontSize: 9, background: 'rgba(0,0,0,0.6)' }}>
                      مشتق
                    </span>
                  )}
                </div>
                <div style={{ padding: 8 }}>
                  <div className="text-2xs font-bold clamp-1" title={item.originalName}>{item.originalName}</div>
                  <div className="row-between text-2xs dim" style={{ marginTop: 3 }}>
                    <span>{fmtBytes(item.bytes)}</span>
                    {item.durationSec != null && <span className="num">{fa(item.durationSec.toFixed(1))}s</span>}
                  </div>
                  {item.width && (
                    <div className="text-2xs dim">{fa(item.width)}×{fa(item.height)}</div>
                  )}
                  <div className="row" style={{ gap: 4, marginTop: 6 }}>
                    <Button size="sm" variant="ghost" style={{ flex: 1 }} onClick={() => void remove(item)}>
                      حذف
                    </Button>
                    {item.kind === 'video' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        style={{ flex: 1 }}
                        onClick={async () => {
                          const r = await run(() => mediaApi.compress(item.mediaId, { crf: 28 }), { success: 'فشرده شد' });
                          if (r) {
                            toast('info', `${fa(r.savedPct)}٪ کاهش حجم`);
                            await load();
                          }
                        }}
                      >
                        فشرده
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
