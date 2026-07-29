import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import McpConsentPage from './McpConsentPage';
import * as svc from '../../../features/marketing/api/mcpOAuth.service';
import { navigateExternal } from '../../../lib/navigateExternal';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../lib/navigateExternal', () => ({ navigateExternal: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string } | string) =>
      typeof o === 'string' ? o : (o?.defaultValue ?? k),
  }),
}));
vi.mock('../../../features/marketing/api/mcpOAuth.service', () => ({
  getMcpConsentData: vi.fn(),
  submitMcpConsent: vi.fn(),
}));

/** The query string Claude.ai would hand us, verbatim. */
const QUERY =
  '?response_type=code' +
  '&client_id=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fclient' +
  '&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fcallback' +
  '&scope=leads.read+tasks.write' +
  '&state=st-42' +
  '&code_challenge=abc' +
  '&code_challenge_method=S256' +
  '&resource=https%3A%2F%2Fjeeta.example.com%2Fapi%2Fmcp';

const CONSENT: svc.McpConsentData = {
  client: {
    clientId: 'https://claude.ai/api/mcp/client',
    clientName: 'Claude',
    logoUri: null,
  },
  requestedScopes: ['leads.read', 'tasks.write'],
  resource: 'https://jeeta.example.com/api/mcp',
  redirectUri: 'https://claude.ai/api/mcp/callback',
  state: 'st-42',
  workspaces: [
    {
      workspaceId: 'ws-other',
      workspaceName: 'Side Project',
      role: 'OWNER',
      grantableScopes: ['leads.read', 'tasks.write'],
    },
    {
      workspaceId: 'ws-active',
      workspaceName: 'Acme Clinic',
      role: 'MANAGER',
      grantableScopes: ['leads.read', 'tasks.write'],
    },
  ],
};

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/oauth/consent${QUERY}`]}>
        <McpConsentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('McpConsentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (svc.getMcpConsentData as any).mockResolvedValue(CONSENT);
    (svc.submitMcpConsent as any).mockResolvedValue({
      redirect_to: 'https://claude.ai/api/mcp/callback?code=c1&state=st-42&iss=https://jeeta.example.com',
    });
    useMarketingAuthStore.setState({
      user: {
        id: 'u1',
        workspaceId: 'ws-active',
        email: 'a@b.c',
        firstName: 'A',
        lastName: 'B',
        role: 'MANAGER',
      },
      isAuthenticated: true,
    } as any);
  });

  it('sends the authorize query verbatim to the consent endpoint', async () => {
    renderPage();
    await waitFor(() => expect(svc.getMcpConsentData).toHaveBeenCalled());
    expect((svc.getMcpConsentData as any).mock.calls[0][0]).toEqual({
      response_type: 'code',
      client_id: 'https://claude.ai/api/mcp/client',
      redirect_uri: 'https://claude.ai/api/mcp/callback',
      scope: 'leads.read tasks.write',
      state: 'st-42',
      code_challenge: 'abc',
      code_challenge_method: 'S256',
      resource: 'https://jeeta.example.com/api/mcp',
    });
  });

  it('names the client asking for access', async () => {
    renderPage();
    expect(await screen.findByText(/Claude/)).toBeInTheDocument();
  });

  it('renders each requested scope as a human-readable label, not a raw id', async () => {
    renderPage();
    expect(await screen.findByText('Read your leads')).toBeInTheDocument();
    expect(screen.getByText('Create and update your tasks')).toBeInTheDocument();
    expect(screen.queryByText('leads.read')).not.toBeInTheDocument();
  });

  it('offers only the workspaces the API returned, defaulting to the active one', async () => {
    renderPage();
    await screen.findByText('Acme Clinic');
    expect(screen.getByText('Side Project')).toBeInTheDocument();
    // Not a member of this one — the API never returned it, so it must not appear.
    expect(screen.queryByText('Someone Else Ltd')).not.toBeInTheDocument();

    const active = screen.getByRole('radio', { name: /Acme Clinic/ });
    expect(active).toHaveAttribute('aria-checked', 'true');
  });

  it('Allow posts the chosen workspace + granted scopes, then follows redirect_to', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Acme Clinic');

    await user.click(screen.getByRole('radio', { name: /Side Project/ }));
    await user.click(screen.getByRole('button', { name: /Allow/i }));

    await waitFor(() => expect(svc.submitMcpConsent).toHaveBeenCalled());
    const [params, body] = (svc.submitMcpConsent as any).mock.calls[0];
    expect(params.client_id).toBe('https://claude.ai/api/mcp/client');
    expect(params.code_challenge).toBe('abc');
    expect(body).toEqual({
      workspace_id: 'ws-other',
      granted_scopes: ['leads.read', 'tasks.write'],
    });
    await waitFor(() =>
      expect(navigateExternal).toHaveBeenCalledWith(
        'https://claude.ai/api/mcp/callback?code=c1&state=st-42&iss=https://jeeta.example.com',
      ),
    );
  });

  it('grants only the scopes the chosen workspace actually allows', async () => {
    (svc.getMcpConsentData as any).mockResolvedValue({
      ...CONSENT,
      workspaces: [
        {
          workspaceId: 'ws-active',
          workspaceName: 'Acme Clinic',
          role: 'REP',
          grantableScopes: ['leads.read'],
        },
      ],
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Acme Clinic');

    await user.click(screen.getByRole('button', { name: /Allow/i }));

    await waitFor(() => expect(svc.submitMcpConsent).toHaveBeenCalled());
    expect((svc.submitMcpConsent as any).mock.calls[0][1]).toEqual({
      workspace_id: 'ws-active',
      granted_scopes: ['leads.read'],
    });
  });

  it('Deny returns to the client redirect_uri with error=access_denied and the original state', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Acme Clinic');

    await user.click(screen.getByRole('button', { name: /Deny/i }));

    expect(svc.submitMcpConsent).not.toHaveBeenCalled();
    const target = new URL((navigateExternal as any).mock.calls[0][0]);
    expect(target.origin + target.pathname).toBe('https://claude.ai/api/mcp/callback');
    expect(target.searchParams.get('error')).toBe('access_denied');
    expect(target.searchParams.get('state')).toBe('st-42');
  });

  it('refuses to consent when the caller can grant nothing in any workspace', async () => {
    (svc.getMcpConsentData as any).mockResolvedValue({
      ...CONSENT,
      workspaces: [
        {
          workspaceId: 'ws-active',
          workspaceName: 'Acme Clinic',
          role: 'REP',
          grantableScopes: [],
        },
      ],
    });
    renderPage();
    await screen.findByText('Acme Clinic');
    expect(await screen.findByRole('button', { name: /Allow/i })).toBeDisabled();
  });

  it('surfaces a rejected authorization request instead of a blank screen', async () => {
    (svc.getMcpConsentData as any).mockRejectedValue({
      response: { data: { error_description: 'code_challenge is required (PKCE)' } },
    });
    renderPage();
    expect(await screen.findByText(/code_challenge is required/)).toBeInTheDocument();
  });
});
