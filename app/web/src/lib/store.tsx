import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type AppState, type Job } from './api';

/* ────────────────────────── theme ────────────────────────── */

type Theme = 'dark' | 'light';
const THEME_KEY = 'atoz.theme';

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/* ────────────────────────── toasts ────────────────────────── */

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

/* ────────────────────────── context ────────────────────────── */

interface Store {
  state: AppState | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  theme: Theme;
  toggleTheme: () => void;
  toasts: Toast[];
  toast: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: number) => void;
  jobs: Job[];
  activeJobs: Job[];
  /** run an async action with automatic error→toast handling */
  run: <T>(fn: () => Promise<T>, opts?: { success?: string; silent?: boolean }) => Promise<T | null>;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const toastId = useRef(0);

  /* theme → <html data-theme> */
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  const toast = useCallback((kind: Toast['kind'], message: string) => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev.slice(-3), { id, kind, message }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5200);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [next, nextJobs] = await Promise.all([api.state(), api.jobs().catch(() => [])]);
      setState(next);
      setJobs(nextJobs);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در دریافت وضعیت');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();

    /* live job progress over SSE; falls back to polling when unavailable */
    let source: EventSource | null = null;
    let poll: number | undefined;
    try {
      source = new EventSource('/api/events');
      source.addEventListener('job', (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as {
          jobId: string;
          status: Job['status'];
          progress: number;
          step: string;
          error?: string | null;
        };
        setJobs((prev) => {
          const exists = prev.some((j) => j.jobId === payload.jobId);
          if (!exists) return prev;
          return prev.map((j) =>
            j.jobId === payload.jobId
              ? { ...j, status: payload.status, progress: payload.progress, step: payload.step, error: payload.error ?? j.error }
              : j
          );
        });
        if (payload.status === 'succeeded' || payload.status === 'failed') {
          void refresh();
        }
      });
      source.onerror = () => {
        source?.close();
        source = null;
        poll = window.setInterval(() => void refresh(), 5000);
      };
    } catch {
      poll = window.setInterval(() => void refresh(), 5000);
    }

    const interval = window.setInterval(() => void refresh(), 25000);
    return () => {
      source?.close();
      window.clearInterval(interval);
      if (poll) window.clearInterval(poll);
    };
  }, [refresh]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, opts?: { success?: string; silent?: boolean }): Promise<T | null> => {
      try {
        const result = await fn();
        if (opts?.success) toast('success', opts.success);
        return result;
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'خطای نامشخص';
        if (!opts?.silent) toast('error', message);
        return null;
      }
    },
    [toast]
  );

  const value = useMemo<Store>(
    () => ({
      state,
      loading,
      error,
      refresh,
      theme,
      toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
      toasts,
      toast,
      dismissToast,
      jobs,
      activeJobs: jobs.filter((j) => j.status === 'queued' || j.status === 'running'),
      run,
    }),
    [state, loading, error, refresh, theme, toasts, toast, dismissToast, jobs, run]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside StoreProvider');
  return ctx;
}

/** Tiny persisted-state hook for UI preferences. */
export function useLocalState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`atoz.${key}`);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`atoz.${key}`, JSON.stringify(value));
    } catch {
      /* ignore quota errors */
    }
  }, [key, value]);
  return [value, setValue] as const;
}
