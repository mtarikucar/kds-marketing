import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { browser } from '@/lib/browser';
import { delayed, mockFetch, renderAt } from '@/test/render';
import { context, conversation, inboxAnswers, inboxMe, journey, person } from '@/test/inbox';
import { CAMPAIGN_ID, LOADED, campaignOut, distribution, prospectId } from '@/test/leads';

const leadsInboxMe = {
  ...inboxMe,
  memberships: [{ ...inboxMe.memberships[0], permissions: [...inboxMe.memberships[0].permissions, 'outreach.work'] }],
};

const summary = {
  prospect_id: prospectId(1),
  business_name: 'Örnek Kafe 1',
  entity_kind: 'legal_entity',
  sector: 'kafe',
  city: 'İzmir',
  district: 'Alsancak',
  segment_key: 'kafeler',
  language: 'tr',
  origin: 'research_task',
  research_task_id: null,
  evidence: [
    {
      field: 'email',
      sources: [{ kind: 'url', url: 'https://ornek-kafe.example.invalid/iletisim', note: null }],
      captured_at: '2026-11-01T08:56:00Z',
      deliverable: true,
    },
  ],
  signals: [{ text: 'Yeni şube açıyor', source: { kind: 'manual', note: 'fuar' } }],
  latest_score: { score: 72, digest: 'abc', at: '2026-11-01T09:10:00Z' },
  reasons: [{ criterion: 'sube_sayisi', points: 30, evidence: 'İki şubesi var', source: null }],
  promotion: { person_id: person.id, journey_id: journey.id, at: '2026-11-02T09:00:00Z', score: 72, bucket: '50-74' },
};

const sentEvent = {
  id: 'event-1',
  workspace_id: journey.workspace_id,
  journey_id: journey.id,
  source: 'system',
  kind: { outreach_sent: { campaign_id: CAMPAIGN_ID, step: 1 } },
  idempotency_key: 'outreach:1',
  reason_label: null,
  at: '2026-11-03T09:00:00Z',
};

const enrollment = {
  id: '0190a000-0000-7000-8000-000000000801',
  campaign_id: CAMPAIGN_ID,
  person_id: person.id,
  journey_id: journey.id,
  prospect_id: prospectId(1),
  status: 'active',
  stop: null,
  skip: null,
  next_step: 2,
  next_send_at: '2026-11-06T07:00:00Z',
  personalization: {},
  basis: 'business_recipient',
  enrolled_at: '2026-11-03T08:00:00Z',
  stopped_at: null,
  last_sent_at: '2026-11-03T09:00:00Z',
};

const mailConversation = { ...conversation, kind_key: 'mailbox' };

function answers(extra: Record<string, unknown> = {}) {
  return {
    ...inboxAnswers,
    'GET /api/auth/me': leadsInboxMe,
    'GET /api/inbox/people/person-1': {
      person: { ...person, recipient_kind: 'business' },
      identities: [],
      open_journey: journey,
      conversations: [conversation],
      prospect: summary,
    },
    'GET /api/inbox/conversations/conv-1/context': {
      ...context,
      person: { ...context.person, recipient_kind: 'business' },
      prospect: summary,
    },
    ...extra,
  };
}

