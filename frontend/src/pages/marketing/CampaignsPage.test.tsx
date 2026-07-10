import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import CampaignsPage from './CampaignsPage';

const get = vi.fn();
const post = vi.fn().mockResolvedValue({ data: { recipients: 5 } });
vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
    i18n: { language: 'en' },
  }),
}));

const DRAFT = [{ id: 'c1', name: 'Promo', channel: 'EMAIL', status: 'DRAFT', stats: null }];

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('CampaignsPage launch', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockClear();
    get.mockImplementation((url: string) =>
      url === '/campaigns' ? Promise.resolve({ data: DRAFT }) : Promise.resolve({ data: [] }),
    );
  });

  it('confirms before launching — a single click does NOT mass-send', async () => {
    const user = userEvent.setup();
    render(<CampaignsPage />, { wrapper });

    // The row's Launch button (only one before the confirm dialog opens).
    const rowLaunch = await screen.findByRole('button', { name: /Launch/i });
    await user.click(rowLaunch);

    // No send yet — the confirm dialog is shown instead of firing the mutation.
    expect(post).not.toHaveBeenCalled();

    // Confirm in the dialog actually launches.
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Launch/i }));
    expect(post).toHaveBeenCalledWith('/campaigns/c1/launch');
  });
});

// Task 8b: a DRAFT campaign with a future scheduledAt (set via the form) makes
// launch() SCHEDULE rather than send immediately — the confirm dialog's copy
// must say so instead of implying an instant, irreversible send.
describe('CampaignsPage — launch a campaign with a future scheduledAt', () => {
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const SCHEDULED_DRAFT = [{ id: 'c1', name: 'Promo', channel: 'EMAIL', status: 'DRAFT', stats: null, scheduledAt: FUTURE }];

  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    post.mockResolvedValue({ data: { recipients: 5, scheduledAt: FUTURE } });
    get.mockImplementation((url: string) =>
      url === '/campaigns' ? Promise.resolve({ data: SCHEDULED_DRAFT }) : Promise.resolve({ data: [] }),
    );
  });

  it('shows "Schedule" copy (not "Launch now") in the confirm dialog and posts /launch on confirm', async () => {
    const user = userEvent.setup();
    render(<CampaignsPage />, { wrapper });

    const rowLaunch = await screen.findByRole('button', { name: /Launch/i });
    await user.click(rowLaunch);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Schedule this campaign\?/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Schedule/i }));
    expect(post).toHaveBeenCalledWith('/campaigns/c1/launch');
  });
});

// The "Send at" datetime-local picker gets a `min` of "now" (so the native
// control itself flags an obviously-past pick) and a live form-hint warning
// once a past time is actually entered — distinct from the future-scheduled
// confirm-dialog copy above, which only applies after Launch is clicked.
describe('CampaignsPage — schedule picker past-time warning', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockClear();
    get.mockImplementation((url: string) =>
      url === '/campaigns' ? Promise.resolve({ data: DRAFT }) : Promise.resolve({ data: [] }),
    );
  });

  it('sets min="now" (minute precision) and swaps the hint to a past-time warning once a past value is entered', async () => {
    const user = userEvent.setup();
    render(<CampaignsPage />, { wrapper });
    await user.click(await screen.findByRole('button', { name: 'New campaign' }));

    const input = (await screen.findByLabelText('Send at (optional)')) as HTMLInputElement;
    expect(input).toHaveAttribute('type', 'datetime-local');
    // Well-formed "YYYY-MM-DDTHH:mm", close to now — an exact-time assertion
    // would be flaky across the tick this test runs on.
    expect(input.min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(Math.abs(new Date(input.min).getTime() - Date.now())).toBeLessThan(60_000);

    expect(screen.getByText('Leave blank to send immediately when you launch.')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '2000-01-01T00:00' } });
    expect(
      await screen.findByText('This time is in the past — the campaign will be sent immediately.'),
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '2999-01-01T00:00' } });
    await waitFor(() =>
      expect(screen.getByText('Leave blank to send immediately when you launch.')).toBeInTheDocument(),
    );
  });
});

