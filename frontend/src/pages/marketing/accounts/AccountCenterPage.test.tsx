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
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string } | string) =>
      (typeof o === 'string' ? o : o?.defaultValue) ?? k,
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
