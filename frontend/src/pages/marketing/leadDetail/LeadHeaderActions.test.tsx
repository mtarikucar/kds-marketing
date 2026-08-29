import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import LeadHeaderActions from './LeadHeaderActions';
import * as conversationsService from '../../../features/marketing/api/conversations.service';
import marketingApi from '../../../features/marketing/api/marketingApi';

vi.mock('../../../features/marketing/api/conversations.service');
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

// The dial affordance is the EXISTING ClickToDialButton — this file's job is
// to prove it is mounted (or deliberately absent) and handed the right lead,
// not to re-test dialling. Stubbing it also keeps the SIP.js webphone import
// chain out of jsdom.
vi.mock('../../../features/marketing/components', () => ({
  ClickToDialButton: (props: { leadId?: string; defaultPhone?: string }) => (
    <div data-testid="click-to-dial" data-lead={props.leadId} data-phone={props.defaultPhone} />
  ),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'tr' },
  }),
}));

const listConversations = vi.mocked(conversationsService.listConversations);
const startConversation = vi.mocked(conversationsService.startConversation);
const apiGet = vi.mocked(marketingApi.get);

const thread = (id: string) =>
  ({ id, status: 'OPEN', aiPaused: false, unreadCount: 0 }) as conversationsService.ConversationSummary;

/** What `POST /conversations/start` really answers with — the thread AND the
 *  Message row, whose `status` is the only place the send's outcome lives. */
const started = (
  status: conversationsService.StartedMessage['status'],
  error?: string,
): conversationsService.StartedConversation => ({
  conversationId: 'c-new',
  leadId: 'l1',
  channel: 'SMS',
  to: '+905551112233',
  reusedThread: false,
  message: {
    id: 'm1',
    conversationId: 'c-new',
    direction: 'OUTBOUND',
    body: 'Merhaba',
    status,
    error: error ?? null,
    externalMessageId: status === 'SENT' ? 'ext-1' : null,
    createdAt: '2026-08-29T09:00:00.000Z',
  },
});

const CHANNELS = [
  { id: 'ch-sms', type: 'SMS', name: 'NetGSM', status: 'ACTIVE' },
  { id: 'ch-wa', type: 'WHATSAPP', name: 'WhatsApp Business', status: 'ACTIVE' },
  // Neither of these can OPEN a thread — see OutboundConversationService's
  // INITIABLE map — so neither may be offered here.
  { id: 'ch-ig', type: 'INSTAGRAM', name: 'Instagram', status: 'ACTIVE' },
  { id: 'ch-sms-off', type: 'SMS', name: 'Eski hat', status: 'DISABLED' },
];

function renderActions(
  lead: { id: string; phone?: string | null; smsOptOut?: boolean },
  onOpenConversations = vi.fn(),
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LeadHeaderActions lead={lead} onOpenConversations={onOpenConversations} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onOpenConversations };
}

/** The Mesaj button decides between "open the thread" and "start one", so it
 *  must not be clickable before the answer has arrived. */
async function readyMessageButton() {
  const btn = await screen.findByRole('button', { name: 'Mesaj' });
  await waitFor(() => expect(btn).toBeEnabled());
  return btn;
}

/** Open the start dialog, pick the one offerable channel, type and send. The
 *  three send-outcome tests differ ONLY in what the endpoint answers, so the
 *  driving is shared and the difference is the assertion. */
async function sendFirstMessage(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await readyMessageButton());
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('combobox'));
  await screen.findByRole('listbox');
  await user.click(screen.getByRole('option', { name: /NetGSM/ }));
  await user.type(within(dialog).getByLabelText(/İlk mesaj/), 'Merhaba');
  await user.click(within(dialog).getByRole('button', { name: 'Gönder' }));
}

/** Entitlements come from the same `/billing/summary` read the rest of the app
 *  uses (useEntitlements shares its query key), so the mock dispatches on URL
 *  rather than answering every GET with channels.
 *
 *  Two flags, not one: Mesaj is gated on `conversationAi` and Ara on
 *  `telephony`. A single switch would let each gate's test pass on the other
 *  gate's behaviour. */