// A SCHEDULED campaign is still editable (reschedule/clear the send time) —
// the Edit button used to be DRAFT-only; it must now also show for SCHEDULED,
// and the row should surface when it's due.
describe('CampaignsPage — SCHEDULED campaign row', () => {
  const WHEN = new Date('2026-08-01T10:00:00Z').toISOString();
  const SCHEDULED_ROW = [{ id: 'c1', name: 'Promo', channel: 'SMS', status: 'SCHEDULED', stats: null, scheduledAt: WHEN }];

  beforeEach(() => {
    get.mockReset();
    post.mockClear();
    get.mockImplementation((url: string) =>
      url === '/campaigns' ? Promise.resolve({ data: SCHEDULED_ROW }) : Promise.resolve({ data: [] }),
    );
  });

  it('shows an Edit button and the scheduled time, and no Launch button', async () => {
    render(<CampaignsPage />, { wrapper });
    await screen.findByText('Promo');
    expect(screen.getByRole('button', { name: /Edit/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Launch$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Scheduled for/i)).toBeInTheDocument();
  });
});

describe('CampaignsPage — cancel scheduled send', () => {
  const SCHEDULED = [{ id: 'c1', name: 'Promo', channel: 'SMS', status: 'SCHEDULED', stats: null }];

  beforeEach(() => {
    get.mockReset();
    post.mockClear();
    get.mockImplementation((url: string) =>
      url === '/campaigns' ? Promise.resolve({ data: SCHEDULED }) : Promise.resolve({ data: [] }),
    );
  });

  it('confirms before cancelling — a single click does NOT cancel immediately', async () => {
    const user = userEvent.setup();
    render(<CampaignsPage />, { wrapper });

    const rowCancel = await screen.findByRole('button', { name: /Cancel scheduled send/i });
    await user.click(rowCancel);

    // No cancel call yet — the confirm dialog is shown instead of firing the mutation.
    expect(post).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Cancel send/i }));
    expect(post).toHaveBeenCalledWith('/campaigns/c1/cancel');
  });
});

// Regression: pause/resume on each SENDING campaign row was driven off a single
// shared `act` mutation's isPending, so pausing ONE campaign disabled the Pause
// button on EVERY other SENDING campaign too. Multiple campaigns send at once,
// so the per-row guard (act.variables?.id === c.id) must scope it to one row.
describe('CampaignsPage — per-row pause/resume loading (no cross-row bleed)', () => {
  const SENDING = [
    { id: 'c1', name: 'Alpha', channel: 'EMAIL', status: 'SENDING', stats: null },
    { id: 'c2', name: 'Beta', channel: 'EMAIL', status: 'SENDING', stats: null },
  ];

  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockImplementation((url: string) =>
      url === '/campaigns' ? Promise.resolve({ data: SENDING }) : Promise.resolve({ data: [] }),
    );
    // The pause call never resolves so the `act` mutation stays pending.
    post.mockImplementation((url: string) =>
      url.includes('/pause') ? new Promise(() => {}) : Promise.resolve({ data: {} }),
    );
  });

  it('pausing one campaign leaves the other campaign\'s Pause button clickable', async () => {
    const user = userEvent.setup();
    render(<CampaignsPage />, { wrapper });

    const pauseButtons = await screen.findAllByRole('button', { name: /pause/i });
    expect(pauseButtons).toHaveLength(2);

    await user.click(pauseButtons[0]);

    const after = screen.getAllByRole('button', { name: /pause/i });
    expect(after[0]).toBeDisabled();
    expect(after[1]).not.toBeDisabled();
  });
});

// SMS is its own feature (split off `conversationAi` for the NetGSM SMS v2
// program): the composer's channel picker must hide SMS when the workspace
// isn't entitled, instead of letting the create call 403 on submit.
describe('CampaignsPage — channel picker SMS gate', () => {
  const ONE = [{ id: 'c1', name: 'Promo', channel: 'EMAIL', status: 'DRAFT', stats: null }];

  function mockEntitlements(features: Record<string, boolean>) {
    get.mockImplementation((url: string) => {
      if (url === '/campaigns') return Promise.resolve({ data: ONE });
      if (url === '/billing/summary') {
        return Promise.resolve({ data: { entitlements: { features, entitledModules: [] } } });
      }
      return Promise.resolve({ data: [] });
    });
  }

  beforeEach(() => {
    get.mockReset();
    post.mockClear();
  });

  async function openChannelListbox(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'New campaign' }));
    const trigger = await screen.findByRole('combobox', { name: 'Channel' });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
  }

  it('hides the SMS option when the workspace lacks the sms feature', async () => {
    mockEntitlements({ sms: false });
    const user = userEvent.setup();
    render(<CampaignsPage />, { wrapper });
    await openChannelListbox(user);
    expect(screen.queryByRole('option', { name: 'SMS' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'EMAIL' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'WHATSAPP' })).toBeInTheDocument();
  });

  it('shows the SMS option when the workspace has the sms feature', async () => {
    mockEntitlements({ sms: true });
    const user = userEvent.setup();
    render(<CampaignsPage />, { wrapper });
    await openChannelListbox(user);
    expect(screen.getByRole('option', { name: 'SMS' })).toBeInTheDocument();
  });
});

