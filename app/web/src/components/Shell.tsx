import React from 'react';
import { useStore } from '../lib/store';
import { fa } from './ui';
import type { RoomKey } from '../rooms';

export const ROOMS: { key: RoomKey; label: string; short: string; icon: string; hint: string }[] = [
  { key: 'command', label: 'داشبورد فرماندهی', short: 'داشبورد', icon: '🏛️', hint: 'وضعیت لحظه‌ای استودیو' },
  { key: 'calendar', label: 'تقویم جلالی انتشار', short: 'تقویم', icon: '📅', hint: 'برنامه‌ریزی و انتشار' },
  { key: 'plan', label: 'برنامه ۳ ماهه', short: 'برنامه', icon: '🧩', hint: 'بلوک‌ها و دروازه تایید' },
  { key: 'ideation', label: 'اتاق فکر', short: 'ایده', icon: '💡', hint: 'کانسپت و ساخت بسته' },
  { key: 'studio', label: 'استودیو تدوین', short: 'استودیو', icon: '🎬', hint: 'بوم لایه‌ای و رندر' },
  { key: 'gallery', label: 'گالری خروجی‌ها', short: 'گالری', icon: '🎞️', hint: 'ویدئو، کاروسل، کاور' },
  { key: 'assets', label: 'مخزن دارایی', short: 'دارایی', icon: '🗄️', hint: 'فایل‌ها و صداها' },
  { key: 'insights', label: 'داده و بینش', short: 'داده', icon: '📈', hint: 'KPI و قیف' },
  { key: 'prompts', label: 'پرامپت‌های ایجنت', short: 'پرامپت', icon: '🧠', hint: 'شخصیت و لحن' },
  { key: 'skills', label: 'ایجنت‌ها و مهارت‌ها', short: 'مهارت', icon: '🧩', hint: 'نقش‌ها و مهارت‌های تزریقی' },
  { key: 'monitor', label: 'نظارت و لاگ', short: 'نظارت', icon: '📡', hint: 'سهمیه، جاب، خطا' },
];

export function Sidebar({ current, onNavigate }: { current: RoomKey; onNavigate: (room: RoomKey) => void }) {
  const { state, theme, toggleTheme, activeJobs } = useStore();
  const stats = state?.stats;

  const badgeFor = (key: RoomKey) => {
    if (key === 'plan' && stats?.pending) return fa(stats.pending);
    if (key === 'gallery' && stats?.produced) return fa(stats.produced);
    if (key === 'studio' && activeJobs.length) return fa(activeJobs.length);
    return null;
  };

  return (
    <aside className="sidebar" aria-label="ناوبری اصلی">
      <div className="brandmark">
        <div className="brandmark-logo">AZ</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 900, fontSize: 'var(--fs-md)' }}>AtoZ Studio</div>
          <div className="text-2xs dim truncate">{state?.system.today.jalaliDigits ?? 'در حال بارگذاری'}</div>
        </div>
        <button
          className="btn btn--ghost btn--icon"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'حالت روشن' : 'حالت تاریک'}
          aria-label={theme === 'dark' ? 'تغییر به حالت روشن' : 'تغییر به حالت تاریک'}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>

      <nav className="nav">
        {ROOMS.map((room) => {
          const badge = badgeFor(room.key);
          return (
            <button
              key={room.key}
              className="nav-item"
              aria-current={current === room.key ? 'page' : undefined}
              onClick={() => onNavigate(room.key)}
              title={room.hint}
            >
              <span className="nav-icon" aria-hidden>{room.icon}</span>
              <span>{room.label}</span>
              {badge && <span className="nav-badge">{badge}</span>}
            </button>
          );
        })}
      </nav>

      <div className="spacer" />

      <div className="card card--tight" style={{ background: 'var(--surface-2)' }}>
        <div className="row-between text-2xs muted">
          <span>موتور هوش مصنوعی</span>
          <span className={`chip ${state?.system.ai.mode === 'cloud' ? 'chip--ok' : 'chip--gold'}`}>
            {state?.system.ai.mode === 'cloud' ? 'ابری' : 'آفلاین'}
          </span>
        </div>
        <div className="text-2xs dim" style={{ marginTop: 6, lineHeight: 1.7 }}>
          {state?.system.ai.mode === 'cloud'
            ? state?.system.ai.chain[0]
            : 'بدون کلید API — خروجی قالب‌محور آفلاین'}
        </div>
      </div>
    </aside>
  );
}

export function MobileNav({ current, onNavigate }: { current: RoomKey; onNavigate: (room: RoomKey) => void }) {
  return (
    <nav className="mobile-nav" aria-label="ناوبری موبایل">
      {ROOMS.map((room) => (
        <button
          key={room.key}
          aria-current={current === room.key ? 'page' : undefined}
          onClick={() => onNavigate(room.key)}
        >
          <span aria-hidden style={{ fontSize: 17 }}>{room.icon}</span>
          <span>{room.short}</span>
        </button>
      ))}
    </nav>
  );
}

export function Topbar({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  const { state, refresh } = useStore();
  return (
    <header className="topbar">
      <div style={{ minWidth: 0 }}>
        <div className="topbar-title truncate">{title}</div>
        {subtitle && <div className="topbar-meta truncate">{subtitle}</div>}
      </div>
      <div className="spacer" />
      {children}
      <div className="row text-2xs muted" style={{ gap: 12 }}>
        <span className="num" title="وضعیت سیستم">
          CPU {fa(state?.system.cpuPct ?? 0)}٪
        </span>
        <span className="num" title="حافظه مصرفی">
          RAM {fa(state?.system.ramUsedMb ?? 0)}M
        </span>
        {(state?.system.queueDepth ?? 0) > 0 && (
          <span className="chip chip--gold">{fa(state?.system.queueDepth ?? 0)} در صف</span>
        )}
        <button className="btn btn--ghost btn--sm" onClick={() => void refresh()} title="بروزرسانی">
          ↻
        </button>
      </div>
    </header>
  );
}
