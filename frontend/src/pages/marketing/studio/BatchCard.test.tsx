import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { BatchCard } from './BatchCard';
import type { BatchSummary } from '../../../features/marketing/api/contentLine.service';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: string | Record<string, unknown>, o?: Record<string, unknown>) => {
      const def = typeof d === 'string' ? d : '';
      const vars = (typeof d === 'string' ? o : (d as Record<string, unknown>)) ?? {};
      return def.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k] ?? ''));
    },
    i18n: { language: 'tr' },
  }),
}));

const batch = (over: Partial<BatchSummary> = {}): BatchSummary => ({
  batchId: 'b1',
  sourceIdea: 'Theo Jansen Strandbeest — rüzgarla yürüyen kinetik heykel.',
  createdAt: '2026-09-01T10:00:00.000Z',
  concepts: { total: 5, awaitingReview: 0, approved: 0, discarded: 0 },
  production: { generating: 0, needsApproval: 0, scheduled: 0, published: 0, failed: 0 },
  reach: null,
  ...over,
});

const draw = (b: BatchSummary, onOpen = vi.fn()) => {
  render(
    <MemoryRouter>
      <ul>
        <BatchCard batch={b} onOpen={onOpen} />
      </ul>
    </MemoryRouter>,
  );
  return onOpen;
};

describe('BatchCard', () => {
  it('shows the idea verbatim, so a reviewer judges the batch against what was asked', () => {
    draw(batch());
    expect(screen.getByText(/Theo Jansen Strandbeest/)).toBeInTheDocument();
    expect(screen.getByText(/5 konsept/)).toBeInTheDocument();
  });

  it('says NOT PUBLISHED rather than printing zero reach', () => {
    // Zero is a measurement. On unpublished work it reports a failure that has
    // not happened yet.
    draw(batch({ reach: null }));

    expect(screen.getByText('yayınlanmadı')).toBeInTheDocument();
    expect(screen.queryByText(/0 erişim/)).not.toBeInTheDocument();
  });

  it('prints reach once the batch has actually published', () => {
    draw(
      batch({
        reach: 12_400,
        production: { generating: 0, needsApproval: 0, scheduled: 0, published: 3, failed: 0 },
      }),
    );

    expect(screen.getByText(/erişim/)).toBeInTheDocument();
    expect(screen.getByText('3 yayında')).toBeInTheDocument();
    expect(screen.queryByText('yayınlanmadı')).not.toBeInTheDocument();
  });

  it('distinguishes zero reach from unmeasured once something IS published', () => {
    // A published post genuinely nobody saw. This one SHOULD read as zero.
    draw(
      batch({
        reach: 0,
        production: { generating: 0, needsApproval: 0, scheduled: 0, published: 1, failed: 0 },
      }),
    );

    expect(screen.getByText('0 erişim')).toBeInTheDocument();
    expect(screen.queryByText('yayınlanmadı')).not.toBeInTheDocument();
  });

  it('surfaces what is waiting on a person', () => {
    draw(
      batch({
        concepts: { total: 5, awaitingReview: 2, approved: 3, discarded: 0 },
        production: { generating: 1, needsApproval: 1, scheduled: 1, published: 0, failed: 0 },
      }),
    );

    expect(screen.getByText('2 onay bekliyor')).toBeInTheDocument();
    expect(screen.getByText('1 yayın onayı bekliyor')).toBeInTheDocument();
    expect(screen.getByText('1 üretimde')).toBeInTheDocument();
  });

  it('branches to the campaign surface instead of re-rendering it', async () => {
    draw(
      batch({
        production: { generating: 2, needsApproval: 0, scheduled: 0, published: 0, failed: 0 },
      }),
    );

    const link = screen.getByRole('link', { name: /Üretimi kampanyalarda aç/ });
    expect(link).toHaveAttribute('href', '/social-campaigns');
  });

  it('opens the batch when the card is activated', async () => {
    const onOpen = draw(batch());
    await userEvent.click(screen.getByText(/Theo Jansen Strandbeest/));
    expect(onOpen).toHaveBeenCalledWith('b1');
  });
});