let entitled = true;
let telephony = true;

const billing = () => ({
  data: { entitlements: { features: { conversationAi: entitled, telephony } } },
});

beforeEach(() => {
  vi.clearAllMocks();
  entitled = true;
  telephony = true;
  listConversations.mockResolvedValue([]);
  startConversation.mockResolvedValue(started('SENT'));
  apiGet.mockImplementation((url: string) =>
    Promise.resolve(url === '/billing/summary' ? billing() : { data: CHANNELS }),
  );
});

describe('LeadHeaderActions — Ara', () => {
  it('offers the existing click-to-dial, carrying this lead and its number', async () => {
    renderActions({ id: 'l1', phone: '+905551112233' });

    const dial = await screen.findByTestId('click-to-dial');
    // leadId is what makes the call mirror onto THIS lead's timeline
    // (SalesCallService.logCall writes the CALL LeadActivity off call.leadId).
    expect(dial).toHaveAttribute('data-lead', 'l1');
    expect(dial).toHaveAttribute('data-phone', '+905551112233');
  });

  it('renders NO dial affordance at all for a lead with no phone', async () => {
    renderActions({ id: 'l1', phone: null });

    // Positive anchor FIRST — the component is settled and has rendered its
    // other action. Without it, `queryByTestId(...)` is trivially null on a
    // page that has not mounted anything yet.
    await readyMessageButton();
    expect(screen.queryByTestId('click-to-dial')).not.toBeInTheDocument();
  });

  // Consent, not just reachability. `smsOptOut` is the flag every other path
  // that reaches a lead already honours — campaigns suppress it,
  // ConversationAiEngineService refuses to auto-reply, esp-feedback sets it on
  // a hard bounce — and jeeta.click_to_dial refuses to dial on it. A lead who
  // said stop has a perfectly good phone number, so "has a number" is the
  // wrong question to hang the button on.
  it('renders NO dial affordance for a lead who opted out of phone contact', async () => {
    renderActions({ id: 'l1', phone: '+905551112233', smsOptOut: true });

    await readyMessageButton();
    expect(screen.queryByTestId('click-to-dial')).not.toBeInTheDocument();
  });

  it('renders no dial affordance for a whitespace-only phone', async () => {
    renderActions({ id: 'l1', phone: '   ' });

    await readyMessageButton();
    expect(screen.queryByTestId('click-to-dial')).not.toBeInTheDocument();
  });
});

