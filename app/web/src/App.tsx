import React, { useEffect, useState } from 'react';
import { StoreProvider, useStore } from './lib/store';
import { Sidebar, MobileNav, Topbar } from './components/Shell';
import { RoomView, ROOM_META, type RoomKey } from './rooms';
import { Button, Empty, Spinner, Toasts } from './components/ui';
import { AtoozDock } from './components/Atooz';

const VALID: RoomKey[] = [
  'command',
  'calendar',
  'production',
  'editor',
  'templates',
  'assets',
  'insights',
  'ideation',
  'prompts',
  'skills',
  'monitor',
];

/** Hash may carry a sub-route, e.g. #editor?doc=EDT-… — only the room matters here. */
function readRoom(): RoomKey {
  const hash = window.location.hash.replace('#', '').split('?')[0] as RoomKey;
  return VALID.includes(hash) ? hash : 'command';
}

function Workspace() {
  const { state, loading, error, refresh, toasts, dismissToast } = useStore();
  const [room, setRoom] = useState<RoomKey>(readRoom);

  /* deep-linkable rooms, back/forward aware */
  useEffect(() => {
    const onHash = () => setRoom(readRoom());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = (next: RoomKey) => {
    window.location.hash = next;
    setRoom(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (loading && !state) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', gap: 16 }}>
        <div className="stack" style={{ alignItems: 'center', gap: 14 }}>
          <Spinner size={28} />
          <div className="text-sm muted">در حال اتصال به استودیو…</div>
        </div>
      </div>
    );
  }

  if (error && !state) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 24 }}>
        <Empty
          icon="🔌"
          title="ارتباط با سرور برقرار نشد"
          text={error}
          action={<Button variant="primary" onClick={() => void refresh()}>تلاش دوباره</Button>}
        />
      </div>
    );
  }

  const meta = ROOM_META[room];

  return (
    <div className="shell">
      <Sidebar current={room} onNavigate={navigate} />
      <div className="main">
        <Topbar title={meta.title} subtitle={meta.subtitle} />
        <main className="page">
          <RoomView room={room} onNavigate={navigate} />
        </main>
      </div>
      <MobileNav current={room} onNavigate={navigate} />
      <AtoozDock />
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Workspace />
    </StoreProvider>
  );
}
