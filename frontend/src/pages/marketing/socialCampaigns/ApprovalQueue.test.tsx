import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k, i18n: { language: 'en' } }),
}));

import { ApprovalQueue } from './ApprovalQueue';
import type { SocialCampaignItem } from '../../../features/marketing/api/socialCampaigns.service';

const item = (over: Partial<SocialCampaignItem>): SocialCampaignItem => ({
  id: 'it', socialCampaignId: 'sc', sequenceIndex: 0, scheduledFor: '2026-07-01T09:00:00.000Z',
  status: 'NEEDS_APPROVAL', topic: 'Draft post', socialPostId: null, generatedAssetIds: [],
  caption: null, media: [], publishedAt: null,
  error: null, createdAt: '', updatedAt: '', ...over,
});

describe('ApprovalQueue', () => {
  it('lists only NEEDS_APPROVAL items and wires approve/reject/regenerate', async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    render(
      <ApprovalQueue
        items={[
          item({ id: 'a', topic: 'Needs review' }),
          item({ id: 'b', status: 'PUBLISHED', topic: 'Already out' }),
        ]}
        onReview={onReview}
      />,
    );
    expect(screen.getByText('Needs review')).toBeInTheDocument();
    expect(screen.queryByText('Already out')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onReview).toHaveBeenCalledWith('a', 'approve');
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReview).toHaveBeenCalledWith('a', 'reject');
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(onReview).toHaveBeenCalledWith('a', 'regenerate');
  });

  it('disables all of a row\'s buttons while that row action is pending', () => {
    render(
      <ApprovalQueue items={[item({ id: 'a', topic: 'Needs review' })]} onReview={vi.fn()} pendingId="a" />,
    );
    expect(screen.getByRole('button', { name: /Approve/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  });

  it('does not fire a second review once a row action is pending', async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    render(
      <ApprovalQueue items={[item({ id: 'a', topic: 'Needs review' })]} onReview={onReview} pendingId="a" />,
    );
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(onReview).not.toHaveBeenCalled();
  });

  it('shows an empty state when nothing needs approval', () => {
    render(<ApprovalQueue items={[item({ status: 'PUBLISHED' })]} onReview={vi.fn()} />);
    expect(screen.getByText('Nothing waiting for approval')).toBeInTheDocument();
  });

  const media = (status: string) => [{ id: 'm', type: 'IMAGE', status, url: null, thumbnailUrl: null, mime: null }];

  it('disables Approve and surfaces a hint when the creative failed', () => {
    render(<ApprovalQueue items={[item({ id: 'a', media: media('FAILED') })]} onReview={vi.fn()} />);
    expect(screen.getByText(/Image failed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve/ })).toBeDisabled();
  });

  it('shows a preparing hint while the media is still generating', () => {
    render(<ApprovalQueue items={[item({ id: 'a', media: media('GENERATING') })]} onReview={vi.fn()} />);
    expect(screen.getByText(/Preparing the image/i)).toBeInTheDocument();
  });

  it('spins the pending action button, not always Approve', () => {
    render(
      <ApprovalQueue items={[item({ id: 'a' })]} onReview={vi.fn()} pendingId="a" pendingAction="regenerate" />,
    );
    expect(screen.getByRole('button', { name: /Regenerate/ })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: /Approve/ })).not.toHaveAttribute('aria-busy', 'true');
  });
});