// NetGSM Phase 5 Task 4 — VOICE is gated on its own `voiceCampaigns` feature,
// hidden from the channel picker exactly like SMS is gated on `sms`.
describe('CampaignsPage — channel picker VOICE gate', () => {
  const ONE = [{ id: 'c1', name: 'Promo', channel: 'EMAIL', status: 'DRAFT', stats: null }];

  function mockEntitlements(features: Record<string, boolean>) {
    get.mockImplementation((url: string) => {
      if (url === '/campaigns') return Promise.resolve({ data: ONE });
      if (url === '/billing/summary') {
        return Promise.resolve({ data: { entitlements: { features, entitledModules: [] } } });
      }
      return Promise.resolve({ data: [] });
    });
  }

  beforeEach(() => {
    get.mockReset();
    post.mockClear();
  });

  async function openChannelListbox(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'New campaign' }));
    const trigger = await screen.findByRole('combobox', { name: 'Channel' });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
  }

  it('hides the VOICE option when the workspace lacks the voiceCampaigns feature', async () => {
    mockEntitlements({ sms: true, voiceCampaigns: false });
    const user = userEvent.setup();
    render(<CampaignsPage />, { wrapper });
    await openChannelListbox(user);
    expect(screen.queryByRole('option', { name: 'VOICE' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'EMAIL' })).toBeInTheDocument();
  });

  it('shows the VOICE option when the workspace has the voiceCampaigns feature', async () => {
    mockEntitlements({ sms: true, voiceCampaigns: true });
    const user = userEvent.setup();
    render(<CampaignsPage />, { wrapper });
    await openChannelListbox(user);
    expect(screen.getByRole('option', { name: 'VOICE' })).toBeInTheDocument();
  });
});

// NetGSM Phase 5 Task 4 — the VOICE composer: TTS/audio-upload toggle, the
// keypress→note mapping editor, and the reused İYS TİCARİ/BİLGİLENDİRME
// selector, plus that submit builds voiceConfig (msg XOR audioid + keys).
describe('CampaignsPage — VOICE composer', () => {
  // Non-empty (mirrors every other describe block in this file) — an empty
  // list renders EmptyState's OWN "New campaign" button too, colliding with
  // PageHeader's, so `findByRole('button', { name: 'New campaign' })` would
  // otherwise match two elements.
  const ONE = [{ id: 'c1', name: 'Existing', channel: 'EMAIL', status: 'DRAFT', stats: null }];

  beforeEach(() => {
    get.mockReset();
    post.mockClear();
    post.mockResolvedValue({ data: { recipients: 0 } });
    get.mockImplementation((url: string) => {
      if (url === '/campaigns') return Promise.resolve({ data: ONE });
      if (url === '/billing/summary') {
        return Promise.resolve({
          data: { entitlements: { features: { sms: true, voiceCampaigns: true }, entitledModules: [] } },
        });
      }
      return Promise.resolve({ data: [] });
    });
  });

  async function openVoiceComposer(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'New campaign' }));
    const trigger = await screen.findByRole('combobox', { name: 'Channel' });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
    await user.click(screen.getByRole('option', { name: 'VOICE' }));
  }

  it('renders the TTS text field, the İYS selector, and the keypress editor by default', async () => {
    const user = userEvent.setup();
    render(<CampaignsPage />, { wrapper });
    await openVoiceComposer(user);

    expect(await screen.findByLabelText(/^Spoken text \(TTS\)/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'İYS message type' })).toBeInTheDocument();
    expect(screen.getByText('Keypress actions (press-N)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upload \.wav/i })).not.toBeInTheDocument();
  });

  it('switches to the audio-upload mode and hides the TTS field', async () => {
    const user = userEvent.setup();
    render(<CampaignsPage />, { wrapper });
    await openVoiceComposer(user);

    await user.click(await screen.findByRole('combobox', { name: 'Voice message type' }));
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
    await user.click(screen.getByRole('option', { name: 'Upload audio file' }));

    expect(screen.queryByLabelText('Spoken text (TTS)')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Upload \.wav/i })).toBeInTheDocument();
  });

  it('adds a keypress mapping row (digit + note)', async () => {
    const user = userEvent.setup();
    render(<CampaignsPage />, { wrapper });
    await openVoiceComposer(user);

    await user.click(await screen.findByRole('button', { name: /Add keypress mapping/i }));
    const note = await screen.findByPlaceholderText(/Note \(optional\)/i);
    await user.type(note, 'Interested — connect to sales');
    expect(note).toHaveValue('Interested — connect to sales');
  });

  it('blocks submit when neither TTS text nor an uploaded audioid is set', async () => {
    const user = userEvent.setup();
    render(<CampaignsPage />, { wrapper });
    await openVoiceComposer(user);

    await user.type(await screen.findByLabelText(/^Name/), 'Voice blast');
    await user.type(await screen.findByLabelText(/^Internal label/), 'internal note');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(post).not.toHaveBeenCalled();
  });

  it('builds voiceConfig (msg + keys) and posts it on submit', async () => {
    const user = userEvent.setup();
    render(<CampaignsPage />, { wrapper });
    await openVoiceComposer(user);

    await user.type(await screen.findByLabelText(/^Name/), 'Voice blast');
    await user.type(await screen.findByLabelText(/^Internal label/), 'internal note');
    await user.type(await screen.findByLabelText(/^Spoken text \(TTS\)/), 'Hello, this is a reminder call.');
    await user.click(await screen.findByRole('button', { name: /Add keypress mapping/i }));

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/campaigns', expect.objectContaining({
      channel: 'VOICE',
      voiceConfig: expect.objectContaining({
        msg: 'Hello, this is a reminder call.',
        keys: ['1'],
      }),
    })));
  });
});
