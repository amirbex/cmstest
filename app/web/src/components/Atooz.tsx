import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Spinner } from './ui';

interface Message {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  action?: string;
  requiresConfirmation?: boolean;
  pending?: boolean;
}

/**
 * The ATOOZ dock. Chat-only by default; voice input uses the browser's
 * SpeechRecognition when present and degrades to typed input otherwise, so it
 * never pretends to listen when the API is missing.
 */
export function AtoozDock() {
  const { state, run, refresh, toast } = useStore();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, open]);

  const send = async (text: string, confirmed = false) => {
    if (!text.trim()) return;
    const id = ++idRef.current;
    setMessages((prev) => [...prev, { id, role: 'user', text }]);
    setInput('');
    setBusy(true);
    const result = await run(() => api.chat(text, confirmed), { silent: true });
    setBusy(false);
    if (!result) {
      setMessages((prev) => [
        ...prev,
        { id: ++idRef.current, role: 'assistant', text: 'ارتباط با سرور برقرار نشد.' },
      ]);
      return;
    }
    setMessages((prev) => [
      ...prev,
      {
        id: ++idRef.current,
        role: 'assistant',
        text: result.reply,
        action: result.action,
        requiresConfirmation: result.requiresConfirmation && result.action !== 'NONE',
        pending: result.requiresConfirmation && result.action !== 'NONE',
      },
    ]);
    await refresh();
  };

  const confirm = async (messageId: number, text: string) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, pending: false } : m)));
    await send(text, true);
  };

  const toggleVoice = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      toast('error', 'مرورگر شما تشخیص گفتار ندارد — از Chrome استفاده کن یا تایپ کن');
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const recognition = new SR();
    recognition.lang = 'fa-IR';
    recognition.interimResults = false;
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setListening(false);
      void send(transcript);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  };

  const pendingCount = state?.stats.pending ?? 0;

  return (
    <>
      <button
        className="btn btn--primary"
        onClick={() => setOpen((o) => !o)}
        style={{
          position: 'fixed',
          bottom: 20,
          insetInlineStart: 20,
          zIndex: 55,
          borderRadius: 'var(--r-full)',
          padding: '0 20px',
          minHeight: 46,
          boxShadow: 'var(--shadow-lg)',
        }}
        aria-label="دستیار آتوز"
      >
        🧠 آتوز
      </button>

      {open && (
        <div className="overlay" onClick={() => setOpen(false)} style={{ alignItems: 'flex-end', padding: 16 }}>
          <div
            className="card"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(420px, 100%)',
              height: 'min(640px, 82vh)',
              display: 'flex',
              flexDirection: 'column',
              padding: 0,
              overflow: 'hidden',
              background: 'var(--bg-elevated)',
              marginBottom: 8,
            }}
          >
            <header className="row-between" style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
              <div className="row" style={{ gap: 10 }}>
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: '50%',
                    background: 'linear-gradient(135deg, var(--gold), var(--orange))',
                    display: 'grid',
                    placeItems: 'center',
                    fontWeight: 900,
                    color: '#0a0a0c',
                  }}
                >
                  آ
                </div>
                <div>
                  <div className="text-sm font-black">آتوز</div>
                  <div className="text-2xs" style={{ color: 'var(--ok)' }}>
                    ● {state?.system.ai.mode === 'cloud' ? 'متصل به مدل ابری' : 'حالت آفلاین'}
                  </div>
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)} aria-label="بستن">✕</Button>
            </header>

            <div ref={logRef} style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {messages.length === 0 && (
                <div className="card card--tight" style={{ background: 'var(--surface-2)', fontSize: 'var(--fs-xs)', lineHeight: 1.9 }}>
                  سلام! من آتوز هستم. می‌توانم ایده ثبت کنم، وضعیت خط تولید را بگویم یا تو را به اتاق مناسب ببرم.
                  <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                    {['وضعیت چطوره؟', 'یک ایده دارم', `${pendingCount} الگو در انتظار تایید`, 'برو استودیو'].map((suggestion) => (
                      <button key={suggestion} className="chip" style={{ cursor: 'pointer', fontFamily: 'inherit' }} onClick={() => void send(suggestion)}>
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((message) => (
                <div
                  key={message.id}
                  style={{
                    alignSelf: message.role === 'user' ? 'flex-start' : 'flex-end',
                    maxWidth: '88%',
                    background: message.role === 'user' ? 'rgba(255,180,0,0.16)' : 'var(--surface-2)',
                    border: `1px solid ${message.role === 'user' ? 'rgba(255,180,0,0.36)' : 'var(--border)'}`,
                    borderRadius: 'var(--r-md)',
                    padding: '9px 12px',
                    fontSize: 'var(--fs-xs)',
                    lineHeight: 1.9,
                  }}
                >
                  <div style={{ whiteSpace: 'pre-wrap' }}>{message.text}</div>
                  {message.pending && (
                    <div className="row" style={{ gap: 6, marginTop: 8 }}>
                      <Button size="sm" variant="ok" onClick={() => void confirm(message.id, message.text)}>تایید و اجرا</Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, pending: false } : m)))}
                      >
                        لغو
                      </Button>
                    </div>
                  )}
                </div>
              ))}

              {busy && (
                <div className="row text-2xs muted" style={{ gap: 8 }}>
                  <Spinner size={12} /> آتوز در حال پردازش…
                </div>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
              style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}
            >
              <Button
                type="button"
                variant={listening ? 'danger' : 'solid'}
                onClick={toggleVoice}
                title={listening ? 'توقف ضبط' : 'ورودی صوتی'}
              >
                {listening ? '⏹' : '🎙️'}
              </Button>
              <input
                className="input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="به آتوز بگو…"
                aria-label="پیام به آتوز"
              />
              <Button type="submit" variant="primary" loading={busy} disabled={!input.trim()}>ارسال</Button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
