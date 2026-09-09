import { describe, it, expect } from 'vitest';
import { slotActions, slotDiff, toMinute, toLocalInput } from './SlotEditor';
import type { SlotView } from '../../../../features/marketing/api/contentProgramme.service';

const slot = (over: Partial<SlotView> = {}): SlotView => ({
  id: 's1',
  scheduledFor: '2026-09-12T15:30:00.000Z',
  status: 'PLANNED',
  contentTypeKey: 'howto',
  contentTypeName: 'Nasıl yapılır',
  selectionReason: 'seed',
  trendTitle: null,
  idea: 'Bir fikir',
  conceptId: null,
  campaignItemId: null,
  socialPostId: null,
  quotedCredits: null,
  spentCredits: 0,
  editableUntil: '2026-09-12T13:30:00.000Z',
  editable: true,
  publishedAt: null,
  reward: null,
  error: null,
  concept: null,
  ...over,
});

describe('slotDiff — minute precision', () => {
  it('a slot moved to hh:mm:15 through the API is not dirty on its own round-trip', () => {
    const s = slot({ scheduledFor: '2026-09-12T15:30:15.000Z' });
    const patch = slotDiff(s, { contentTypeKey: s.contentTypeKey, idea: s.idea, local: toLocalInput(s.scheduledFor) });
    expect(patch).toEqual({});
  });

  it('an idea-only edit does not ship scheduledFor for such a slot', () => {
    const s = slot({ scheduledFor: '2026-09-12T15:30:15.000Z' });
    const patch = slotDiff(s, { contentTypeKey: s.contentTypeKey, idea: 'Başka fikir', local: toLocalInput(s.scheduledFor) });
    expect(patch).toEqual({ idea: 'Başka fikir' });
  });

  it('a real minute change is sent, truncated to the minute', () => {
    const s = slot();
    const moved = new Date(s.scheduledFor);
    moved.setMinutes(moved.getMinutes() + 30);
    const patch = slotDiff(s, { contentTypeKey: s.contentTypeKey, idea: s.idea, local: toLocalInput(moved.toISOString()) });
    expect(patch.scheduledFor).toBe(toMinute(moved.toISOString()));
    expect(patch.scheduledFor).toMatch(/:00\.000Z$/);
  });

  it('toMinute drops seconds and milliseconds, and refuses garbage', () => {
    expect(toMinute('2026-09-12T15:30:15.250Z')).toBe('2026-09-12T15:30:00.000Z');
    expect(toMinute('not a date')).toBeNull();
  });
});

describe('slotActions — what the backend accepts', () => {
  it('regenerate needs clips: READY, or FAILED with a campaign item', () => {
    expect(slotActions({ status: 'READY', campaignItemId: 'ci' }).regenerate).toBe(true);
    expect(slotActions({ status: 'READY', campaignItemId: null }).regenerate).toBe(true);
    expect(slotActions({ status: 'FAILED', campaignItemId: 'ci' }).regenerate).toBe(true);
    expect(slotActions({ status: 'FAILED', campaignItemId: null }).regenerate).toBe(false);
    for (const status of ['PLANNED', 'IDEATED', 'PRODUCING', 'PUBLISHED', 'MEASURED', 'SKIPPED']) {
      expect(slotActions({ status, campaignItemId: 'ci' }).regenerate).toBe(false);
    }
  });

  it('skip is for PLANNED, IDEATED, READY and FAILED; retry only for FAILED', () => {
    for (const status of ['PLANNED', 'IDEATED', 'READY', 'FAILED']) {
      expect(slotActions({ status, campaignItemId: null }).skip).toBe(true);
    }
    for (const status of ['PRODUCING', 'PUBLISHED', 'MEASURED', 'SKIPPED']) {
      expect(slotActions({ status, campaignItemId: null }).skip).toBe(false);
      expect(slotActions({ status, campaignItemId: null }).retry).toBe(false);
    }
    expect(slotActions({ status: 'FAILED', campaignItemId: null }).retry).toBe(true);
    expect(slotActions({ status: 'READY', campaignItemId: 'ci' }).retry).toBe(false);
  });
});
