import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import OffersTab from './OffersTab';
import type { LeadOffer } from '../../../features/marketing/types';

/**
 * OffersTab regression guards:
 *  - the price/discount/trial cells used the `{value && <JSX>}` idiom; since
 *    trialDays is an Int, a value of 0 rendered a stray literal "0" into the
 *    card instead of hiding the cell.
 *  - sending an offer transmits a price quote to the customer (irreversible),
 *    so it must be confirmed.
 */
const offer = (over: Partial<LeadOffer> = {}): LeadOffer =>
  ({
    id: 'o1',
    status: 'SENT',
    customPrice: null,
    discount: null,
    trialDays: null,
    validUntil: null,
    notes: null,
    createdAt: '2026-06-01',
    ...over,
  }) as unknown as LeadOffer;

function renderTab(offers: LeadOffer[], props: Record<string, unknown> = {}) {
  return render(
    <OffersTab
      leadId="lead-1"
      offers={offers}
      converted={false}
      fmtDate={() => 'Jun one'}
      onCreate={() => undefined}
      createPending={false}
      onSend={vi.fn()}
      onDelete={vi.fn()}
      {...props}
    />,
  );
}

describe('OffersTab — zero-value rendering', () => {
  it('does not leak a stray "0" when trialDays is 0', () => {
    const { container } = renderTab([offer({ trialDays: 0 })]);
    // The price/discount/trial grid must be empty, not contain a bare "0".
    const grid = container.querySelector('.grid');
    expect(grid?.textContent).toBe('');
    expect(screen.queryByText('0', { exact: true })).not.toBeInTheDocument();
  });

  it('shows the trial only when trialDays > 0', () => {
    renderTab([offer({ trialDays: 14 })]);
    expect(screen.getByText(/14 days/)).toBeInTheDocument();
  });
});

describe('OffersTab — send confirmation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not send the offer when the confirmation is dismissed', async () => {
    const onSend = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderTab([offer({ status: 'DRAFT' })], { onSend });

    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends the offer when the confirmation is accepted', async () => {
    const onSend = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderTab([offer({ status: 'DRAFT' })], { onSend });

    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(onSend).toHaveBeenCalledWith('o1');
  });
});
