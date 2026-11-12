import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { delayed, mockFetch, renderAt, withStatus } from '@/test/render';
import {
  CAMPAIGN_ID,
  LOADED,
  MAILBOX_ID,
  agentsList,
  campaignOut,
  leadsMe,
  leadsRep,
  mailbox,
  outreachSettings,
  team,
  template,
} from '@/test/leads';

function answers(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/auth/me': leadsMe,
    'GET /api/agents': agentsList,
    'GET /api/team': team,
    'GET /api/outreach/settings': outreachSettings,
    'GET /api/outreach/templates': { items: [template(1)], next: null },
    'GET /api/capabilities': [mailbox],
    [`GET /api/outreach/campaigns/${CAMPAIGN_ID}`]: campaignOut(),
    [`GET /api/outreach/campaigns/${CAMPAIGN_ID}/enrollments`]: { items: [], next: null },
    'GET /api/outreach/campaigns': { items: [], next: null },
    ...extra,
  };
}

function enrollment(n: number) {
  return {
    id: `0190a000-0000-7000-8000-0000000008${String(n).padStart(2, '0')}`,
    campaign_id: CAMPAIGN_ID,
    person_id: `0190a000-0000-7000-8000-0000000009${String(n).padStart(2, '0')}`,
    journey_id: null,
    prospect_id: null,
    status: 'active',
    stop: null,
    skip: null,
    next_step: 1,
    next_send_at: '2026-11-05T07:00:00Z',
    personalization: {},
    basis: 'business_recipient',
    enrolled_at: '2026-11-04T09:00:00Z',
    stopped_at: null,
    last_sent_at: null,
  };
}

