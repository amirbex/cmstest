import React, { useEffect, useState } from 'react';
import type { ContentStatus, Subbrand } from '../lib/api';

/* ────────────────────────── formatting ────────────────────────── */

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

export const fa = (value: string | number | null | undefined) =>
  String(value ?? '').replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${fa(value.toFixed(value >= 10 || i === 0 ? 0 : 1))} ${units[i]}`;
}

export function fmtRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'همین حالا';
  if (mins < 60) return `${fa(mins)} دقیقه پیش`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${fa(hours)} ساعت پیش`;
  const days = Math.floor(hours / 24);
  return `${fa(days)} روز پیش`;
}

/* ────────────────────────── status ────────────────────────── */

const STATUS_MAP: Record<ContentStatus, { label: string; tone: 'gold' | 'ok' | 'warn' | 'danger' | 'info' | 'muted' }> = {
  draft: { label: 'پیش‌نویس', tone: 'muted' },
  blueprint_pending: { label: 'در انتظار تایید', tone: 'warn' },
  approved_for_production: { label: 'تاییدشده', tone: 'info' },
  queued: { label: 'در صف رندر', tone: 'info' },
  rendering: { label: 'در حال رندر', tone: 'gold' },
  produced: { label: 'تولیدشده', tone: 'ok' },
  scheduled: { label: 'زمان‌بندی‌شده', tone: 'info' },
  published: { label: 'منتشرشده', tone: 'ok' },
  failed: { label: 'ناموفق', tone: 'danger' },
  archived: { label: 'بایگانی', tone: 'muted' },
};

export function StatusChip({ status }: { status: ContentStatus }) {
  const meta = STATUS_MAP[status] ?? { label: status, tone: 'muted' as const };
  return <span className={`chip chip--${meta.tone}`}>{meta.label}</span>;
}

export function statusLabel(status: ContentStatus) {
  return STATUS_MAP[status]?.label ?? status;
}

/* ────────────────────────── primitives ────────────────────────── */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'solid' | 'ghost' | 'danger' | 'ok';
  size?: 'sm' | 'md';
  icon?: string;
  loading?: boolean;
  block?: boolean;
};

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  loading,
  block,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    variant !== 'default' ? `btn--${variant}` : '',
    size === 'sm' ? 'btn--sm' : '',
    block ? 'btn--block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <Spinner size={14} /> : icon ? <span aria-hidden>{icon}</span> : null}
      {children}
    </button>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        border: '2px solid currentColor',
        borderTopColor: 'transparent',
        borderRadius: '50%',
        display: 'inline-block',
        animation: 'spin 0.7s linear infinite',
        opacity: 0.8,
      }}
    />
  );
}

export function Card({
  children,
  className = '',
  title,
  subtitle,
  actions,
  accent,
  tight,
  flush,
}: {
  children?: React.ReactNode;
  className?: string;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  accent?: boolean;
  tight?: boolean;
  flush?: boolean;
}) {
  return (
    <section className={`card ${tight ? 'card--tight' : ''} ${flush ? 'card--flush' : ''} ${accent ? 'card--accent' : ''} ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <div className="card-title">{title}</div>}
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Kpi({
  label,
  value,
  hint,
  tone = 'default',
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'default' | 'gold' | 'ok' | 'warn' | 'danger' | 'info';
  icon?: string;
}) {
  const color =
    tone === 'gold'
      ? 'var(--gold)'
      : tone === 'ok'
        ? 'var(--ok)'
        : tone === 'warn'
          ? 'var(--warn)'
          : tone === 'danger'
            ? 'var(--danger)'
            : tone === 'info'
              ? 'var(--info)'
              : 'var(--text)';
  return (
    <div className="card card--tight kpi">
      <div className="row-between">
        <span className="kpi-label">{label}</span>
        {icon && <span aria-hidden style={{ opacity: 0.6 }}>{icon}</span>}
      </div>
      <div className="kpi-value" style={{ color }}>{value}</div>
      {hint && <div className="kpi-delta muted">{hint}</div>}
    </div>
  );
}

export function Empty({
  icon = '🗂️',
  title,
  text,
  action,
}: {
  icon?: string;
  title: string;
  text?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden>{icon}</div>
      <div className="empty-title">{title}</div>
      {text && <p className="empty-text">{text}</p>}
      {action}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { key: T; label: string; count?: number }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={value === tab.key}
          className="tab"
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="muted"> ({fa(tab.count)})</span>}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="text-2xs dim">{hint}</span>}
    </label>
  );
}

export function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      {label && (
        <div className="row-between text-2xs muted">
          <span>{label}</span>
          <span className="num">{fa(Math.round(value))}٪</span>
        </div>
      )}
      <div className="progress" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress-bar" style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

export function SectionBadge({ section, brand }: { section: Subbrand; brand?: { sectionThemes: Record<string, { accent: string; subbrandName: string }> } }) {
  const theme = brand?.sectionThemes?.[section];
  return (
    <span
      className="chip"
      style={{
        borderColor: theme ? `${theme.accent}66` : undefined,
        background: theme ? `${theme.accent}22` : undefined,
        color: theme?.accent,
      }}
      title={theme?.subbrandName}
    >
      {theme?.subbrandName ?? section}
    </span>
  );
}

/* ────────────────────────── modal ────────────────────────── */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <div
        className="modal"
        style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row-between" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 'var(--fs-xl)' }}>{title}</h3>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="بستن">✕</Button>
        </div>
        {children}
        {footer && <div className="row" style={{ marginTop: 20, justifyContent: 'flex-end' }}>{footer}</div>}
      </div>
    </div>
  );
}

/* ────────────────────────── toasts ────────────────────────── */

export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: { id: number; kind: 'success' | 'error' | 'info'; message: string }[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`} onClick={() => onDismiss(t.id)}>
          <span aria-hidden>{t.kind === 'success' ? '✓' : t.kind === 'error' ? '⚠' : 'ℹ'}</span>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

/* ────────────────────────── misc ────────────────────────── */

/** Copy-to-clipboard button with transient confirmation. */
export function CopyButton({ value, label = 'کپی' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? '✓ کپی شد' : label}
    </Button>
  );
}

export function MediaPreview({ url, kind }: { url: string; kind: string }) {
  if (kind === 'video' || url.endsWith('.mp4') || url.endsWith('.webm')) {
    return <video src={url} controls playsInline preload="metadata" style={{ width: '100%', borderRadius: 'var(--r-md)', background: '#000' }} />;
  }
  if (kind === 'audio' || /\.(mp3|wav|ogg)$/.test(url)) {
    return <audio src={url} controls style={{ width: '100%' }} />;
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      style={{ width: '100%', borderRadius: 'var(--r-md)', display: 'block', background: 'var(--surface-3)' }}
    />
  );
}
