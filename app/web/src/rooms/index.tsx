import React from 'react';
import { CommandRoom } from './Command';
import { CalendarRoom } from './Calendar';
import { PlanRoom } from './Plan';
import { IdeationRoom } from './Ideation';
import { StudioRoom } from './Studio';
import { GalleryRoom } from './Gallery';
import { AssetsRoom } from './Assets';
import { InsightsRoom } from './Insights';
import { PromptsRoom } from './Prompts';
import { MonitorRoom } from './Monitor';

export type RoomKey =
  | 'command'
  | 'calendar'
  | 'plan'
  | 'ideation'
  | 'studio'
  | 'gallery'
  | 'assets'
  | 'insights'
  | 'prompts'
  | 'monitor';

export interface RoomProps {
  onNavigate: (room: RoomKey) => void;
}

export const ROOM_META: Record<RoomKey, { title: string; subtitle: string }> = {
  command: { title: 'داشبورد فرماندهی', subtitle: 'وضعیت لحظه‌ای خط تولید محتوا' },
  calendar: { title: 'تقویم جلالی انتشار', subtitle: 'زمان‌بندی، تعویق و انتشار واقعی' },
  plan: { title: 'برنامه ۳ ماهه و دروازه تایید', subtitle: '۲۴ بلوک، الگوها و مسیر تولید' },
  ideation: { title: 'اتاق فکر', subtitle: 'از موضوع خام تا بسته محتوای آماده' },
  studio: { title: 'استودیو تدوین', subtitle: 'بوم لایه‌ای، صدای فارسی و رندر آفلاین' },
  gallery: { title: 'گالری خروجی‌ها', subtitle: 'ویدئو، کاروسل و کاور تولیدشده' },
  assets: { title: 'مخزن دارایی', subtitle: 'فایل‌ها، فونت‌ها و نمونه‌های صوتی' },
  insights: { title: 'داده و بینش', subtitle: 'قیف محتوا و شاخص‌های اندازه‌گیری‌شده' },
  prompts: { title: 'پرامپت‌های ایجنت', subtitle: 'شخصیت، لحن و قواعد تولید' },
  monitor: { title: 'نظارت و لاگ', subtitle: 'صف رندر، سهمیه مدل و رویدادها' },
};

export function RoomView({ room, onNavigate }: { room: RoomKey; onNavigate: (room: RoomKey) => void }) {
  switch (room) {
    case 'command':
      return <CommandRoom onNavigate={onNavigate} />;
    case 'calendar':
      return <CalendarRoom onNavigate={onNavigate} />;
    case 'plan':
      return <PlanRoom onNavigate={onNavigate} />;
    case 'ideation':
      return <IdeationRoom onNavigate={onNavigate} />;
    case 'studio':
      return <StudioRoom onNavigate={onNavigate} />;
    case 'gallery':
      return <GalleryRoom onNavigate={onNavigate} />;
    case 'assets':
      return <AssetsRoom onNavigate={onNavigate} />;
    case 'insights':
      return <InsightsRoom onNavigate={onNavigate} />;
    case 'prompts':
      return <PromptsRoom onNavigate={onNavigate} />;
    case 'monitor':
      return <MonitorRoom onNavigate={onNavigate} />;
    default:
      return <CommandRoom onNavigate={onNavigate} />;
  }
}