describe('InboxLeads', () => {
  it('prospect_facts_in_journey_panel', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      answers({
        'GET /api/distribution/assignments': {
          items: [
            {
              id: 'a-1',
              journey_id: journey.id,
              user_id: 'another-human',
              cause: 'rule',
              rule_id: null,
              assigned_at: '2026-11-02T09:00:00Z',
              sla_due_at: null,
              acted_at: null,
              superseded_at: null,
              by: { kind: 'system', component: 'lead_distribution' },
            },
          ],
          next: null,
        },
      }),
    );
    renderAt('/inbox/conv-1');
    const facts = within(await screen.findByRole('region', { name: tr.inbox.leads.prospect }, LOADED));
    expect(facts.getByRole('link', { name: 'Örnek Kafe 1' })).toHaveAttribute('href', `/prospects/${prospectId(1)}`);
    expect(facts.getByText('İki şubesi var', { exact: false })).toBeInTheDocument();
    expect(facts.getByRole('link', { name: 'https://ornek-kafe.example.invalid/iletisim' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
    expect(screen.getByTestId('recipient-kind')).toHaveTextContent(tr.leads.recipientKinds.business);
    // The assignment history is read when it is opened.
    expect(calls.some((c) => c.path === '/api/distribution/assignments')).toBe(false);
    await user.click(screen.getByRole('button', { name: new RegExp(tr.inbox.leads.assignments) }));
    const log = await screen.findByRole('list', { name: tr.inbox.leads.assignments }, LOADED);
    expect(within(log).getByText(tr.leads.causes.rule)).toBeInTheDocument();
    expect(new URLSearchParams(calls.find((c) => c.path === '/api/distribution/assignments')!.search).get('journey_id')).toBe(
      journey.id,
    );
  });

  it('recipient_kind_is_set_with_a_note', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers({ 'POST /api/inbox/people/person-1/kind': { person } }));
    renderAt('/inbox/conv-1');
    const form = within(await screen.findByRole('form', { name: tr.inbox.leads.setKind }, LOADED));
    await user.selectOptions(form.getByRole('combobox', { name: tr.inbox.leads.newKind }), 'individual');
    await user.type(form.getByRole('textbox', { name: tr.inbox.leads.kindNote }), 'Kendi adına alışveriş yapıyor');
    await user.click(form.getByRole('button', { name: tr.inbox.leads.setKind }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/inbox/people/person-1/kind')?.body).toEqual({
        kind: 'individual',
        note: 'Kendi adına alışveriş yapıyor',
      }),
    );
  });

  it('stop_sequence_from_inbox', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      answers({
        'GET /api/inbox/journeys/journey-1': { journey, events: [sentEvent], tasks: [], notes: [] },
        [`GET /api/outreach/campaigns/${CAMPAIGN_ID}/enrollments`]: { items: [enrollment], next: null },
        [`GET /api/outreach/campaigns/${CAMPAIGN_ID}`]: campaignOut({ status: 'running' }),
        [`POST /api/outreach/enrollments/${enrollment.id}/stop`]: { ...enrollment, status: 'stopped', stop: 'manual' },
      }),
    );
    renderAt('/inbox/conv-1');
    const sequence = within(await screen.findByRole('region', { name: tr.inbox.leads.sequence }, LOADED));
    expect(await sequence.findByRole('link', { name: 'İzmir kafeleri tanışma' }, LOADED)).toHaveAttribute(
      'href',
      `/outreach/${CAMPAIGN_ID}`,
    );
    expect(new URLSearchParams(calls.find((c) => c.path.endsWith('/enrollments'))!.search).get('status')).toBe('active');
    await user.click(sequence.getByRole('button', { name: tr.inbox.leads.stopSequence }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/stop'))?.body).toEqual({}),
    );
    // The timeline names the outreach email.
    expect(screen.getByText(tr.inbox.eventKind.outreach_sent)).toBeInTheDocument();
  });

  it('attachment_chip_downloads', async () => {
    const user = userEvent.setup();
    const go = vi.fn();
    const close = vi.fn();
    vi.spyOn(browser, 'openPending').mockReturnValue({ go, close });
    const listed = inboxAnswers['GET /api/inbox/conversations/conv-1/messages'] as { items: Record<string, unknown>[] };
    mockFetch(
      answers({
        'GET /api/inbox/conversations/conv-1/messages': {
          items: [
            {
              ...listed.items[0],
              attachments: [
                { file_id: 'file-1', filename: 'teklif.pdf', declared_mime: 'application/pdf', size_bytes: 2048, state: 'stored', skip_reason: null },
                { file_id: 'file-2', filename: 'buyuk.zip', declared_mime: 'application/zip', size_bytes: 20971520, state: 'skipped', skip_reason: 'file_too_large' },
              ],
            },
          ],
          next_cursor: null,
        },
        'GET /api/inbox/attachments/file-1': {
          file_id: 'file-1',
          filename: 'teklif.pdf',
          declared_mime: 'application/pdf',
          size_bytes: 2048,
          state: 'stored',
          skip_reason: null,
          direction: 'inbound',
          message_id: 'message-1',
          expires_at: null,
          download_url: 'https://files.example.invalid/f/file-1?sig=abc',
          download_expires_at: '2026-11-11T10:10:00Z',
        },
      }),
    );
    renderAt('/inbox/conv-1');
    await user.click(await screen.findByRole('button', { name: 'teklif.pdf (2 KB) dosyasını indir' }, LOADED));
    await waitFor(() => expect(go).toHaveBeenCalledWith('https://files.example.invalid/f/file-1?sig=abc'));
    expect(screen.getByText(/buyuk\.zip/)).toHaveTextContent(tr.inbox.attachments.skipped.file_too_large);
  });

  it('composer_attachment_resets_on_conversation_change', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      answers({
        'GET /api/inbox/conversations': { items: [mailConversation, { ...mailConversation, id: 'conv-2' }], next_cursor: null },
        'GET /api/inbox/conversations/conv-1': mailConversation,
        'GET /api/inbox/conversations/conv-2': { ...mailConversation, id: 'conv-2' },
        'GET /api/inbox/conversations/conv-2/context': context,
        'GET /api/inbox/conversations/conv-2/messages': { items: [], next_cursor: null },
        'POST /api/inbox/attachments': delayed(50, {
          file_id: 'file-9',
          filename: 'katalog.pdf',
          declared_mime: 'application/pdf',
          size_bytes: 9,
          state: 'staged',
          skip_reason: null,
          direction: 'outbound',
          message_id: null,
          expires_at: '2026-11-18T10:00:00Z',
        }),
      }),
    );
    renderAt('/inbox/conv-1');
    const input = await screen.findByLabelText(tr.inbox.attachments.add, undefined, LOADED);
    await user.upload(input, new File(['%PDF-1.4\n'], 'katalog.pdf', { type: 'application/pdf' }));
    const staged = await screen.findByRole('list', { name: tr.inbox.attachments.staged }, LOADED);
    expect(within(staged).getByText(/katalog\.pdf/)).toBeInTheDocument();
    const upload = calls.find((c) => c.path === '/api/inbox/attachments')!.body as Record<string, string>;
    expect(upload).toMatchObject({ filename: 'katalog.pdf', mime: 'application/pdf', data_base64: btoa('%PDF-1.4\n') });
    expect(typeof upload.request_key).toBe('string');

    // The reply carries it.
    await user.type(screen.getByRole('textbox', { name: tr.inbox.reply }), 'Katalog ekte');
    await user.click(screen.getByRole('button', { name: tr.inbox.send }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/inbox/conversations/conv-1/reply')?.body).toMatchObject({
        text: 'Katalog ekte',
        attachments: ['file-9'],
      }),
    );

    // Another conversation's composer starts empty.
    await user.upload(screen.getByLabelText(tr.inbox.attachments.add), new File(['%PDF-1.4\n'], 'katalog.pdf', { type: 'application/pdf' }));
    await screen.findByRole('list', { name: tr.inbox.attachments.staged }, LOADED);
    const links = screen.getAllByRole('link').filter((a) => a.getAttribute('href') === '/inbox/conv-2');
    await user.click(links[0]);
    await waitFor(() => expect(screen.queryByRole('list', { name: tr.inbox.attachments.staged })).not.toBeInTheDocument());
  });

  it('ownerless_queue', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      answers({
        'GET /api/distribution': distribution,
        [`GET /api/inbox/journeys/${distribution.ownerless.oldest_journey_id}`]: {
          journey: { ...journey, id: distribution.ownerless.oldest_journey_id, owner: null, person_id: 'person-2' },
          events: [],
          tasks: [],
          notes: [],
        },
        'POST /api/distribution/backfill': { assigned: 3, no_eligible: 0, imported: 0, reassigned: 0, kept: 0 },
      }),
    );
    renderAt('/inbox');
    await user.click(await screen.findByRole('button', { name: tr.inbox.queue.ownerless }, LOADED));
    const queue = within(await screen.findByTestId('ownerless', undefined, LOADED));
    expect(queue.getByText('Sahibi olmayan açık yolculuk: 3')).toBeInTheDocument();
    expect(await queue.findByRole('link', { name: tr.inbox.leads.oldest }, LOADED)).toHaveAttribute('href', '/inbox?person=person-2');
    await user.click(queue.getByRole('button', { name: tr.leads.distribution.backfill }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/distribution/backfill')?.body).toEqual({}));
  });
});
