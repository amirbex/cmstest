import React from 'react';
import { DashboardRoom } from './Dashboard';
import { CalendarRoom } from './Calendar';
import { ProductionRoom } from './Production';
import { EditorRoom } from './Editor';
import { TemplatesRoom } from './Templates';
import { AssetsRoom } from './Assets';
import { InsightsRoom } from './Insights';
import { IdeationRoom } from './Ideation';
import { PromptsRoom } from './Prompts';
import { MonitorRoom } from './Monitor';
import { SkillsRoom } from './Skills';

export type RoomKey =
  | 'command'
  | 'calendar'
  | 'production'
  | 'editor'
  | 'templates'
  | 'assets'
  | 'insights'
  | 'ideation'
  | 'prompts'
  | 'skills'
  | 'monitor';

export interface RoomProps {
  onNavigate: (room: RoomKey) => void;
}

export const ROOM_META: Record<RoomKey, { title: string; subtitle: string }> = {
  command: { title: 'داشبورد فرماندهی', subtitle: 'وضعیت هفته، آمادگی تولید و دادهٔ واقعی' },
  calendar: { title: 'تقویم انتشار', subtitle: 'کلیدهای زمان‌بندی، تعویق و ثبت انتشار' },
  production: { title: 'صف تولید', subtitle: 'از ایدهٔ پلن تا کانسپت زمان‌بندی‌شدهٔ قابل ویرایش' },
  editor: { title: 'استودیو تدوین', subtitle: 'بوم صحنه، تایم‌لاین و زیرنویس خودکار' },
  templates: { title: 'کتابخانهٔ قالب‌ها', subtitle: 'رسپی‌های حرکت و قالب‌های آمادهٔ رندر' },
  assets: { title: 'مخزن دارایی', subtitle: 'بارگذاری، فشرده‌سازی و ایندکس فایل‌ها' },
  insights: { title: 'داده و بینش', subtitle: 'آمار خام، شاخص‌های محاسبه‌شده و کیفیت انسانی' },
  ideation: { title: 'اتاق فکر', subtitle: 'از موضوع خام تا بستهٔ محتوای آماده' },
  prompts: { title: 'پرامپت‌های ایجنت', subtitle: 'شخصیت، لحن و قواعد تولید' },
  skills: { title: 'ایجنت‌ها و مهارت‌ها', subtitle: 'نقش‌ها، مهارت‌های تزریقی و پرامپت نهایی' },
  monitor: { title: 'نظارت و لاگ', subtitle: 'صف رندر، سهمیه مدل و رویدادها' },
};

export function RoomView({ room, onNavigate }: { room: RoomKey; onNavigate: (room: RoomKey) => void }) {
  switch (room) {
    case 'command':
      return <DashboardRoom onNavigate={onNavigate} />;
    case 'calendar':
      return <CalendarRoom onNavigate={onNavigate} />;
    case 'production':
      return <ProductionRoom onNavigate={onNavigate} />;
    case 'editor':
      return <EditorRoom onNavigate={onNavigate} />;
    case 'templates':
      return <TemplatesRoom onNavigate={onNavigate} />;
    case 'assets':
      return <AssetsRoom onNavigate={onNavigate} />;
    case 'insights':
      return <InsightsRoom onNavigate={onNavigate} />;
    case 'ideation':
      return <IdeationRoom onNavigate={onNavigate} />;
    case 'prompts':
      return <PromptsRoom onNavigate={onNavigate} />;
    case 'skills':
      return <SkillsRoom onNavigate={onNavigate} />;
    case 'monitor':
      return <MonitorRoom onNavigate={onNavigate} />;
    default:
      return <DashboardRoom onNavigate={onNavigate} />;
  }
}
