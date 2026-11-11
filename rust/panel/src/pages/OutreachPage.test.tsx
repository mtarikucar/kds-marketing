import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { mockFetch, renderAt } from '@/test/render';
import { CAMPAIGN_ID, LOADED, campaignRow, leadsMe, outreachSettings } from '@/test/leads';

describe('OutreachPage', () => {
  it('campaigns_with_status_and_the_lock', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': leadsMe,
      'GET /api/outreach/settings': { ...outreachSettings, platform_enabled: false },
      'GET /api/outreach/campaigns': {
        items: [campaignRow({ status: 'paused', pause_reason: 'bounce_rate', launched_at: '2026-11-04T09:00:00Z' })],
        next: null,
      },
    });
    renderAt('/outreach');
    const link = await screen.findByRole('link', { name: 'İzmir kafeleri tanışma' }, LOADED);
    expect(link).toHaveAttribute('href', `/outreach/${CAMPAIGN_ID}`);
    const row = link.closest('tr')!;
    expect(within(row).getByText(tr.leads.campaignStatus.paused)).toBeInTheDocument();
    expect(within(row).getByText(tr.leads.pauseReasons.bounce_rate)).toBeInTheDocument();
    expect(screen.getByText(tr.leads.outreach.locked.title)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: tr.leads.outreach.statusFilter }), 'running');
    await waitFor(() =>
      expect(new URLSearchParams(calls.filter((c) => c.path === '/api/outreach/campaigns').at(-1)!.search).get('status')).toBe(
        'running',
      ),
    );
  });

  it('clears an empty status filter and returns to the unfiltered campaigns', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': leadsMe,
      'GET /api/outreach/settings': outreachSettings,
      'GET /api/outreach/campaigns': { items: [], next: null },
    });
    renderAt('/outreach');
    await screen.findByText(tr.leads.outreach.empty, {}, LOADED);
    const status = screen.getByRole('combobox', { name: tr.leads.outreach.statusFilter });
    await user.selectOptions(status, 'running');
    const title = await screen.findByText(tr.leads.filteredEmpty.title);
    const empty = title.parentElement!.parentElement!;
    expect(within(empty).queryByRole('link', { name: tr.leads.outreach.newCampaign })).not.toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(calls.filter((c) => c.path === '/api/outreach/campaigns').at(-1)!.search).get('status')).toBe('running'));
    await user.click(within(empty).getByRole('button', { name: tr.leads.filteredEmpty.clear }));
    expect(status).toHaveValue('');
    await waitFor(() => expect(new URLSearchParams(calls.filter((c) => c.path === '/api/outreach/campaigns').at(-1)!.search).get('status')).toBeNull());
    expect(await screen.findByText(tr.leads.outreach.empty)).toBeInTheDocument();
  });

});
