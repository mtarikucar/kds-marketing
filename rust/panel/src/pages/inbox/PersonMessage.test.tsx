import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt } from '@/test/render';
import { WS_ID } from '@/test/fixtures';
import { coreModules, legacyModules } from '@/test/modules';
import { inboxAnswers, person } from '@/test/inbox';
import { LOADED } from '@/test/leads';

const emailIdentity = {
  id: 'identity-email',
  workspace_id: WS_ID,
  person_id: person.id,
  channel: 'email',
  value_normalized: 'deniz@example.invalid',
  value_display: 'deniz@example.invalid',
  active: true,
  first_seen_at: '2026-10-23T10:00:00Z',
};
const settings = {
  sender_company: 'Alfa Atölye',
  sender_address: 'Örnek Mah. 1, İzmir',
  privacy_notice_url: 'https://alfa.example.invalid/kvkk',
  b2b_basis: [],
  require_iys_lookup: true,
  legal_ack: null,
  sender_identity_complete: true,
  platform_enabled: true,
  b2b_channels_in_force: [],
};
const mailbox = {
  capability: { id: 'cap-mail', workspace_id: WS_ID, kind_key: 'mailbox', name: 'Satış posta kutusu', has_sealed_config: true },
  effective_status: 'verified',
};
// The inbox page with only it and the required modules: no campaigns.
const inboxOnly = { ...coreModules, modules: legacyModules.modules.map((m) => ({ ...m, installed: m.required || m.blueprint.id === 'inbox' })) };

describe('Mesaj yaz on a person with no conversation yet', () => {
  it('writes the first email from the inbox, in the same dialog, with no campaigns module', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      ...inboxAnswers,
      'GET /api/workspace/modules': inboxOnly,
      'GET /api/inbox/people/person-1': { person, identities: [emailIdentity], open_journey: null, conversations: [] },
      'GET /api/capabilities': [mailbox],
      'GET /api/inbox/email-settings': settings,
      'POST /api/inbox/people/person-1/send': { message_id: 'm-1', state: 'sent' },
    });
    renderAt('/inbox?person=person-1');
    await user.click(await screen.findByRole('button', { name: 'Mesaj yaz' }, LOADED));
    const dialog = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(dialog.getByRole('radio', { name: 'E-posta' })).toBeChecked());
    // A person has no hand-offs here: email and SMS only.
    expect(dialog.queryByRole('radio', { name: 'WhatsApp' })).not.toBeInTheDocument();
    await user.type(dialog.getByRole('textbox', { name: 'Konu' }), 'Merhaba');
    await user.type(dialog.getByRole('textbox', { name: 'Mesaj' }), 'Kısa bir tanışma.');
    await user.click(dialog.getByRole('button', { name: 'Gönder' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/inbox/people/person-1/send')).toHaveLength(1));
    expect(calls.find((c) => c.path === '/api/inbox/people/person-1/send')?.body).toMatchObject({ channel: 'email', intent: 'commercial', subject: 'Merhaba' });
    expect(calls.some((c) => c.path.startsWith('/api/outreach') || c.path.startsWith('/api/prospects'))).toBe(false);
  });

  it('is not offered for a person with no address to write to', async () => {
    mockFetch({ ...inboxAnswers, 'GET /api/inbox/people/person-1': { person, identities: [], open_journey: null, conversations: [] } });
    renderAt('/inbox?person=person-1');
    await screen.findByRole('heading', { level: 2, name: person.display_name }, LOADED);
    expect(screen.queryByRole('button', { name: 'Mesaj yaz' })).not.toBeInTheDocument();
  });
});
