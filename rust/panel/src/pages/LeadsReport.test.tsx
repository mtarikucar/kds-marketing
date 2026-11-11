import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { formatMoney } from '@/lib/format';
import { mockFetch, renderAt } from '@/test/render';
import { CAMPAIGN_ID, LOADED, campaignOut, campaignRow, leadsMe, outreachSettings, template } from '@/test/leads';

const pool = {
  rejected_retention_days: 30,
  unpromoted_retention_days: 180,
  rejected_memory_days: 365,
  max_promotions_per_day: 100,
  agents_promote_qualified_only: true,
};

function group(key: string | null, extra: Record<string, unknown> = {}) {
  return {
    key,
    created: 10,
    scored: 8,
    qualified: 5,
    rejected: { not_icp: 2 },
    promoted: 4,
    contacted: 3,
    replied: 2,
    meetings: 1,
    quoted: 1,
    won: 1,
    lost: {},
    won_revenue: {},
    rates: { promoted_to_replied: 0.5, replied_to_meeting: 0.5, meeting_to_won: 1 },
    ...extra,
  };
}

const outreachGroup = {
  campaign_id: CAMPAIGN_ID,
  step: null,
  template_id: null,
  enrolled: 40,
  skipped: { no_basis: 3 },
  sent: 38,
  unknown: 0,
  failed: 1,
  refused: 1,
  bounced: 2,
  complained: 0,
  replied: 5,
  replied_threaded: 4,
  replied_unthreaded: 1,
  unsubscribed: 1,
  unique_clicks: null,
  automated_clicks: 0,
  meetings_30d: 2,
  won_30d: 1,
  stopped: { replied: 5 },
};

function answers(tz = 'Europe/Istanbul', extra: Record<string, unknown> = {}) {
  return {
    'GET /api/auth/me': leadsMe,
    'GET /api/prospects/settings': { ...pool, timezone: tz },
    'GET /api/prospects/report': {
      from: '2026-10-31T21:00:00Z',
      to: '2026-11-30T21:00:00Z',
      group_by: 'source',
      groups: [group('research_task'), group(null, { created: 2 })],
      truncated: false,
    },
    'GET /api/outreach/report': {
      from: '2026-10-31T21:00:00Z',
      to: '2026-11-30T21:00:00Z',
      campaign_id: null,
      group_by: 'campaign',
      groups: [outreachGroup],
      truncated: false,
    },
    'GET /api/outreach/campaigns': { items: [campaignRow()], next: null },
    'GET /api/outreach/templates': { items: [template(1)], next: null },
    ...extra,
  };
}

const last = (calls: { path: string; search: string }[], path: string) =>
  new URLSearchParams(calls.filter((c) => c.path === path).at(-1)!.search);

async function setRange(first: string, lastDay: string) {
  fireEvent.change(screen.getByLabelText(tr.leads.report.fromDay), { target: { value: first } });
  fireEvent.change(screen.getByLabelText(tr.leads.report.toDay), { target: { value: lastDay } });
}

describe('LeadsReport', () => {
  it('grouping_selector', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers());
    renderAt('/prospects/report');
    const pool = within(await screen.findByRole('region', { name: tr.leads.report.pool.title }, LOADED));
    expect(await pool.findByText(tr.leads.originVia.research_task, undefined, LOADED)).toBeInTheDocument();
    expect(pool.getByText(tr.leads.report.none)).toBeInTheDocument();
    await user.selectOptions(pool.getByRole('combobox', { name: tr.leads.report.groupBy }), 'city');
    await waitFor(() => expect(last(calls, '/api/prospects/report').get('group_by')).toBe('city'));
    const outreach = within(screen.getByRole('region', { name: tr.leads.report.outreach.title }));
    expect(await outreach.findByText('İzmir kafeleri tanışma', undefined, LOADED)).toBeInTheDocument();
    await user.selectOptions(outreach.getByRole('combobox', { name: tr.leads.report.groupBy }), 'template');
    await waitFor(() => expect(last(calls, '/api/outreach/report').get('group_by')).toBe('template'));
  });

  it('local_day_ranges_sent_as_instants', async () => {
    const calls = mockFetch(answers('Europe/Istanbul'));
    const view = renderAt('/prospects/report');
    await screen.findByRole('region', { name: tr.leads.report.pool.title }, LOADED);
    await setRange('2026-11-01', '2026-11-30');
    await waitFor(() => {
      const q = last(calls, '/api/prospects/report');
      expect(q.get('from')).toBe('2026-10-31T21:00:00.000Z');
      expect(q.get('to')).toBe('2026-11-30T21:00:00.000Z');
    });
    view.unmount();

    // A third zone, whose clock changes inside the range: each end is that day's own midnight.
    const ny = mockFetch(answers('America/New_York'));
    renderAt('/prospects/report');
    await screen.findByRole('region', { name: tr.leads.report.pool.title }, LOADED);
    await setRange('2026-11-01', '2026-11-30');
    await waitFor(() => {
      const q = last(ny, '/api/outreach/report');
      expect(q.get('from')).toBe('2026-11-01T04:00:00.000Z');
      expect(q.get('to')).toBe('2026-12-01T05:00:00.000Z');
    });
    expect(screen.getByText(/America\/New_York/)).toBeInTheDocument();
  });

  it('revenue_per_currency_never_summed', async () => {
    mockFetch(
      answers('Europe/Istanbul', {
        'GET /api/prospects/report': {
          from: '2026-10-31T21:00:00Z',
          to: '2026-11-30T21:00:00Z',
          group_by: 'source',
          groups: [group('agent', { won_revenue: { TRY: 120000, EUR: 30000 } })],
          truncated: false,
        },
      }),
    );
    renderAt('/prospects/report');
    const revenue = await screen.findByTestId('revenue', undefined, LOADED);
    const items = within(revenue).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([formatMoney(30000, 'EUR', 'tr'), formatMoney(120000, 'TRY', 'tr')]);
    expect(screen.queryByText(formatMoney(150000, 'TRY', 'tr'))).not.toBeInTheDocument();
  });

  it('the_campaign_report_tab_asks_for_its_campaign', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      ...answers(),
      'GET /api/outreach/settings': outreachSettings,
      'GET /api/capabilities': [],
      [`GET /api/outreach/campaigns/${CAMPAIGN_ID}`]: campaignOut({ status: 'running' }),
      [`GET /api/outreach/campaigns/${CAMPAIGN_ID}/enrollments`]: { items: [], next: null },
    });
    renderAt(`/outreach/${CAMPAIGN_ID}`);
    await user.click(await screen.findByRole('button', { name: new RegExp(tr.leads.report.campaignTab) }, LOADED));
    await waitFor(() => {
      const q = last(calls, '/api/outreach/report');
      expect(q.get('campaign_id')).toBe(CAMPAIGN_ID);
      expect(q.get('group_by')).toBe('step');
    });
  });
});