describe('LeadHeaderActions — Mesaj', () => {
  it('opens the lead’s existing threads rather than starting a new one', async () => {
    const user = userEvent.setup({ delay: null });
    listConversations.mockResolvedValue([thread('c1')]);
    const { onOpenConversations } = renderActions({ id: 'l1', phone: '+905551112233' });

    await user.click(await readyMessageButton());

    expect(onOpenConversations).toHaveBeenCalledTimes(1);
    // No start flow — this lead is already being talked to.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(listConversations).toHaveBeenCalledWith({ leadId: 'l1' });
  });

  it('opens the start flow when there is no thread yet, and posts to the existing start endpoint', async () => {
    const user = userEvent.setup({ delay: null });
    listConversations.mockResolvedValue([]);
    const { onOpenConversations } = renderActions({ id: 'l1', phone: '+905551112233' });

    await user.click(await readyMessageButton());

    const dialog = await screen.findByRole('dialog');
    expect(onOpenConversations).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('combobox'));
    await screen.findByRole('listbox');
    // Only channels that can actually OPEN a thread are offered: Instagram
    // has no API to DM someone who has not written first, and a DISABLED
    // channel is refused by the backend. Offering either is offering a
    // button that fails when clicked.
    expect(screen.queryByRole('option', { name: /Instagram/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Eski hat/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /NetGSM/ }));

    await user.type(
      within(dialog).getByLabelText(/İlk mesaj/),
      'Merhaba',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Gönder' }));

    await waitFor(() =>
      expect(startConversation).toHaveBeenCalledWith({
        leadId: 'l1',
        channelId: 'ch-sms',
        text: 'Merhaba',
      }),
    );
    // Once the thread exists, land the user on it.
    await waitFor(() => expect(onOpenConversations).toHaveBeenCalledTimes(1));
  });

  /**
   * WhatsApp is INITIABLE on the backend, and still must not be offered HERE.
   *
   * This dialog opens on exactly one condition: `listConversations({ leadId })`
   * came back empty, and it passes no status filter — so the lead has no
   * WhatsApp thread of ANY status, which means no inbound WhatsApp message has
   * ever been ingested for them. Meta's 24h session window is therefore shut,
   * and a free-text first contact needs an approved template this dialog has no
   * field for (`supportsTemplate: true` is the backend saying "bring a
   * template", not "text is fine here").
   *
   * What makes it a lie rather than merely a failure: MessageSenderService.send
   * does NOT throw when the adapter rejects a send — it records the Message as
   * FAILED, refunds the quota, logs a warning and RETURNS. So
   * `POST /conversations/start` answers 2xx, this dialog toasts "Mesaj
   * gönderildi" and drops the rep on a thread whose only message never left the
   * building. SMS and email can fail that way too; WhatsApp is the one that
   * does it every single time.
   */
  it('does not offer WhatsApp for a first message — the window is shut and this dialog has no template field', async () => {
    const user = userEvent.setup({ delay: null });
    renderActions({ id: 'l1', phone: '+905551112233' });

    await user.click(await readyMessageButton());
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox'));
    await screen.findByRole('listbox');

    // Positive anchor: the list DID render its offerable channel.
    expect(screen.getByRole('option', { name: /NetGSM/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /WhatsApp/ })).not.toBeInTheDocument();
  });

  it('refuses to send without text — the backend rejects a textless, templateless start', async () => {
    const user = userEvent.setup({ delay: null });
    renderActions({ id: 'l1', phone: '+905551112233' });

    await user.click(await readyMessageButton());
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('combobox'));
    await screen.findByRole('listbox');
    await user.click(screen.getByRole('option', { name: /NetGSM/ }));

    expect(within(dialog).getByRole('button', { name: 'Gönder' })).toBeDisabled();
    expect(startConversation).not.toHaveBeenCalled();
  });

  /**
   * The 2xx that is not a success.
   *
   * MessageSenderService.send does NOT throw when an adapter rejects a send: it
   * records the Message with status FAILED and the provider's reason, refunds
   * the quota, logs a warning and RETURNS (message-sender.service.ts:78-93,
   * :177). OutboundConversationService.start hands that Message straight back,
   * so `POST /conversations/start` answers 200 for a message that never left
   * the building — on SMS and email exactly as much as on WhatsApp.
   *
   * So `onSuccess` is the wrong place to decide the outcome: the transport
   * succeeded, the SEND is what failed, and the only thing that knows is
   * `message.status` in the body. Two tests, not one, because a green toast is
   * only a lie if the other branch is genuinely reachable.
   */
  it('toasts success only when the returned message actually went out', async () => {
    const user = userEvent.setup({ delay: null });
    startConversation.mockResolvedValue(started('SENT'));
    const { onOpenConversations } = renderActions({ id: 'l1', phone: '+905551112233' });

    await sendFirstMessage(user);

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalled();
    await waitFor(() => expect(onOpenConversations).toHaveBeenCalledTimes(1));
  });

  it('does not claim a 2xx FAILED message was sent — it says why it was not', async () => {
    const user = userEvent.setup({ delay: null });
    startConversation.mockResolvedValue(
      started('FAILED', 'NetGSM rejected the message: 0030 invalid header'),
    );
    const { onOpenConversations } = renderActions({ id: 'l1', phone: '+905551112233' });

    await sendFirstMessage(user);

    // The provider's own reason, not a generic shrug — it is the only thing
    // that tells the rep whether to retry, fix the header or pick a channel.
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('0030 invalid header')),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    // Not navigated: ConversationsTab renders `lastMessage.body` with NO
    // failure indicator (ConversationsTab.tsx:101-103), so landing the rep
    // there would re-assert the very claim this branch exists to withdraw.
    // The dialog stays open, with the text intact, as the retry surface.
    expect(onOpenConversations).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/İlk mesaj/)).toHaveValue('Merhaba');
  });

  it('surfaces the backend’s refusal instead of pretending the message went out', async () => {
    const user = userEvent.setup({ delay: null });
    startConversation.mockRejectedValue({
      response: { data: { message: 'This lead opted out of SMS messages, so a conversation cannot be started.' } },
    });
    const { onOpenConversations } = renderActions({ id: 'l1', phone: '+905551112233' });

    await user.click(await readyMessageButton());
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox'));
    await screen.findByRole('listbox');
    await user.click(screen.getByRole('option', { name: /NetGSM/ }));
    await user.type(within(dialog).getByLabelText(/İlk mesaj/), 'Merhaba');
    await user.click(within(dialog).getByRole('button', { name: 'Gönder' }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining('opted out')));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onOpenConversations).not.toHaveBeenCalled();
  });
});

