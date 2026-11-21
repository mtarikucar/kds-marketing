import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { mockFetch, renderAt } from '@/test/render';
import { coreModules } from '@/test/modules';
import { LOADED, leadsManager, leadsMe, leadsRep, outreachSettings } from '@/test/leads';

const settings = {
  sender_company: outreachSettings.sender_company,
  sender_address: outreachSettings.sender_address,
  privacy_notice_url: outreachSettings.privacy_notice_url,
  b2b_basis: [],
  require_iys_lookup: true,
  legal_ack: null,
  sender_identity_complete: true,
  platform_enabled: true,
  b2b_channels_in_force: [],
};

function answers(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/auth/me': leadsMe,
    // Only the required modules: no campaigns, no inbox page.
    'GET /api/workspace/modules': coreModules,
    'GET /api/inbox/email-settings': settings,
    'PUT /api/inbox/email-settings': settings,
    ...extra,
  };
}

describe('EmailSettingsPage', () => {
  it('opens with no campaigns module and saves the sender details on the email side', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers());
    renderAt('/settings/email');
    const sender = within(await screen.findByRole('group', { name: tr.leads.settings.identity }, LOADED));
    expect(screen.queryByText('Bu modül çalışma alanına eklenmemiş')).not.toBeInTheDocument();
    const company = sender.getByRole('textbox', { name: tr.leads.settings.company });
    await user.clear(company);
    await user.type(company, 'Beta Atölye');
    await user.click(sender.getByRole('button', { name: tr.common.save }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      sender_company: 'Beta Atölye',
      sender_address: settings.sender_address,
      privacy_notice_url: settings.privacy_notice_url,
    }));
    expect(calls.find((c) => c.method === 'PUT')?.path).toBe('/api/inbox/email-settings');
    expect(calls.some((c) => c.path.startsWith('/api/outreach'))).toBe(false);
  });

  it('the business basis is the owner’s, with the lawyer confirmation in the same save', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers());
    const view = renderAt('/settings/email');
    const form = within(await screen.findByRole('form', { name: tr.leads.settings.b2b.title }, LOADED));
    expect(form.getByText(tr.leads.settings.b2b.legal)).toBeInTheDocument();
    const save = form.getByRole('button', { name: tr.leads.settings.b2b.save });
    await user.click(form.getByRole('checkbox', { name: tr.leads.settings.b2b.email }));
    expect(save).toBeDisabled();
    await user.click(form.getByRole('checkbox', { name: tr.leads.settings.b2b.counsel }));
    expect(save).toBeDisabled();
    await user.type(form.getByRole('textbox', { name: tr.leads.settings.b2b.note }), 'Avukat onayı');
    await user.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        b2b_basis: ['email'],
        require_iys_lookup: true,
        legal_ack: { counsel_confirmed: true, note: 'Avukat onayı' },
      }),
    );
    view.unmount();
    // A manager is no owner: no basis section (the server refuses it anyway).
    mockFetch(answers({ 'GET /api/auth/me': leadsManager }));
    const second = renderAt('/settings/email');
    await screen.findByRole('group', { name: tr.leads.settings.identity }, LOADED);
    expect(screen.queryByRole('form', { name: tr.leads.settings.b2b.title })).not.toBeInTheDocument();
    second.unmount();
  });

  it('whoever may write to people fills the sender details in, without any outreach permission', async () => {
    const user = userEvent.setup();
    const inboxOnly = { ...leadsRep, memberships: [{ ...leadsRep.memberships[0], permissions: ['workspace.read', 'inbox.work'] as typeof leadsRep.memberships[0]['permissions'] }] };
    const calls = mockFetch(answers({
      'GET /api/auth/me': inboxOnly,
      'GET /api/inbox/email-settings': { ...settings, sender_address: '', sender_identity_complete: false },
    }));
    renderAt('/settings/email');
    const sender = within(await screen.findByRole('group', { name: tr.leads.settings.identity }, LOADED));
    // A value already there is a manager's to change; the empty field is the member's to fill.
    expect(sender.getByRole('textbox', { name: tr.leads.settings.company })).toHaveAttribute('readonly');
    const address = sender.getByRole('textbox', { name: tr.leads.settings.address });
    expect(address).not.toHaveAttribute('readonly');
    await user.type(address, 'Deneme Sk. 2, İzmir');
    await user.click(sender.getByRole('button', { name: tr.common.save }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
    expect(screen.queryByRole('form', { name: tr.leads.settings.b2b.title })).not.toBeInTheDocument();
  });
});
