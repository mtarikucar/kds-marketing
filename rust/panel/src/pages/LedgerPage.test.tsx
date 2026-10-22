import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import tr from '@/i18n/tr.json';
import { ledger, me } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

describe('LedgerPage', () => {
  it('lists the entries with their actor', async () => {
    const calls = mockFetch({ 'GET /api/auth/me': me, 'GET /api/ledger': ledger });
    renderAt('/ledger');
    expect(await screen.findByRole('heading', { level: 1, name: tr.ledger.title })).toBeInTheDocument();
    expect(await screen.findByText('team.invite')).toBeInTheDocument();
    expect(screen.getByText(tr.actor.human)).toBeInTheDocument();
    expect(screen.getByLabelText(tr.ledger.filter)).toBeInTheDocument();
    const ledgerCall = calls.find((c) => c.path === '/api/ledger');
    expect(ledgerCall?.search).toBe('?limit=50');
  });
});
