import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import ConvertDialog from './ConvertDialog';
import type { ConvertDialogState } from './useConvertDialog';

/**
 * Regression guard for the convert contract. The /convert endpoint runs behind
 * a ValidationPipe with forbidNonWhitelisted, so the dialog must send ONLY the
 * fields ConvertLeadDto whitelists — a stray adminPassword/commissionAmount
 * makes EVERY conversion 400 (the bug this dialog once had). This test fails if
 * any non-whitelisted key is ever reintroduced into the submit payload.
 */
function makeState(over: Partial<ConvertDialogState> = {}): ConvertDialogState {
  return {
    isOpen: true,
    lead: {
      id: 'lead-1',
      businessName: 'Acme Co',
      email: 'admin@acme.com',
      contactPerson: 'Jane Doe',
    } as never,
    sentOffers: [],
    close: vi.fn(),
    ...over,
  } as ConvertDialogState;
}

describe('ConvertDialog payload contract', () => {
  it('submits ONLY the ConvertLeadDto-whitelisted fields (no adminPassword/commissionAmount)', async () => {
    const onSubmit = vi.fn();
    render(
      <ConvertDialog state={makeState()} fmtDate={(d) => String(d)} onSubmit={onSubmit} isPending={false} />,
    );

    // Fields prefill from the lead; just submit.
    await userEvent.click(screen.getByRole('button', { name: /^convert$/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    const keys = Object.keys(payload).sort();
    expect(keys).toEqual(['adminEmail', 'adminFirstName', 'adminLastName', 'tenantName']);
    expect(payload).not.toHaveProperty('adminPassword');
    expect(payload).not.toHaveProperty('commissionAmount');
  });

  it('renders no Admin Password / Commission Amount inputs', () => {
    render(
      <ConvertDialog state={makeState()} fmtDate={(d) => String(d)} onSubmit={vi.fn()} isPending={false} />,
    );
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByLabelText(/commission amount/i)).toBeNull();
  });
});
