import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BillingSummaryCards } from './BillingSummaryCards';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: unknown) =>
      (typeof d === 'string' ? d : (d as { defaultValue?: string })?.defaultValue) ?? _k,
  }),
}));

const spent = { used: 100, limit: 100, walletBalance: 0 };

function renderCards(isOwner: boolean) {
  render(
    <BillingSummaryCards
      sub={{ packageName: 'Jeeta', status: 'ACTIVE', packageCode: 'JEETA' }}
      ent={{}}
      usage={{ used: 0, limit: 10 }}
      aiUsage={spent}
      summaryLoading={false}
      isOwner={isOwner}
    />,
  );
}

describe('BillingSummaryCards — out-of-credits copy is role-aware', () => {
  it('tells an OWNER to add more below', () => {
    renderCards(true);
    expect(screen.getByText(/add more below/i)).toBeInTheDocument();
  });

  /**
   * The regression this pins: the card said "add more below" to everyone while
   * the boosts card holding those buys did not render for a non-owner, so the
   * instruction pointed at nothing. Even now that the card IS rendered, a
   * non-owner's Buy buttons are disabled — "add more below" is still an
   * instruction they cannot follow, so the word "below" must not reach them.
   */
  it('never tells a non-owner to act "below" — it names who can', () => {
    renderCards(false);
    expect(screen.getByText(/only the workspace owner can buy a pack/i)).toBeInTheDocument();
    expect(screen.queryByText(/below/i)).not.toBeInTheDocument();
  });

  it('names the owner in the running-low copy too', () => {
    render(
      <BillingSummaryCards
        sub={{ packageName: 'Jeeta', status: 'ACTIVE', packageCode: 'JEETA' }}
        ent={{}}
        usage={{ used: 0, limit: 10 }}
        aiUsage={{ used: 80, limit: 100, walletBalance: 0 }}
        summaryLoading={false}
        isOwner={false}
      />,
    );
    expect(screen.getByText(/ask the workspace owner to buy one of the packs/i)).toBeInTheDocument();
    expect(screen.queryByText(/top up below/i)).not.toBeInTheDocument();
  });
});
