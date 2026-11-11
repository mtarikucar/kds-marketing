import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { LOADED, agentsList, leadsMe, outreachSettings, prospectId, prospectOut, team } from '@/test/leads';
import { handoffUrl } from './MessageDialog';

const ID = prospectId(1);
const live = (kind: string, name: string) => ({
  capability: { id: `cap-${kind}`, workspace_id: leadsMe.current_workspace, kind_key: kind, name, has_sealed_config: true },
  effective_status: 'verified',
});
const open = { ...outreachSettings, b2b_basis: ['email', 'sms'], b2b_channels_in_force: ['email', 'sms'] };
const promoted = {
  items: [{ outcome: 'promoted', prospect_id: ID, person_id: 'person-1', journey_id: 'journey-1', created_person: true, owner_id: null }],
};

function answers(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/auth/me': leadsMe,
    'GET /api/agents': agentsList,
    'GET /api/team': team,
    'GET /api/prospects': { items: [], next: null },
    'GET /api/research/tasks': { items: [], next: null },
    [`GET /api/prospects/${ID}`]: prospectOut(1),
    'GET /api/capabilities': [live('mailbox', 'Satış posta kutusu'), live('sms_line', 'SMS hattı')],
    'GET /api/outreach/settings': open,
    'POST /api/prospects/promote': promoted,
    'POST /api/inbox/people/person-1/send': { message_id: 'm-1', state: 'sent' },
    'POST /api/inbox/journeys/journey-1/notes': { id: 'n-1' },
    ...extra,
  };
}

async function openDialog(extra: Record<string, unknown> = {}) {
  const user = userEvent.setup();
  const calls = mockFetch(answers(extra));
  renderAt(`/prospects/${ID}`);
  await user.click(await screen.findByRole('button', { name: 'Mesaj gönder' }, LOADED));
  const dialog = within(await screen.findByRole('dialog'));
  // The channels are judged once the workspace's accounts and its permission are read.
  await waitFor(() => expect(dialog.getByRole('radio', { name: 'E-posta' })).toBeEnabled());
  return { user, calls, dialog };
}

const posts = (calls: { method: string; path: string; body?: unknown }[], path: string) =>
  calls.filter((c) => c.method === 'POST' && c.path === path);

afterEach(() => vi.restoreAllMocks());

