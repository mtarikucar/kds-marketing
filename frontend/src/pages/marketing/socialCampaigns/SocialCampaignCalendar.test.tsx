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
  caption: null, media: [], publishedAt: null,
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
    // The redesign shows a human-friendly status label, not the raw enum.
    expect(screen.getByText('To review')).toBeInTheDocument();
    expect(screen.getByText('Published')).toBeInTheDocument();
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
    expect(screen.getByRole('heading', { name: /Jul 1/ })).toBeInTheDocument();
    // The raw UTC calendar date must not leak into the grouping/header.
    expect(screen.queryByText('2026-07-02')).not.toBeInTheDocument();
    expect(screen.queryByText(/Jul 2/)).not.toBeInTheDocument();
  });

  it('renders an empty state when there are no items', () => {
    render(<SocialCampaignCalendar items={[]} />);
    expect(screen.getByText('No content scheduled yet')).toBeInTheDocument();
  });

  const media = (status: string) => [{ id: 'm', type: 'IMAGE', status, url: null, thumbnailUrl: null, mime: null }];

  it('warns about failed media on a publishable item, without a dead Regenerate on SCHEDULED', () => {
    render(
      <SocialCampaignCalendar
        items={[item({ id: 'a', status: 'SCHEDULED', topic: 'Promo', media: media('FAILED') })]}
        onRegenerate={vi.fn()}
      />,
    );
    // The image failed but the item still heads to publish → surface it.
    expect(screen.getByText(/without media/i)).toBeInTheDocument();
    // SCHEDULED is not regeneratable server-side, so no button that would 400.
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
  });

  it('offers Regenerate for failed media on a NEEDS_APPROVAL item', () => {
    render(
      <SocialCampaignCalendar
        items={[item({ id: 'a', status: 'NEEDS_APPROVAL', topic: 'Promo', media: media('BLOCKED') })]}
        onRegenerate={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
  });

  it('does not warn about failed media on an already-published item', () => {
    render(
      <SocialCampaignCalendar
        items={[item({ id: 'a', status: 'PUBLISHED', topic: 'Promo', media: media('FAILED') })]}
      />,
    );
    expect(screen.queryByText(/without media/i)).not.toBeInTheDocument();
  });
});
