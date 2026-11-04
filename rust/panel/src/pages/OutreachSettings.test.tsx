import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { delayed, mockFetch, renderAt } from '@/test/render';
import { LOADED, leadsManager, leadsMe, leadsRep, outreachSettings } from '@/test/leads';

function answers(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/auth/me': leadsMe,
    'GET /api/outreach/settings': outreachSettings,
    'PUT /api/outreach/settings': outreachSettings,
    ...extra,
  };
}

describe('OutreachSettings', () => {
  it('b2b_section_owner_only_with_ack', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers());
    const view = renderAt('/outreach/settings');
    const form = within(await screen.findByRole('form', { name: tr.leads.settings.b2b.title }, LOADED));
    expect(form.getByText(tr.leads.settings.b2b.legal)).toBeInTheDocument();
    const save = form.getByRole('button', { name: tr.leads.settings.b2b.save });
    await user.click(form.getByRole('checkbox', { name: tr.leads.settings.b2b.email }));
    // Opening the basis needs the counsel's confirmation and a note, in the same save.
    expect(save).toBeDisabled();
    await user.click(form.getByRole('checkbox', { name: tr.leads.settings.b2b.counsel }));
    expect(save).toBeDisabled();
    await user.type(form.getByRole('textbox', { name: tr.leads.settings.b2b.note }), 'Avukat onayı, 2026-11-04 tarihli görüş');
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        b2b_basis: ['email'],
        require_iys_lookup: true,
        legal_ack: { counsel_confirmed: true, note: 'Avukat onayı, 2026-11-04 tarihli görüş' },
      }),
    );
    view.unmount();

    // A manager is no owner: the section is not there (the server refuses it anyway).
    mockFetch(answers({ 'GET /api/auth/me': leadsManager }));
    const second = renderAt('/outreach/settings');
    await screen.findByRole('form', { name: tr.leads.settings.general }, LOADED);
    expect(screen.queryByRole('form', { name: tr.leads.settings.b2b.title })).not.toBeInTheDocument();
    second.unmount();

    mockFetch(answers({ 'GET /api/auth/me': leadsRep }));
    renderAt('/outreach/settings');
    expect(await screen.findByText(tr.leads.settings.readOnly, undefined, LOADED)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: tr.leads.settings.b2b.title })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tr.common.save })).not.toBeInTheDocument();
  });

  it('the_lock_is_said_while_the_platform_switch_is_off', async () => {
    mockFetch(answers({ 'GET /api/outreach/settings': { ...outreachSettings, platform_enabled: false } }));
    renderAt('/outreach/settings');
    expect(await screen.findByText(tr.leads.outreach.locked.title, undefined, LOADED)).toBeInTheDocument();
  });

  it('general_settings_save_once', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers({ 'PUT /api/outreach/settings': delayed(300, outreachSettings) }));
    renderAt('/outreach/settings');
    const formEl = await screen.findByRole('form', { name: tr.leads.settings.general }, LOADED);
    const form = within(formEl);
    await user.click(form.getByRole('checkbox', { name: tr.leads.settings.requiresApproval }));
    (formEl as HTMLFormElement).requestSubmit();
    (formEl as HTMLFormElement).requestSubmit();
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      requires_approval: true,
      sender_company: 'Alfa Atölye',
      warmup: { enabled: true, start: 20, step: 10, max: 150 },
      frequency: { min_gap_days: 3, max_per_30_days: 4 },
    });
  });
});
