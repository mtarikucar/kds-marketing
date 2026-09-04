import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AccountCenterPage from './AccountCenterPage';

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('../../../lib/navigateExternal', () => ({ navigateExternal: vi.fn() }));
// The Integrations tab hosts these pages/blocks; stub them so the Account Center
// shell renders in isolation (they have their own tests).
vi.mock('../settings/connections/ConnectionsPage', () => ({
  default: ({ embedded }: { embedded?: boolean }) => <div>connections-embedded:{String(!!embedded)}</div>,
}));
vi.mock('../settings/connections/SsoTab', () => ({ SsoTab: () => <div>sso-stub</div> }));
vi.mock('../settings/connections/SlackTab', () => ({ SlackTab: () => <div>slack-stub</div> }));
// Interpolates, unlike a bare default-value mock. The page's summary line is
// built from counts, and asserting on a literal `{{count}}` would pass while
// the person reads a template.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown> | string) => {
      const base = typeof o === 'string' ? o : ((o?.defaultValue as string) ?? k);
      const vars = typeof o === 'string' ? {} : (o ?? {});
      return base.replace(/\{\{(\w+)\}\}/g, (_m, name) => String((vars as any)[name] ?? ''));
    },
    i18n: { language: 'en' },
  }),
}));

const PAYLOAD = {
  secretBoxConfigured: true,
  features: { conversationAi: true },
  networkStatus: { FACEBOOK: true },
  providers: [
    {
      provider: 'META',
      displayName: 'Meta — Facebook, Instagram, WhatsApp & Ads',
      connectMethod: 'OAUTH',
      configured: true,
      connections: [
        {
          identityKey: 'META:P1',
          externalId: 'P1',
          displayName: 'Acme Clinic',
          connectedVia: 'OAUTH',
          capabilities: ['PUBLISH', 'INBOX'],
          health: 'HEALTHY',
          sources: [],
        },
      ],
    },
    { provider: 'LINKEDIN', displayName: 'LinkedIn', connectMethod: 'OAUTH', configured: false, connections: [] },
    { provider: 'SMS', displayName: 'SMS (NetGSM)', connectMethod: 'MANUAL', configured: true, connections: [] },
  ],
};

