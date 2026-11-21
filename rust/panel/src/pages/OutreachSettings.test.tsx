import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { delayed, mockFetch, renderAt } from '@/test/render';
import { legacyModules } from '@/test/modules';
import { LOADED, leadsMe, leadsRep, outreachSettings } from '@/test/leads';

function answers(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/auth/me': leadsMe,
    'GET /api/outreach/settings': outreachSettings,
    'PUT /api/outreach/settings': outreachSettings,
    ...extra,
  };
}

describe('OutreachSettings', () => {
  it('holds only what the campaigns use, and points at the email settings for the rest', async () => {
    mockFetch(answers());
    renderAt('/outreach/settings');
    const form = within(await screen.findByRole('form', { name: tr.leads.settings.general }, LOADED));
    expect(screen.getByRole('heading', { name: tr.leads.settings.campaignTitle })).toBeInTheDocument();
    expect(form.getByRole('checkbox', { name: tr.leads.settings.requiresApproval })).toBeInTheDocument();
    // The sender details and the business basis are email's, not the campaigns'.
    expect(form.queryByRole('textbox', { name: tr.leads.settings.company })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: tr.leads.settings.b2b.title })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: tr.email.senderLink })).toHaveAttribute('href', '/settings/email');
  });

  it('the_lock_is_said_while_the_platform_switch_is_off', async () => {
    mockFetch(answers({ 'GET /api/outreach/settings': { ...outreachSettings, platform_enabled: false } }));
    renderAt('/outreach/settings');
    expect(await screen.findByText(tr.leads.outreach.locked.title, undefined, LOADED)).toBeInTheDocument();
  });

  it('a member without outreach.manage reads them only', async () => {
    mockFetch(answers({ 'GET /api/auth/me': leadsRep }));
    renderAt('/outreach/settings');
    expect(await screen.findByText(tr.leads.settings.readOnly, undefined, LOADED)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tr.common.save })).not.toBeInTheDocument();
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
    const body = calls.find((c) => c.method === 'PUT')?.body as Record<string, unknown>;
    expect(body).toEqual({
      requires_approval: true,
      click_tracking_default: false,
      warmup: { enabled: true, start: 20, step: 10, max: 150 },
      frequency: { min_gap_days: 3, max_per_30_days: 4 },
    });
  });

  it('the campaign pages, their settings included, still need the module', async () => {
    const withoutCampaigns = {
      ...legacyModules,
      modules: legacyModules.modules.map((m) => ({ ...m, installed: m.blueprint.id !== 'outreach' })),
    };
    for (const path of ['/outreach', '/outreach/new', '/outreach/templates', '/outreach/settings']) {
      mockFetch(answers({ 'GET /api/workspace/modules': withoutCampaigns, 'GET /api/outreach/campaigns': { items: [], next: null } }));
      const view = renderAt(path);
      expect(await screen.findByText('Bu modül çalışma alanına eklenmemiş', undefined, LOADED)).toBeInTheDocument();
      view.unmount();
    }
  });
});
