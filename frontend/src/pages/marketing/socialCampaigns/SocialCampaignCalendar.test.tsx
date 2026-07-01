import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
// Force a fixed non-UTC zone so the local vs UTC day boundary is deterministic.
vi.stubEnv('TZ', 'America/New_York');
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k, i18n: { language: 'en' } }),
}));

import { SocialCampaignCalendar } from './SocialCampaignCalendar';
import type { SocialCampaignItem } from '../../../features/marketing/api/socialCampaigns.service';

const item = (over: Partial<SocialCampaignItem>): SocialCampaignItem => ({
  id: 'it', socialCampaignId: 'sc', sequenceIndex: 0, scheduledFor: '2026-07-01T09:00:00.000Z',
  status: 'PLANNED', topic: null, socialPostId: null, generatedAssetIds: [], error: null,
  createdAt: '', updatedAt: '', ...over,
});

describe('SocialCampaignCalendar', () => {
  it('groups items by day and shows topic + status', () => {
    render(
      <SocialCampaignCalendar
        items={[
          item({ id: 'a', topic: 'Summer sale', status: 'NEEDS_APPROVAL', scheduledFor: '2026-07-01T09:00:00.000Z' }),
          item({ id: 'b', topic: 'Customer story', status: 'PUBLISHED', scheduledFor: '2026-07-03T09:00:00.000Z' }),
        ]}
      />,
    );
    expect(screen.getByText('Summer sale')).toBeInTheDocument();
    expect(screen.getByText('Customer story')).toBeInTheDocument();
    expect(screen.getByText('NEEDS_APPROVAL')).toBeInTheDocument();
    expect(screen.getByText('PUBLISHED')).toBeInTheDocument();
  });

  it('buckets items by the viewer local day, not the UTC day', () => {
    // In America/New_York (UTC-4 in July) 02:00Z on Jul 2 is 22:00 on Jul 1 local,
    // so both items belong to the same local day (Jul 1) despite differing UTC dates.
    render(
      <SocialCampaignCalendar
        items={[
          item({ id: 'a', topic: 'Late night', scheduledFor: '2026-07-02T02:00:00.000Z' }),
          item({ id: 'b', topic: 'Same day noon', scheduledFor: '2026-07-01T16:00:00.000Z' }),
        ]}
      />,
    );
    // One localized local-day header, both posts grouped under it.
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Jul 1, 2026' })).toBeInTheDocument();
    // The raw UTC calendar date must not leak into the grouping/header.
    expect(screen.queryByText('2026-07-02')).not.toBeInTheDocument();
    expect(screen.queryByText('Jul 2, 2026')).not.toBeInTheDocument();
  });

  it('renders an empty state when there are no items', () => {
    render(<SocialCampaignCalendar items={[]} />);
    expect(screen.getByText('No content scheduled yet')).toBeInTheDocument();
  });
});