// `POST /calls/start` is behind @RequiresFeature('telephony') at CONTROLLER
// level on SalesCallController, but `/leads` carries no feature in
// navigation.ts — so a workspace without telephony reaches lead detail freely
// and, until this gate, was offered a dial button whose only possible outcome
// was a 403. Same rule as Mesaj, same reason: a button that fails when clicked
// is worse than no button.
describe('LeadHeaderActions — the telephony gate', () => {
  it('does not offer Ara at all to a workspace without the feature', async () => {
    telephony = false;
    renderActions({ id: 'l1', phone: '+905551112233' });

    // Positive anchor: Mesaj is up and settled, so the component HAS rendered
    // its actions. Without it, `queryByTestId(...)` is trivially null against a
    // tree that has not mounted anything yet.
    await readyMessageButton();
    expect(screen.queryByTestId('click-to-dial')).not.toBeInTheDocument();
  });

  // useEntitlements fails CLOSED: `features` is `{}` until /billing/summary
  // answers, so `has('telephony')` is false for that whole window. Asserting it
  // needs the resolution as the anchor — the button appearing AFTER the read
  // lands is what proves its earlier absence was this gate and not an unmounted
  // tree.
  it('keeps Ara off while the entitlement read is still in flight', async () => {
    let releaseBilling: () => void = () => {};
    const pending = new Promise<void>((r) => {
      releaseBilling = r;
    });
    apiGet.mockImplementation((url: string) =>
      url === '/billing/summary'
        ? pending.then(() => billing())
        : Promise.resolve({ data: CHANNELS }),
    );

    renderActions({ id: 'l1', phone: '+905551112233' });

    expect(screen.queryByTestId('click-to-dial')).not.toBeInTheDocument();
    releaseBilling();
    expect(await screen.findByTestId('click-to-dial')).toBeInTheDocument();
  });
});

describe('LeadHeaderActions — the conversationAi gate', () => {
  it('does not offer Mesaj at all to a workspace without the feature', async () => {
    entitled = false;
    renderActions({ id: 'l1', phone: '+905551112233' });

    // Positive anchor: Ara is up, so the component has rendered.
    await screen.findByTestId('click-to-dial');
    expect(screen.queryByRole('button', { name: 'Mesaj' })).not.toBeInTheDocument();
    // …and it did not go asking for threads it is not allowed to read. Both
    // halves of Mesaj sit behind @RequiresFeature('conversationAi'), so the
    // query would 403 as reliably as the button would.
    expect(listConversations).not.toHaveBeenCalled();
  });
});
