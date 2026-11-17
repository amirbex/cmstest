import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { AgentRoster, ContextPreview, SkillDetail, SkillsIndex } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Card, Empty, Kpi, Modal, fa } from '../components/ui';
import type { RoomProps } from './index';

const MODE_LABEL: Record<string, { text: string; cls: string }> = {
  cloud: { text: 'Gemini (اصلی)', cls: 'chip--ok' },
  'local-llm': { text: 'مدل محلی', cls: 'chip--gold' },
  local: { text: 'قالب آفلاین', cls: 'chip--warn' },
};

export function SkillsRoom(_props: RoomProps) {
  const { run, refresh } = useStore();
  const [roster, setRoster] = useState<AgentRoster | null>(null);
  const [index, setIndex] = useState<SkillsIndex | null>(null);
  const [openSkill, setOpenSkill] = useState<SkillDetail | null>(null);
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'agents' | 'skills'>('agents');

  const load = async () => {
    const [r, s] = await Promise.all([api.agents(), api.skills()]);
    setRoster(r);
    setIndex(s);
  };

  useEffect(() => {
    void load();
  }, []);

  const mode = roster?.status.mode ?? 'local';
  const modeMeta = MODE_LABEL[mode] ?? { text: mode, cls: '' };

  const skillsById = useMemo(() => new Map((index?.skills ?? []).map((s) => [s.id, s])), [index]);

  const reload = async () => {
    setBusy(true);
    const result = await run(() => api.reloadSkills(), { success: 'مهارت‌ها از دیسک بازخوانی شد' });
    setBusy(false);
    if (result) await load();
  };

  const showSkill = async (id: string) => {
    const detail = await run(() => api.skill(id));
    if (detail) setOpenSkill(detail);
  };

  const showContext = async (agentId: string) => {
    const ctx = await run(() => api.contextPreview(agentId));
    if (ctx) setPreview(ctx);
  };

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <div className="row-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 'var(--fs-lg)' }}>ایجنت‌ها و مهارت‌ها</h2>
          <p className="text-2xs muted" style={{ margin: '4px 0 0' }}>
            هر ایجنت یک نقش است با پرامپت، مهارت و قرارداد خروجی مستقل. فایل‌های <span className="code">skills/*/SKILL.md</span> بدون
            تغییر کد، رفتار مدل را تغییر می‌دهند.
          </p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className={`chip ${modeMeta.cls}`}>{modeMeta.text}</span>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => void reload()}>
            ↻ بازخوانی مهارت‌ها
          </Button>
        </div>
      </div>

      <div className="grid grid-4">
        <Card tight>
          <Kpi label="ایجنت‌های فعال" value={fa(roster?.agents.length ?? 0)} icon="🤖" />
        </Card>
        <Card tight>
          <Kpi label="مهارت‌های تزریقی" value={fa(index?.skills.filter((s) => s.inject).length ?? 0)} icon="🧩" />
        </Card>
        <Card tight>
          <Kpi label="اسناد دانش‌پایه" value={fa(index?.knowledge.length ?? 0)} icon="📚" />
        </Card>
        <Card tight>
          <Kpi
            label={roster?.status.provider === 'gemini' ? 'مدل اصلی' : 'مدل فعال'}
            value={roster?.status.primary ?? '—'}
            hint={roster?.status.chain.length ? `زنجیره: ${roster.status.chain.join(' → ')}` : undefined}
            icon="🔗"
          />
        </Card>
      </div>

      <div className="row" style={{ gap: 6 }}>
        <Button size="sm" variant={tab === 'agents' ? 'primary' : 'ghost'} onClick={() => setTab('agents')}>
          🤖 ایجنت‌ها ({fa(roster?.agents.length ?? 0)})
        </Button>
        <Button size="sm" variant={tab === 'skills' ? 'primary' : 'ghost'} onClick={() => setTab('skills')}>
          🧩 مهارت‌ها ({fa(index?.skills.length ?? 0)})
        </Button>
      </div>

      {tab === 'agents' && (
        <div className="stack" style={{ gap: 'var(--s-3)' }}>
          {(roster?.agents ?? []).length === 0 && <Empty icon="🤖" title="در حال بارگذاری ایجنت‌ها" />}
          {(roster?.agents ?? []).map((agent) => (
            <Card key={agent.id}>
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="code">{agent.id}</span>
                    <strong style={{ fontSize: 'var(--fs-md)' }}>{agent.label}</strong>
                    {agent.canAct && <span className="chip chip--gold">اقدام‌کننده</span>}
                  </div>
                  <p className="text-xs muted" style={{ margin: '6px 0 0' }}>
                    {agent.role}
                  </p>
                  <div className="row text-2xs dim" style={{ gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
                    <span>
                      پرامپت: <span className="code">{agent.promptKey}</span>
                    </span>
                    <span>
                      قرارداد خروجی: <span className="code">{agent.schema}</span>
                    </span>
                    <span>
                      زمینه: <span className="num">{fa(agent.contextChars)}</span> کاراکتر
                    </span>
                    <span>
                      اجرا: <span className="num">{fa(agent.runs)}</span>
                      {agent.lastLatencyMs ? ` · آخرین ${fa(agent.lastLatencyMs)}ms` : ''}
                    </span>
                  </div>
                  <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                    {agent.skills.length === 0 && <span className="chip chip--warn">بدون مهارت تزریقی</span>}
                    {agent.skills.map((id) => (
                      <button key={id} className="chip chip--accent" onClick={() => void showSkill(id)} title="مشاهده متن مهارت">
                        {skillsById.get(id)?.title ?? id}
                      </button>
                    ))}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void showContext(agent.id)}>
                  🔍 دیدن پرامپت نهایی
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab === 'skills' && (
        <div className="grid grid-2" style={{ alignItems: 'start' }}>
          {(index?.skills ?? []).map((skill) => (
            <Card key={skill.id} title={skill.title} subtitle={skill.capability}>
              <div className="stack" style={{ gap: 8 }}>
                <div className="row-between text-2xs dim">
                  <span className="code">{skill.file}</span>
                  <span className="num">{fa(skill.chars)} کاراکتر</span>
                </div>
                <p className="text-xs muted clamp-2" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                  {skill.preview.replace(/[#*|]/g, '').trim()}
                </p>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <span className={`chip ${skill.inject ? 'chip--ok' : 'chip--warn'}`}>{skill.inject ? 'تزریق فعال' : 'تزریق خاموش'}</span>
                  {skill.agents.map((a) => (
                    <span key={a} className="chip">
                      {a}
                    </span>
                  ))}
                </div>
                <Button size="sm" variant="ghost" onClick={() => void showSkill(skill.id)}>
                  📖 خواندن کامل
                </Button>
              </div>
            </Card>
          ))}

          <Card title="دانش‌پایه برند" subtitle="همیشه در همه پرامپت‌ها تزریق می‌شود" accent>
            <div className="stack" style={{ gap: 6 }}>
              {(index?.knowledge ?? []).map((doc) => (
                <button
                  key={doc.id}
                  className="row-between text-xs"
                  style={{ background: 'none', border: 0, padding: '4px 0', cursor: 'pointer', color: 'inherit' }}
                  onClick={() => void showSkill(doc.id)}
                >
                  <span className="code">{doc.file}</span>
                  <span className="num dim">{fa(doc.chars)}</span>
                </button>
              ))}
              {(index?.knowledge ?? []).length === 0 && <span className="text-2xs dim">فایلی در knowledge-base نیست.</span>}
            </div>
          </Card>
        </div>
      )}

      <Modal open={Boolean(openSkill)} title={openSkill?.title ?? openSkill?.id ?? ''} onClose={() => setOpenSkill(null)} width={860}>
        {openSkill && (
          <div className="stack" style={{ gap: 10 }}>
            <div className="row text-2xs dim" style={{ gap: 12, flexWrap: 'wrap' }}>
              <span className="code">{openSkill.file}</span>
              {openSkill.agents?.length ? <span>ایجنت‌ها: {openSkill.agents.join(', ')}</span> : null}
            </div>
            <div className="logbox" style={{ maxHeight: '58vh', whiteSpace: 'pre-wrap', direction: 'ltr', textAlign: 'left' }}>
              {openSkill.body}
            </div>
            <p className="text-2xs dim" style={{ margin: 0 }}>
              برای ویرایش، فایل را روی دیسک تغییر بده و «بازخوانی مهارت‌ها» را بزن — بدون ری‌استارت سرور.
            </p>
          </div>
        )}
      </Modal>

      <Modal open={Boolean(preview)} title={`پرامپت نهایی — ${preview?.agentId ?? ''}`} onClose={() => setPreview(null)} width={860}>
        {preview && (
          <div className="stack" style={{ gap: 10 }}>
            <div className="row-between text-2xs dim">
              <span>مهارت‌های اعمال‌شده: {preview.applied.join(', ') || 'هیچ'}</span>
              <span className="num">{fa(preview.chars)} کاراکتر</span>
            </div>
            <div className="logbox" style={{ maxHeight: '58vh', whiteSpace: 'pre-wrap', textAlign: 'right' }}>
              {preview.text || '(خالی — پوشه‌های skills و knowledge-base خالی هستند)'}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
