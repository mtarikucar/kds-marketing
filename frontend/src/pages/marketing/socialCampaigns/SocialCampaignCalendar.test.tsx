import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('renders an empty state when there are no items', () => {
    render(<SocialCampaignCalendar items={[]} />);
    expect(screen.getByText('No content scheduled yet')).toBeInTheDocument();
  });
});
