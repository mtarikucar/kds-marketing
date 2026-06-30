import { describe, it, expect } from 'vitest';
import en from './locales/en/marketing.json';
import tr from './locales/tr/marketing.json';

const REQUIRED = [
  'title', 'subtitle', 'new', 'newTitle', 'emptyTitle', 'emptyBody',
  'step.goal', 'step.brief', 'step.channels', 'step.automation', 'step.planning', 'step.review',
  'create', 'created', 'createFailed',
  'approve', 'reject', 'regenerate', 'queueEmpty', 'calendarEmpty',
  'tabCalendar', 'tabQueue', 'activate', 'pause', 'resume',
  'crossLink', 'provisioned', 'provisionFailed',
];

function get(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}

describe('socialCampaign i18n', () => {
  it('en + tr both define every required socialCampaign key', () => {
    for (const k of REQUIRED) {
      expect(get((en as Record<string, unknown>).socialCampaign as Record<string, unknown>, k), `en socialCampaign.${k}`).toBeTruthy();
      expect(get((tr as Record<string, unknown>).socialCampaign as Record<string, unknown>, k), `tr socialCampaign.${k}`).toBeTruthy();
    }
  });

  it('both locales define nav.socialCampaigns', () => {
    expect(((en as Record<string, unknown>).nav as Record<string, unknown>).socialCampaigns).toBeTruthy();
    expect(((tr as Record<string, unknown>).nav as Record<string, unknown>).socialCampaigns).toBeTruthy();
  });
});
