import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import StrategyConsolePage from './StrategyConsolePage';
import * as svc from '../../../features/marketing/api/strategy.service';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string } | string) =>
      typeof o === 'string' ? o : (o?.defaultValue ?? k),
  }),
}));
vi.mock('../../../features/marketing/api/strategy.service', () => ({
  getStrategy: vi.fn(),
  listStrategyActions: vi.fn(),
  approveAction: vi.fn(),
  dismissAction: vi.fn(),
  setStrategyAutonomy: vi.fn(),
  listCommunityChannels: vi.fn(),
  connectDiscord: vi.fn(),
  getRedditAuthorizeUrl: vi.fn(),
  disconnectCommunityChannel: vi.fn(),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <StrategyConsolePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const STRATEGY = {
  id: 'st1',
  archetype: 'CHALLENGER',
  autonomyLevel: 'ASSISTED' as const,
  status: 'ACTIVE' as const,
  version: 1,
  brief: {
    identity: { product: 'CRM for clinics', voice: 'Confident', positioning: 'The fastest clinic CRM', usp: 'Setup in a day' },
    audience: 'Dental clinic owners',
    channels: [{ key: 'INSTAGRAM', fitScore: 82, rationale: 'Visual before/after content performs.' }],
    contentPillars: [{ title: 'Patient stories', angle: 'Social proof', formats: ['Reel'], tone: 'Warm' }],
    goals: { objective: 'Book 50 demos/mo', kpis: ['CAC', 'MQLs'] },
    budget: '$3,000/mo',
    competitors: ['Acme'],
  },
};

describe('StrategyConsolePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (svc.listCommunityChannels as any).mockResolvedValue([]);
  });

  it('shows the onboarding CTA when no strategy exists', async () => {
    (svc.getStrategy as any).mockResolvedValue(null);
    renderPage();
    expect(await screen.findByText('No strategy yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /build my strategy/i })).toBeInTheDocument();
  });

  it('renders the brief, archetype and the proposed action queue', async () => {
    (svc.getStrategy as any).mockResolvedValue(STRATEGY);
    (svc.listStrategyActions as any).mockResolvedValue([
      { id: 'a1', kind: 'CONTENT', title: 'Launch a weekly Reel series', rationale: 'Fills the top of funnel', payload: {}, priority: 1, status: 'PROPOSED' },
    ]);
    renderPage();
    expect(await screen.findByText('CHALLENGER')).toBeInTheDocument();
    expect(screen.getByText('Dental clinic owners')).toBeInTheDocument();
    expect(screen.getByText('INSTAGRAM')).toBeInTheDocument();
    expect(await screen.findByText('Launch a weekly Reel series')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  it('renders the community channels card with connect affordances when none connected', async () => {
    (svc.getStrategy as any).mockResolvedValue(STRATEGY);
    (svc.listStrategyActions as any).mockResolvedValue([]);
    (svc.listCommunityChannels as any).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('Community channels')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect reddit/i })).toBeInTheDocument();
    // Discord webhook input is shown when not connected.
    expect(screen.getByLabelText(/discord webhook url/i)).toBeInTheDocument();
  });

  it('shows the connected reddit handle + a disconnect button when connected', async () => {
    (svc.getStrategy as any).mockResolvedValue(STRATEGY);
    (svc.listStrategyActions as any).mockResolvedValue([]);
    (svc.listCommunityChannels as any).mockResolvedValue([
      { provider: 'REDDIT', status: 'CONNECTED', meta: { username: 'acme' } },
    ]);
    renderPage();
    expect(await screen.findByText('u/acme')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /disconnect/i }).length).toBeGreaterThan(0);
  });
});
