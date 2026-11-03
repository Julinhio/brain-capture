import type { Capture } from './types.js';

export const PROJECT_STATES = ['idea', 'upcoming', 'active', 'completed'] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];
export const PROJECT_LABELS: Record<ProjectState, string> = {
  idea: 'Idée',
  upcoming: 'À venir',
  active: 'En cours',
  completed: 'Terminé',
};
export interface Project {
  id: string;
  name: string;
  intention: string;
  state: ProjectState;
  nextStep: string;
  createdAt: string;
  updatedAt: string;
  captureCount: number;
}
export interface Metric {
  key: string;
  label: string;
  value: number;
}
export interface RadarSummary {
  state: 'ready' | 'unconfigured' | 'error';
  checkedAt: string | null;
  url: string | null;
  total: number | null;
  new24h: number | null;
  segments: Metric[];
  extra: Metric[];
}
export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  busy: boolean;
  url: string | null;
  calendarId?: string;
  calendarName?: string;
  calendarColor?: string;
}
export interface CalendarSource {
  id: string;
  name: string;
  color: string;
  owned: boolean;
  selected: boolean;
  loadState: 'ready' | 'error' | 'off';
}
export interface CalendarDay {
  state: 'ready' | 'partial' | 'permission_required' | 'unconfigured' | 'disconnected' | 'error';
  checkedAt: string | null;
  events: CalendarEvent[];
  calendars?: CalendarSource[];
  missingCalendarCount?: number;
}
export interface DayWindow {
  date: string;
  previousDate: string;
  start: string;
  end: string;
  previousStart: string;
  timeZone: string;
}
export interface TodayData {
  window: DayWindow;
  yesterday: { count: number; captures: Capture[] };
  projects: Project[];
}
