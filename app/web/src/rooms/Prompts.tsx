import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Card, Empty, fa } from '../components/ui';
import type { RoomProps } from './index';

const META: Record<string, { title: string; desc: string; icon: string }> = {
  ATOOZ_CORE: { title: 'آتوز — دستیار فرماندهی', desc: 'لحن، قواعد تصمیم و اقدام‌های مجاز دستیار', icon: '🧠' },
  IDEATION_STRATEGY: { title: 'استراتژی ایده‌پردازی', desc: 'قواعد ساخت سه کانسپت متمایز', icon: '💡' },
  UNIFIED_CONTENT_FACTORY: { title: 'کارخانه محتوا', desc: 'ساختار صحنه، نریشن و کپشن', icon: '🏭' },
  SEO_EDITOR: { title: 'ویراستار سئو', desc: 'ساختاردهی مقاله با HTML معنایی', icon: '🔍' },
};

export function PromptsRoom(_props: RoomProps) {
  const { run } = useStore();
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.prompts().then((p) => {
      setPrompts(p);
      setDraft(p);
    });
  }, []);

  const changed = Object.keys(draft).filter((key) => draft[key] !== prompts[key]);

  const save = async () => {
    setSaving(true);
    const result = await run(() => api.savePrompts(draft), { success: 'پرامپت‌ها ذخیره شد' });
    setSaving(false);
    if (result) {
      setPrompts(result);
      setDraft(result);
    }
  };

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <div className="row-between">
        <div>
          <h2 style={{ fontSize: 'var(--fs-lg)' }}>پرامپت‌های مادر ایجنت</h2>
          <p className="text-2xs muted" style={{ margin: '4px 0 0' }}>
            ویرایش این متن‌ها لحن کل خط تولید را تغییر می‌دهد. هر ذخیره یک نسخه (version) جدید می‌سازد.
          </p>
        </div>
        <div className="row">
          {changed.length > 0 && <span className="chip chip--warn">{fa(changed.length)} تغییر ذخیره‌نشده</span>}
          <Button variant="primary" loading={saving} disabled={changed.length === 0} onClick={() => void save()}>
            💾 ذخیره
          </Button>
        </div>
      </div>

      {Object.keys(draft).length === 0 && <Empty icon="🧠" title="در حال بارگذاری پرامپت‌ها" />}

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        {Object.entries(draft).map(([key, value]) => {
          const meta = META[key] ?? { title: key, desc: '', icon: '📝' };
          const isChanged = value !== prompts[key];
          return (
            <Card
              key={key}
              title={<span className="row" style={{ gap: 8 }}><span aria-hidden>{meta.icon}</span>{meta.title}</span>}
              subtitle={meta.desc}
              accent={isChanged}
              actions={<span className="code">{key}</span>}
            >
              <textarea
                className="textarea"
                rows={9}
                dir="rtl"
                value={value}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                style={{ fontSize: 'var(--fs-xs)', lineHeight: 1.9, fontFamily: 'var(--font)' }}
              />
              <div className="row-between" style={{ marginTop: 8 }}>
                <span className="text-2xs dim">{fa(value.length)} کاراکتر</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDraft({ ...draft, [key]: prompts[key] })}
                  disabled={!isChanged}
                >
                  ↺ بازگردانی
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