function wrap(path = '/accounts') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AccountCenterPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AccountCenterPage', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const api = (await import('../../../features/marketing/api/marketingApi')).default as any;
    api.get.mockResolvedValue({ data: PAYLOAD });
  });

  it('renders a connected Meta identity with its capability badges', async () => {
    wrap();
    expect(await screen.findByText('Acme Clinic')).toBeInTheDocument();
    expect(screen.getByText('Publishing')).toBeInTheDocument();
    expect(screen.getByText('Inbox')).toBeInTheDocument();
  });

  it('disables the connect button for an unconfigured OAuth provider', async () => {
    wrap();
    await screen.findByText('Acme Clinic');
    const connectButtons = screen.getAllByRole('button', { name: /Connect/i });
    // LinkedIn is configured:false → at least one Connect button is disabled.
    expect(connectButtons.some((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  // A disabled control that does not say why is indistinguishable from a broken
  // one. The reason lived only in a `title` tooltip: invisible on touch, to a
  // keyboard user, and to anyone who does not think to hover a dead button.
  it('says WHY an unconfigured provider cannot be connected, in visible text', async () => {
    wrap();
    await screen.findByText('Acme Clinic');
    expect(screen.getByText(/app credentials/i)).toBeInTheDocument();
  });

  it('does not nag about credentials on a configured provider', async () => {
    const api = (await import('../../../features/marketing/api/marketingApi')).default as any;
    api.get.mockResolvedValue({
      data: { ...PAYLOAD, providers: PAYLOAD.providers.filter((p) => p.provider !== 'LINKEDIN') },
    });
    wrap();
    await screen.findByText('Acme Clinic');
    expect(screen.queryByText(/app credentials/i)).toBeNull();
  });

  it('renders the Accounts | Integrations tab bar with Accounts active by default', async () => {
    wrap();
    expect(screen.getByRole('tab', { name: 'Accounts' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('tab', { name: 'Integrations' })).toBeInTheDocument();
    // The default tab shows the OAuth provider grid.
    expect(await screen.findByText('Acme Clinic')).toBeInTheDocument();
    expect(screen.queryByText('sso-stub')).toBeNull();
  });

  it('honors the ?tab=integrations deep link (calendars + SSO/Slack, no provider grid)', async () => {
    wrap('/accounts?tab=integrations');
    expect(screen.getByRole('tab', { name: 'Integrations' })).toHaveAttribute('data-state', 'active');
    // The absorbed Settings › Connections page renders embedded (host owns the header)…
    expect(await screen.findByText('connections-embedded:true')).toBeInTheDocument();
    // …alongside the company SSO/Slack blocks.
    expect(screen.getByText('sso-stub')).toBeInTheDocument();
    expect(screen.getByText('slack-stub')).toBeInTheDocument();
    // The accounts body is not mounted on this tab.
    expect(screen.queryByText('Acme Clinic')).toBeNull();
  });

  it('falls back to the Accounts tab on an unknown ?tab= value', async () => {
    wrap('/accounts?tab=bogus');
    expect(screen.getByRole('tab', { name: 'Accounts' })).toHaveAttribute('data-state', 'active');
    expect(await screen.findByText('Acme Clinic')).toBeInTheDocument();
  });

  it('switches to Integrations on click (lazy content loads)', async () => {
    const user = userEvent.setup();
    wrap();
    await screen.findByText('Acme Clinic');
    await user.click(screen.getByRole('tab', { name: 'Integrations' }));
    expect(await screen.findByText('connections-embedded:true')).toBeInTheDocument();
  });

  it('sets up a manual channel (SMS) inline — no navigation away', async () => {
    const user = userEvent.setup();
    wrap();
    await screen.findByText('Acme Clinic');
    // Only the manual SMS provider shows a "Set up" button; clicking it opens the
    // inline dialog on THIS page rather than routing to /channels.
    // The first "Set up" is the SMS card (the Telephony card also has one).
    await user.click(screen.getAllByRole('button', { name: /Set up/i })[0]);
    // The inline NetGSM setup dialog opens (its fields prove we didn't navigate).
    expect(await screen.findByPlaceholderText(/NetGSM usercode/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/NetGSM password/i)).toBeInTheDocument();
  });
});

/**
 * WhatsApp Business connect.
 *
 * `WhatsappSignupButton` was fully implemented but imported by NOTHING, so
 * Embedded Signup — the only path that puts a REAL business number on Cloud
 * API — was unreachable from the product. A workspace could therefore never
 * move off whatever Meta test number the app was created with, and no test
 * noticed because every test targeted the component in isolation.
 *
 * These assert the mount, not the button's internals (it has its own tests):
 * the regression to prevent is the card silently disappearing from the page.
 */
describe('AccountCenterPage — WhatsApp connect', () => {
  const entitled = (features: Record<string, boolean>) => ({
    ...PAYLOAD,
    entitlements: { features },
  });

  beforeEach(() => vi.clearAllMocks());

  it('offers WhatsApp connect when the workspace is entitled to conversationAi', async () => {
    const api = (await import('../../../features/marketing/api/marketingApi')).default as any;
    api.get.mockResolvedValue({ data: entitled({ conversationAi: true }) });

    wrap();

    expect(await screen.findByText('WhatsApp Business')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Connect WhatsApp/i })).toBeInTheDocument();
  });

  it('explains that a Meta test number is not usable with real customers', async () => {
    const api = (await import('../../../features/marketing/api/marketingApi')).default as any;
    api.get.mockResolvedValue({ data: entitled({ conversationAi: true }) });

    wrap();

    // The whole reason a tenant goes looking for this flow.
    expect(await screen.findByText(/test number can only message/i)).toBeInTheDocument();
  });

  it('hides it from a workspace without conversationAi', async () => {
    const api = (await import('../../../features/marketing/api/marketingApi')).default as any;
    api.get.mockResolvedValue({ data: entitled({ conversationAi: false }) });

    wrap();

    await screen.findByText('Acme Clinic');
    expect(screen.queryByText('WhatsApp Business')).toBeNull();
  });
});

/**
 * ARRANGED BY WHAT THE READER NEEDS.
 *
 * This page was one flat grid of every provider, connected and not, in a fixed
 * order. Two things it could not tell you — and both are why somebody opens a
 * connections page: whether anything is BROKEN, and what connecting the rest
 * would buy. An account whose session had been invalidated, which is the exact
 * state that silently loses posts, looked identical to a working one until you
 * read every card.
 */
describe('AccountCenterPage — the shape of the page', () => {
  const broken = {
    ...PAYLOAD,
    providers: [
      {
        provider: 'META',
        displayName: 'Meta — Facebook, Instagram, WhatsApp & Ads',
        connectMethod: 'OAUTH',
        configured: true,
        connections: [
          {
            identityKey: 'META:P1', externalId: 'P1', displayName: 'Acme Clinic',
            connectedVia: 'OAUTH', capabilities: ['PUBLISH'], health: 'REAUTH_REQUIRED', sources: [],
          },
        ],
      },
      {
        provider: 'LINKEDIN', displayName: 'LinkedIn', connectMethod: 'OAUTH', configured: true,
        connections: [
          {
            identityKey: 'LI:1', externalId: '1', displayName: 'Acme on LinkedIn',
            connectedVia: 'OAUTH', capabilities: ['PUBLISH'], health: 'HEALTHY', sources: [],
          },
        ],
      },
      { provider: 'TIKTOK', displayName: 'TikTok', connectMethod: 'OAUTH', configured: true, connections: [] },
    ],
  };

  async function withPayload(payload: unknown) {
    const api = (await import('../../../features/marketing/api/marketingApi')).default as any;
    api.get.mockResolvedValue({ data: payload });
    return wrap();
  }

  it('says whether anything is broken BEFORE any card has to be read', async () => {
    await withPayload(broken);
    expect(await screen.findByText(/1 of your 2 connected accounts is not working/i)).toBeInTheDocument();
  });

  it('says so plainly when nothing is broken', async () => {
    await withPayload(PAYLOAD);
    expect(await screen.findByText(/All 1 connected accounts are working/i)).toBeInTheDocument();
  });

  it('puts what needs you first, then what works, then what is available', async () => {
    await withPayload(broken);
    await screen.findByText('Acme Clinic');

    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent)
      .filter((x): x is string => !!x);
    expect(headings.slice(0, 3)).toEqual([
      'Needs your attention',
      'Connected and working',
      'Not connected yet',
    ]);
  });

  it('does not offer an attention section when there is nothing wrong', async () => {
    // A permanent red heading is a heading people stop reading.
    await withPayload(PAYLOAD);
    await screen.findByText('Acme Clinic');
    expect(screen.queryByRole('heading', { name: 'Needs your attention' })).not.toBeInTheDocument();
  });

  it('tells an unconnected provider what it would ADD, not that it is absent', async () => {
    // "Not connected" answers a question nobody asked. The one somebody arrives
    // with is "do I need this?".
    await withPayload(broken);
    expect(await screen.findByText(/Publish to TikTok/i)).toBeInTheDocument();
  });

  describe('the second tab, sorted by who it affects', () => {
    it('separates your own calendar from what changes for the whole team', async () => {
      // Three unrelated things used to live here under one word, and one of them
      // changes how everybody signs in.
      const user = userEvent.setup();
      await withPayload(PAYLOAD);
      await user.click(await screen.findByRole('tab', { name: /Integrations/i }));

      expect(await screen.findByRole('heading', { name: 'Only you' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Everyone in this workspace' })).toBeInTheDocument();
      expect(screen.getByText(/Changing these changes it for everybody/i)).toBeInTheDocument();
    });
  });
});