describe('OutreachCampaign', () => {
  it('deliverability_warning_shown', async () => {
    mockFetch(answers());
    renderAt('/outreach/new');
    expect(await screen.findByText(tr.leads.campaign.deliverability.title, undefined, LOADED)).toBeInTheDocument();
    expect(screen.getByText(tr.leads.campaign.deliverability.body)).toBeInTheDocument();
    expect(tr.leads.campaign.deliverability.body).toMatch(/SPF.*DKIM.*DMARC/);
  });

  it('audience_preview_skip_reasons', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      answers({
        'POST /api/outreach/audience-preview': {
          eligible: 12,
          by_skip_reason: { no_deliverable_email: 3, no_basis: 2 },
          basis: { consent: 4, business_recipient: 8 },
          promotions_needed: 5,
          business_basis_in_force: true,
          truncated: false,
        },
      }),
    );
    renderAt('/outreach/new');
    const form = within(await screen.findByRole('form', { name: tr.leads.campaign.editor }, LOADED));
    expect(form.getByText(tr.leads.campaign.preview.chooseMailbox)).toBeInTheDocument();
    await form.findByRole('option', { name: 'Satış posta kutusu' }, LOADED);
    await user.selectOptions(form.getByRole('combobox', { name: tr.leads.campaign.mailbox }), MAILBOX_ID);
    await user.type(form.getByRole('textbox', { name: tr.leads.campaign.cities }), 'İzmir');
    const preview = within(await screen.findByRole('region', { name: tr.leads.campaign.preview.title }, LOADED));
    expect(await preview.findByText('Uygun alıcı: 12', undefined, LOADED)).toBeInTheDocument();
    const skipped = within(preview.getByRole('list', { name: tr.leads.campaign.preview.skipped }));
    expect(skipped.getByText('Teslim edilebilir e-postası yok: 3')).toBeInTheDocument();
    expect(skipped.getByText('Ticari ileti dayanağı yok: 2')).toBeInTheDocument();
    expect(preview.getByText('Önce gelen kutusuna aktarılacak aday: 5')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/api/outreach/audience-preview').at(-1)?.body).toEqual({
        audience: {
          people: null,
          prospects: { segment_keys: [], research_task_ids: [], cities: ['İzmir'], sectors: [], min_score: null },
          explicit: [],
        },
        mailbox_id: MAILBOX_ID,
      }),
    );
  });

  it('launch_blocked_reasons_shown', async () => {
    const locked = { ...outreachSettings, platform_enabled: false, sender_identity_complete: false };
    const first = mockFetch(answers({ 'GET /api/outreach/settings': locked }));
    const view = renderAt(`/outreach/${CAMPAIGN_ID}`);
    const blockers = await screen.findByRole('list', { name: tr.leads.campaign.blockedTitle }, LOADED);
    expect(within(blockers).getByText(tr.leads.outreach.blocked.platform)).toBeInTheDocument();
    expect(within(blockers).getByText(tr.leads.outreach.blocked.identity)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr.leads.campaign.launch })).toBeDisabled();
    expect(first.some((c) => c.path.endsWith('/launch'))).toBe(false);
    view.unmount();

    // Open here, the server may still refuse: its reason is shown in the panel's words.
    const user = userEvent.setup();
    const calls = mockFetch(
      answers({
        [`POST /api/outreach/campaigns/${CAMPAIGN_ID}/launch`]: withStatus(403, {
          code: 'FORBIDDEN',
          message: 'outreach refused',
          details: { reason: 'outreach_disabled_on_platform' },
        }),
      }),
    );
    renderAt(`/outreach/${CAMPAIGN_ID}`);
    const launch = await screen.findByRole('button', { name: tr.leads.campaign.launch }, LOADED);
    expect(screen.queryByRole('list', { name: tr.leads.campaign.blockedTitle })).not.toBeInTheDocument();
    await user.click(launch);
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/launch'))?.body).toEqual({ expected_revision: 2 }),
    );
    expect(await screen.findByText(tr.leads.errors.outreach_disabled_on_platform, undefined, LOADED)).toBeInTheDocument();
  });

  it('approval_card_for_managers_only', async () => {
    const waiting = campaignOut({ status: 'awaiting_approval' }, { approval_required: true });
    const user = userEvent.setup();
    const calls = mockFetch(
      answers({
        [`GET /api/outreach/campaigns/${CAMPAIGN_ID}`]: waiting,
        [`POST /api/outreach/campaigns/${CAMPAIGN_ID}/approve`]: campaignOut({ status: 'running' }),
      }),
    );
    const view = renderAt(`/outreach/${CAMPAIGN_ID}`);
    expect(await screen.findByText(tr.leads.campaign.approval.title, undefined, LOADED)).toBeInTheDocument();
    expect(await screen.findByText(/arastirma-ajani/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Onayla (sürüm 2)' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/approve'))?.body).toEqual({ expected_revision: 2 }),
    );
    view.unmount();

    mockFetch(answers({ 'GET /api/auth/me': leadsRep, [`GET /api/outreach/campaigns/${CAMPAIGN_ID}`]: waiting }));
    renderAt(`/outreach/${CAMPAIGN_ID}`);
    expect(await screen.findByText(tr.leads.campaign.approval.waiting, undefined, LOADED)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Onayla (sürüm 2)' })).not.toBeInTheDocument();
  });

  it('enrollment_stop_per_row', async () => {
    const user = userEvent.setup();
    const [a, b] = [enrollment(1), enrollment(2)];
    const calls = mockFetch(
      answers({
        [`GET /api/outreach/campaigns/${CAMPAIGN_ID}`]: campaignOut({ status: 'running', launched_at: '2026-11-04T09:00:00Z' }, { active_enrollments: 2 }),
        [`GET /api/outreach/campaigns/${CAMPAIGN_ID}/enrollments`]: { items: [a, b], next: null },
        [`POST /api/outreach/enrollments/${a.id}/stop`]: delayed(500, { ...a, status: 'stopped', stop: 'manual' }),
      }),
    );
    renderAt(`/outreach/${CAMPAIGN_ID}`);
    const [first, second] = await screen.findAllByTestId('enrollment', undefined, LOADED);
    const stopFirst = within(first).getByRole('button', { name: tr.leads.enrollments.stop });
    const stopSecond = within(second).getByRole('button', { name: tr.leads.enrollments.stop });
    await user.click(stopFirst);
    await waitFor(() => expect(stopFirst).toBeDisabled());
    expect(stopSecond).toBeEnabled();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([`/api/outreach/enrollments/${a.id}/stop`]);
    expect(within(first).getByText(tr.leads.basis.business_recipient)).toBeInTheDocument();
  });

  it('a_new_campaign_is_saved_with_its_steps_and_one_request_key', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      answers({
        'POST /api/outreach/audience-preview': {
          eligible: 0,
          by_skip_reason: {},
          basis: { consent: 0, business_recipient: 0 },
          promotions_needed: 0,
          business_basis_in_force: false,
          truncated: false,
        },
        'POST /api/outreach/campaigns': delayed(300, campaignOut()),
      }),
    );
    const { router } = renderAt('/outreach/new');
    const formEl = await screen.findByRole('form', { name: tr.leads.campaign.editor }, LOADED);
    const form = within(formEl);
    await user.type(form.getByRole('textbox', { name: tr.leads.campaign.name }), 'Kasım kafeleri');
    await form.findByRole('option', { name: 'Satış posta kutusu' }, LOADED);
    await user.selectOptions(form.getByRole('combobox', { name: tr.leads.campaign.mailbox }), MAILBOX_ID);
    await user.click(form.getByRole('button', { name: tr.leads.campaign.addStep }));
    await form.findByRole('option', { name: 'Tanışma 1' }, LOADED);
    await user.selectOptions(form.getByRole('combobox', { name: '1. adımın şablonu' }), template(1).template.id);
    (formEl as HTMLFormElement).requestSubmit();
    (formEl as HTMLFormElement).requestSubmit();
    await waitFor(() => expect(router.state.location.pathname).toBe(`/outreach/${CAMPAIGN_ID}`));
    const saves = calls.filter((c) => c.method === 'POST' && c.path === '/api/outreach/campaigns');
    expect(saves).toHaveLength(1);
    expect(saves[0].body).toMatchObject({
      name: 'Kasım kafeleri',
      mailbox_id: MAILBOX_ID,
      definition: {
        sender_name: leadsMe.display_name,
        steps: [{ template_id: template(1).template.id, delay_days: 0, same_thread: false }],
        throttle: { per_hour: 10, per_day: 50 },
        click_tracking: false,
        evergreen: false,
      },
    });
    expect(typeof (saves[0].body as { request_key: unknown }).request_key).toBe('string');
  });
});