describe('MessageDialog', () => {
  it('sends the first email through the inbox: the prospect is taken into contact, then the message goes with its subject', async () => {
    const { user, calls, dialog } = await openDialog();
    expect(dialog.getByRole('radio', { name: 'E-posta' })).toBeChecked();
    expect(dialog.getByText('“Satış posta kutusu” üzerinden gönderilir')).toBeInTheDocument();
    const send = dialog.getByRole('button', { name: 'Gönder' });
    expect(send).toBeDisabled();
    await user.type(dialog.getByRole('textbox', { name: 'Mesaj' }), 'Merhaba, sadakat kartımızı anlatmak isteriz.');
    // An email needs its subject too.
    expect(send).toBeDisabled();
    await user.type(dialog.getByRole('textbox', { name: 'Konu' }), 'Örnek Kafe için sadakat kartı');
    await user.click(send);
    await waitFor(() => expect(posts(calls, '/api/inbox/people/person-1/send')).toHaveLength(1));
    // A qualified prospect is not decided again; it is promoted, then written to.
    expect(calls.some((c) => c.path.endsWith('/decision'))).toBe(false);
    expect(posts(calls, '/api/prospects/promote')[0].body).toMatchObject({ prospect_ids: [ID] });
    const body = posts(calls, '/api/inbox/people/person-1/send')[0].body as Record<string, unknown>;
    expect(body).toMatchObject({
      channel: 'email',
      intent: 'commercial',
      text: 'Merhaba, sadakat kartımızı anlatmak isteriz.',
      subject: 'Örnek Kafe için sadakat kartı',
    });
    expect(typeof body.request_key).toBe('string');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('a new prospect is qualified by the act of writing to it, and an SMS carries no subject', async () => {
    const { user, calls, dialog } = await openDialog({
      [`GET /api/prospects/${ID}`]: prospectOut(1, { status: 'new' }),
      [`POST /api/prospects/${ID}/decision`]: { prospect: prospectOut(1).prospect, flags: [] },
    });
    await user.click(dialog.getByRole('radio', { name: 'SMS' }));
    expect(dialog.queryByRole('textbox', { name: 'Konu' })).not.toBeInTheDocument();
    await user.type(dialog.getByRole('textbox', { name: 'Mesaj' }), 'Merhaba');
    await user.click(dialog.getByRole('button', { name: 'Gönder' }));
    await waitFor(() => expect(posts(calls, '/api/inbox/people/person-1/send')).toHaveLength(1));
    expect(posts(calls, `/api/prospects/${ID}/decision`)[0].body).toEqual({ decision: 'qualify', expected_revision: 3 });
    const order = calls.filter((c) => c.method === 'POST').map((c) => c.path);
    expect(order).toEqual([`/api/prospects/${ID}/decision`, '/api/prospects/promote', '/api/inbox/people/person-1/send']);
    const body = posts(calls, '/api/inbox/people/person-1/send')[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ channel: 'sms', text: 'Merhaba', intent: 'commercial' });
    expect(body).not.toHaveProperty('subject');
  });

  it('a prospect already in contact is written to without promoting it again', async () => {
    const inContact = { person_id: 'person-1', journey_id: 'journey-1', at: '2026-11-02T10:00:00Z', score: 72, bucket: '50-74' as const };
    const { user, calls, dialog } = await openDialog({
      [`GET /api/prospects/${ID}`]: prospectOut(1, { status: 'promoted', promoted: inContact }),
    });
    await user.click(dialog.getByRole('radio', { name: 'SMS' }));
    await user.type(dialog.getByRole('textbox', { name: 'Mesaj' }), 'Merhaba');
    await user.click(dialog.getByRole('button', { name: 'Gönder' }));
    await waitFor(() => expect(posts(calls, '/api/inbox/people/person-1/send')).toHaveLength(1));
    expect(posts(calls, '/api/prospects/promote')).toHaveLength(0);
  });

  it('a retry after a lost answer reuses the same request keys, so nothing is done twice', async () => {
    const { user, calls, dialog } = await openDialog({
      'POST /api/inbox/people/person-1/send': withStatus(500, { code: 'INTERNAL', message: 'boom', details: {} }),
    });
    await user.click(dialog.getByRole('radio', { name: 'SMS' }));
    await user.type(dialog.getByRole('textbox', { name: 'Mesaj' }), 'Merhaba');
    const send = dialog.getByRole('button', { name: 'Gönder' });
    await user.click(send);
    await waitFor(() => expect(posts(calls, '/api/inbox/people/person-1/send')).toHaveLength(1));
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await waitFor(() => expect(posts(calls, '/api/inbox/people/person-1/send')).toHaveLength(2));
    const key = (path: string) => posts(calls, path).map((c) => (c.body as { request_key: string }).request_key);
    expect(new Set(key('/api/prospects/promote')).size).toBe(1);
    expect(new Set(key('/api/inbox/people/person-1/send')).size).toBe(1);
    // The dialog stays open with the error; the text typed is still there.
    expect(dialog.getByRole('textbox', { name: 'Mesaj' })).toHaveValue('Merhaba');
  });

  it('says why a channel is closed and where it is opened, and falls to the first open one', async () => {
    const { dialog } = await openDialogWith({
      'GET /api/capabilities': [live('mailbox', 'Satış posta kutusu')],
      'GET /api/outreach/settings': { ...outreachSettings, b2b_basis: [], b2b_channels_in_force: [] },
    });
    const row = (name: string) => within(dialog.getByRole('radio', { name }).closest('label')!);
    await waitFor(() => expect(dialog.getByRole('radio', { name: 'E-posta' })).toBeDisabled());
    expect(row('E-posta').getByText(/Bu kanalda işletmelere ilk mesaj izni kapalı/)).toBeInTheDocument();
    expect(row('E-posta').getByRole('link', { name: 'İzni aç' })).toHaveAttribute('href', '/outreach/settings');
    expect(dialog.getByRole('radio', { name: 'SMS' })).toBeDisabled();
    expect(row('SMS').getByText(/Bağlı ve doğrulanmış SMS hattı yok/)).toBeInTheDocument();
    expect(row('SMS').getByRole('link', { name: 'Kanal bağla' })).toHaveAttribute('href', '/connect');
    expect(dialog.getByRole('radio', { name: 'Instagram' })).toBeDisabled();
    expect(row('Instagram').getByText('Instagram hesabı yok')).toBeInTheDocument();
    // WhatsApp needs only the number: it is what is left, and it is chosen.
    expect(dialog.getByRole('radio', { name: 'WhatsApp' })).toBeChecked();
    expect(dialog.getByRole('button', { name: 'Hazırla ve WhatsApp’ı aç' })).toBeInTheDocument();
  });

  it('hands WhatsApp off: takes the prospect into contact, notes it on the journey and opens the chat with the text', async () => {
    const tab = { opener: {} as unknown, location: { href: 'about:blank' }, close: vi.fn() };
    const opened = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const { user, calls, dialog } = await openDialog();
    await user.click(dialog.getByRole('radio', { name: 'WhatsApp' }));
    await user.type(dialog.getByRole('textbox', { name: 'Mesaj' }), 'Merhaba & hoş geldiniz');
    await user.click(dialog.getByRole('button', { name: 'Hazırla ve WhatsApp’ı aç' }));
    await waitFor(() => expect(tab.location.href).toBe('https://wa.me/905000000000?text=Merhaba%20%26%20ho%C5%9F%20geldiniz'));
    // The tab was opened inside the click, before anything was awaited, and cut loose from the panel.
    expect(opened).toHaveBeenCalledWith('about:blank', '_blank');
    expect(tab.opener).toBeNull();
    expect(posts(calls, '/api/prospects/promote')).toHaveLength(1);
    expect(posts(calls, '/api/inbox/journeys/journey-1/notes')[0].body).toEqual({ text: '↗ WhatsApp: Merhaba & hoş geldiniz' });
    // Jeeta itself sends nothing on WhatsApp.
    expect(posts(calls, '/api/inbox/people/person-1/send')).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('a blocked pop-up leaves a link to the chat instead', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const { user, dialog } = await openDialog();
    await user.click(dialog.getByRole('radio', { name: 'WhatsApp' }));
    await user.type(dialog.getByRole('textbox', { name: 'Mesaj' }), 'Merhaba');
    await user.click(dialog.getByRole('button', { name: 'Hazırla ve WhatsApp’ı aç' }));
    const link = await dialog.findByRole('link', { name: 'WhatsApp sohbetini aç' });
    expect(link).toHaveAttribute('href', 'https://wa.me/905000000000?text=Merhaba');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('a refused promotion stops before anything is sent, says why and closes the tab it opened', async () => {
    const tab = { opener: {} as unknown, location: { href: 'about:blank' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const { user, calls, dialog } = await openDialog({
      'POST /api/prospects/promote': { items: [{ outcome: 'refused', prospect_id: ID, reason: 'daily_cap', details: {} }] },
    });
    await user.click(dialog.getByRole('radio', { name: 'WhatsApp' }));
    await user.type(dialog.getByRole('textbox', { name: 'Mesaj' }), 'Merhaba');
    await user.click(dialog.getByRole('button', { name: 'Hazırla ve WhatsApp’ı aç' }));
    expect(await dialog.findByText(tr.leads.promoteRefused.daily_cap)).toBeInTheDocument();
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe('about:blank');
    expect(posts(calls, '/api/inbox/journeys/journey-1/notes')).toHaveLength(0);
  });

  it('explains a refusal by the commercial permission and points at the setting', async () => {
    const { user, dialog } = await openDialog({
      'POST /api/inbox/people/person-1/send': withStatus(403, { code: 'FORBIDDEN', message: 'IZIN_YOK', details: {} }),
    });
    await user.type(dialog.getByRole('textbox', { name: 'Konu' }), 'Konu');
    await user.type(dialog.getByRole('textbox', { name: 'Mesaj' }), 'Merhaba');
    await user.click(dialog.getByRole('button', { name: 'Gönder' }));
    expect(await dialog.findByText(/Bu alıcıya bu kanaldan ticari mesaj izni yok/)).toBeInTheDocument();
  });

  it('builds the chat address of a hand-off', () => {
    expect(handoffUrl('whatsapp', '+90 500 000 00 02', 'Selam')).toBe('https://wa.me/905000000002?text=Selam');
    for (const handle of ['mavifincan', '@mavifincan', 'https://www.instagram.com/mavifincan/', 'https://instagram.com/mavifincan?hl=tr']) {
      expect(handoffUrl('instagram', handle, 'yok sayılır')).toBe('https://ig.me/m/mavifincan');
    }
  });
});

/** [`openDialog`] without waiting for email to be open (a test about closed channels). */
async function openDialogWith(extra: Record<string, unknown>) {
  const user = userEvent.setup();
  const calls = mockFetch(answers(extra));
  renderAt(`/prospects/${ID}`);
  await user.click(await screen.findByRole('button', { name: 'Mesaj gönder' }, LOADED));
  const dialog = within(await screen.findByRole('dialog'));
  return { user, calls, dialog };
}
