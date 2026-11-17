import React, { useEffect, useState } from 'react';
import { api, type AiRun, type Quota } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Card, Empty, Progress, Tabs, fa, fmtRelative } from '../components/ui';
import type { RoomProps } from './index';

type LogLevel = 'ALL' | 'INFO' | 'WARN' | 'ERROR';

interface LogEntry {
  id: number;
  level: string;
  source: string;
  message: string;
  details: string | null;
  created_at: string;
}

export function MonitorRoom(_props: RoomProps) {
  const { state, jobs, run, refresh } = useStore();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<LogLevel>('INFO');
  const [quotas, setQuotas] = useState<Quota[]>([]);
  const [runs, setRuns] = useState<AiRun[]>([]);
  const [tab, setTab] = useState<'jobs' | 'logs' | 'quota'>('jobs');

  const load = async () => {
    const [l, q] = await Promise.all([api.logs(level), api.quotas().catch(() => ({ quotas: [], runs: [] }))]);
    setLogs(l);
    setQuotas(q.quotas);
    setRuns(q.runs);
  };

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 12000);
    return () => window.clearInterval(id);
  }, [level]);

  const ai = state?.system.ai;

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <div className="grid grid-4">
        <Card tight>
          <div className="kpi">
            <span className="kpi-label">حالت هوش مصنوعی</span>
            <span className="kpi-value" style={{ fontSize: 'var(--fs-xl)', color: ai?.mode === 'cloud' ? 'var(--ok)' : 'var(--gold)' }}>
              {ai?.mode === 'cloud' ? 'ابری' : 'آفلاین'}
            </span>
            <span className="text-2xs dim">{ai?.hasKey ? 'کلید API فعال' : 'بدون کلید — قالب آفلاین'}</span>
          </div>
        </Card>
        <Card tight>
          <div className="kpi">
            <span className="kpi-label">جاب‌های در صف</span>
            <span className="kpi-value" style={{ fontSize: 'var(--fs-2xl)' }}>{fa(state?.system.queueDepth ?? 0)}</span>
          </div>
        </Card>
        <Card tight>
          <div className="kpi">
            <span className="kpi-label">حافظه مصرفی</span>
            <span className="kpi-value" style={{ fontSize: 'var(--fs-2xl)' }}>{fa(state?.system.ramUsedMb ?? 0)}<span className="text-sm muted"> مگ</span></span>
          </div>
        </Card>
        <Card tight>
          <div className="kpi">
            <span className="kpi-label">خطاهای اخیر</span>
            <span className="kpi-value" style={{ fontSize: 'var(--fs-2xl)', color: logs.filter((l) => l.level === 'ERROR').length ? 'var(--danger)' : 'var(--ok)' }}>
              {fa(logs.filter((l) => l.level === 'ERROR').length)}
            </span>
          </div>
        </Card>
      </div>

      <Tabs<'jobs' | 'logs' | 'quota'>
        tabs={[
          { key: 'jobs', label: 'صف رندر', count: jobs.length },
          { key: 'logs', label: 'لاگ‌ها', count: logs.length },
          { key: 'quota', label: 'سهمیه و مصرف', count: runs.length },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'jobs' && (
        <Card title="جاب‌های رندر" actions={<Button size="sm" variant="ghost" onClick={() => void refresh()}>↻</Button>}>
          {jobs.length === 0 ? (
            <Empty icon="⚙️" title="هیچ جابی ثبت نشده" text="از استودیو یک رندر بگیر تا اینجا با پیشرفت زنده ببینی." />
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {jobs.map((job) => (
                <div key={job.jobId} className="card card--tight stack" style={{ gap: 8, background: 'var(--surface-2)' }}>
                  <div className="row-between">
                    <div className="row" style={{ gap: 8, minWidth: 0 }}>
                      <span className="code">{job.jobId}</span>
                      <span className="chip">
                        {job.kind === 'reel' ? '🎬 ریلز' : job.kind === 'carousel' ? '📑 کاروسل' : job.kind === 'cover' ? '🖼️ کاور' : '📦 بسته'}
                      </span>
                      <span className="code">{job.contentId}</span>
                    </div>
                    <span
                      className={`chip ${
                        job.status === 'succeeded' ? 'chip--ok' : job.status === 'failed' ? 'chip--danger' : job.status === 'running' ? 'chip--gold' : ''
                      }`}
                    >
                      {job.status === 'succeeded' ? 'موفق' : job.status === 'failed' ? 'ناموفق' : job.status === 'running' ? 'در حال اجرا' : job.status === 'queued' ? 'در صف' : 'لغو شده'}
                    </span>
                  </div>
                  {(job.status === 'running' || job.status === 'queued') && <Progress value={job.progress} label={job.step} />}
                  {job.error && <div className="text-2xs" style={{ color: 'var(--danger)' }}>{job.error}</div>}
                  {job.result.length > 0 && (
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {job.result.map((file, i) => (
                        <a key={i} href={file.url} target="_blank" rel="noreferrer" className="chip chip--ok" style={{ textDecoration: 'none' }}>
                          {file.kind === 'video' ? '🎬' : '🖼️'} {file.url.split('/').pop()?.slice(0, 28)}
                        </a>
                      ))}
                    </div>
                  )}
                  <div className="text-2xs dim">{fmtRelative(job.createdAt)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'logs' && (
        <Card
          title="کنسول رویدادها"
          actions={
            <div className="row">
              <select className="select" style={{ minHeight: 30, fontSize: 11, width: 110 }} value={level} onChange={(e) => setLevel(e.target.value as LogLevel)}>
                {(['ALL', 'INFO', 'WARN', 'ERROR'] as LogLevel[]).map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await run(() => api.clearLogs(), { success: 'لاگ‌ها پاک شد' });
                  await load();
                }}
              >
                پاک‌سازی
              </Button>
            </div>
          }
        >
          {logs.length === 0 ? (
            <Empty icon="📡" title="لاگی نیست" />
          ) : (
            <div className="logbox">
              {logs.map((entry) => (
                <div key={entry.id} style={{ marginBottom: 3 }}>
                  <span style={{ color: entry.level === 'ERROR' ? '#fda4af' : entry.level === 'WARN' ? '#fbbf24' : '#86efac' }}>
                    [{entry.level}]
                  </span>{' '}
                  <span style={{ color: '#64748b' }}>{entry.created_at.slice(11, 19)}</span>{' '}
                  <span style={{ color: '#7dd3fc' }}>({entry.source})</span> {entry.message}
                  {entry.details && <span style={{ color: '#475569' }}> — {entry.details.slice(0, 160)}</span>}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'quota' && (
        <div className="grid grid-2" style={{ alignItems: 'start' }}>
          <Card title="سهمیه روزانه مدل‌ها" subtitle="شمارنده واقعی درخواست‌ها و هزینه">
            {quotas.length === 0 ? (
              <div className="text-2xs dim">هنوز مصرفی ثبت نشده است.</div>
            ) : (
              <div className="stack" style={{ gap: 12 }}>
                {quotas.map((q) => (
                  <div key={q.model} className="stack" style={{ gap: 5 }}>
                    <div className="row-between text-xs">
                      <span className="code">{q.model}</span>
                      <span className="num muted">
                        {fa(q.used)} / {fa(q.limit)} · ${fa(q.costUsd.toFixed(4))}
                      </span>
                    </div>
                    <Progress value={(q.used / Math.max(1, q.limit)) * 100} />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="آخرین اجرای ایجنت‌ها" subtitle="تأخیر، توکن و وضعیت هر فراخوانی">
            {runs.length === 0 ? (
              <Empty icon="🤖" title="فراخوانی‌ای ثبت نشده" text="در حالت آفلاین هیچ درخواست ابری ارسال نمی‌شود؛ پس این جدول خالی می‌ماند." />
            ) : (
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr><th>ایجنت</th><th>مدل</th><th>وضعیت</th><th>توکن</th><th>تأخیر</th></tr>
                  </thead>
                  <tbody>
                    {runs.slice(0, 12).map((entry) => (
                      <tr key={entry.id}>
                        <td className="text-2xs">{entry.agentId}</td>
                        <td><span className="code">{entry.model}</span></td>
                        <td>
                          <span className={`chip ${entry.status === 'ok' ? 'chip--ok' : 'chip--warn'}`}>{entry.status}</span>
                        </td>
                        <td className="num">{fa(entry.tokens)}</td>
                        <td className="num">{fa(entry.latencyMs)}ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
