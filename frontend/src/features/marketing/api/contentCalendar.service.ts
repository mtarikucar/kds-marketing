/** contentCalendar.service.ts — unified content calendar (Faz 4). */
import marketingApi from './marketingApi';

export type CalendarItemType = 'SOCIAL_POST' | 'CAMPAIGN_ITEM';

export interface CalendarItem {
  type: CalendarItemType;
  id: string;
  title: string;
  scheduledAt: string;
  status: string;
}

export const listContentCalendar = (from?: string, to?: string) =>
  marketingApi
    .get<CalendarItem[]>('/content-calendar', { params: { ...(from ? { from } : {}), ...(to ? { to } : {}) } })
    .then((r) => r.data);
