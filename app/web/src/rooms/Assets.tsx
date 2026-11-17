import React, { useEffect, useState } from 'react';
import { api, type DamFolder } from '../lib/api';
import { Button, Card, Empty, fa, fmtBytes } from '../components/ui';
import type { RoomProps } from './index';

export function AssetsRoom(_props: RoomProps) {
  const [folders, setFolders] = useState<DamFolder[]>([]);
  const [open, setOpen] = useState<string | null>('outputs');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setFolders(await api.dam());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const totalBytes = folders.reduce((sum, f) => sum + f.bytes, 0);
  const totalFiles = folders.reduce((sum, f) => sum + f.count, 0);

  const isImage = (name: string) => /\.(png|jpe?g|webp|svg|gif)$/i.test(name);
  const isVideo = (name: string) => /\.(mp4|webm|mov)$/i.test(name);
  const isAudio = (name: string) => /\.(mp3|wav|ogg|m4a)$/i.test(name);

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <div className="grid grid-3">
        <Card tight>
          <div className="kpi">
            <span className="kpi-label">کل فایل‌ها</span>
            <span className="kpi-value">{fa(totalFiles)}</span>
          </div>
        </Card>
        <Card tight>
          <div className="kpi">
            <span className="kpi-label">حجم کل</span>
            <span className="kpi-value" style={{ fontSize: 'var(--fs-2xl)' }}>{fmtBytes(totalBytes)}</span>
          </div>
        </Card>
        <Card tight>
          <div className="kpi">
            <span className="kpi-label">پوشه‌ها</span>
            <span className="kpi-value">{fa(folders.length)}</span>
          </div>
        </Card>
      </div>

      <div className="row-between">
        <h2 style={{ fontSize: 'var(--fs-lg)' }}>مخزن دارایی دیجیتال</h2>
        <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading}>↻ بروزرسانی</Button>
      </div>

      {!loading && folders.every((f) => f.count === 0) && (
        <Empty
          icon="🗄️"
          title="مخزن خالی است"
          text="فایل‌های تولیدشده در پوشه outputs، فونت‌ها و نمونه‌های صوتی اینجا فهرست می‌شوند."
        />
      )}

      {folders.map((folder) => (
        <Card
          key={folder.id}
          title={
            <span className="row" style={{ gap: 8 }}>
              <span aria-hidden>📂</span>
              {folder.title}
            </span>
          }
          subtitle={`${fa(folder.count)} فایل · ${fmtBytes(folder.bytes)}`}
          actions={
            <Button size="sm" variant="ghost" onClick={() => setOpen(open === folder.id ? null : folder.id)}>
              {open === folder.id ? 'بستن' : 'باز کردن'}
            </Button>
          }
        >
          {open === folder.id && (
            folder.files.length === 0 ? (
              <div className="text-2xs dim">این پوشه خالی است.</div>
            ) : (
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
                {folder.files.slice(0, 60).map((file) => (
                  <a
                    key={file.url}
                    href={file.url}
                    target="_blank"
                    rel="noreferrer"
                    className="card card--tight stack"
                    style={{ gap: 6, padding: 8, textDecoration: 'none', color: 'inherit', alignItems: 'center' }}
                  >
                    <div
                      style={{
                        width: '100%',
                        height: 66,
                        borderRadius: 'var(--r-sm)',
                        background: 'var(--surface-3)',
                        display: 'grid',
                        placeItems: 'center',
                        overflow: 'hidden',
                      }}
                    >
                      {isImage(file.name) ? (
                        <img src={file.url} alt={file.name} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                      ) : isVideo(file.name) ? (
                        <span style={{ fontSize: 22 }} aria-hidden>🎬</span>
                      ) : isAudio(file.name) ? (
                        <span style={{ fontSize: 22 }} aria-hidden>🔊</span>
                      ) : (
                        <span style={{ fontSize: 22 }} aria-hidden>📄</span>
                      )}
                    </div>
                    <div className="text-2xs truncate" style={{ width: '100%', textAlign: 'center', direction: 'ltr' }} title={file.name}>
                      {file.name}
                    </div>
                    <div className="text-2xs dim">{fmtBytes(file.bytes)}</div>
                  </a>
                ))}
              </div>
            )
          )}
        </Card>
      ))}
    </div>
  );
}
