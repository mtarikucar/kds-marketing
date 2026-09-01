import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import CallsPage from './CallsPage';

const getMock = vi.fn();
vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => getMock(...args),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

// Selector-aware, and mutable: the voice tab carries a role of its own
// (`/voice` is `managerOnly` in navigation.ts), and `RoleGate` reads the store
// through a selector while `CallsTab` reads it whole.
const auth = vi.hoisted(() => ({ role: 'OWNER' }));
vi.mock('../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel?: (s: unknown) => unknown) => {
    const state = { user: { workspaceId: 'ws-1', role: auth.role, id: 'u-1' } };
    return sel ? sel(state) : state;
  },
}));

// t(key, 'English default') → the default, so tab labels are assertable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: unknown) => (typeof o === 'string' ? o : k), i18n: { language: 'en' } }),
}));

// Stub the lazy-embedded dialer so the host shell renders in isolation.
vi.mock('./DialerPage', () => ({ default: () => <div>dialer-stub</div> }));
vi.mock('./VoicePage', () => ({ default: () => <div>voice-stub</div> }));

const testClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderAt(path = '/', qc: QueryClient = testClient()) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <CallsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CallsPage repro', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.role = 'OWNER';
    getMock.mockImplementation((url: string) => {
      if (url === '/calls')
        return Promise.resolve({ data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } } });
      if (url === '/users') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: {} });
    });
  });

  it('mounts without crashing (empty)', async () => {
    renderAt();
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders a populated call row without crashing', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/calls')
        return Promise.resolve({
          data: {
            data: [
              {
                id: 'c1',
                toPhone: '+905551112233',
                status: 'CONNECTED',
                durationSec: 95,
                marketingUserId: 'u-1',
                startedAt: new Date('2026-06-21T10:00:00Z').toISOString(),
                notes: 'hello',
              },
            ],
            meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
          },
        });
      if (url === '/users')
        return Promise.resolve({ data: [{ id: 'u-1', firstName: 'A', lastName: 'B', role: 'REP' }] });
      return Promise.resolve({ data: {} });
    });
    renderAt();
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders the Calls and Power Dialer tabs (calls active by default)', async () => {
    renderAt();
    expect(screen.getByRole('tab', { name: 'Calls' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('tab', { name: 'Power Dialer' })).toHaveAttribute('data-state', 'inactive');
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('honors the ?tab=dialer deep link (dialer tab selected, dialer body shown)', async () => {
    renderAt('/?tab=dialer');
    expect(screen.getByRole('tab', { name: 'Power Dialer' })).toHaveAttribute('data-state', 'active');
    // Lazy-loaded, so wait for the stubbed dialer body to appear.
    expect(await screen.findByText('dialer-stub')).toBeInTheDocument();
  });

  it('falls back to the calls tab on an unknown ?tab= value', () => {
    renderAt('/?tab=nope');
    expect(screen.getByRole('tab', { name: 'Calls' })).toHaveAttribute('data-state', 'active');
  });

  // ── NetGSM Phase 4 Task 4: queue wallboard gating ──────────────────────────

  it('hides the queue wallboard for a workspace not entitled to telephony (default /billing/summary mock)', async () => {
    renderAt();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText('Queue wallboard')).not.toBeInTheDocument();
  });

  it('shows the queue wallboard for a telephony-entitled workspace', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/calls')
        return Promise.resolve({ data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } } });
      if (url === '/users') return Promise.resolve({ data: [] });
      if (url === '/billing/summary')
        return Promise.resolve({ data: { entitlements: { features: { telephony: true } } } });
      if (url === '/telephony/queues/stats') return Promise.resolve({ data: { queues: [] } });
      return Promise.resolve({ data: {} });
    });
    renderAt();
    expect(await screen.findByText('Queue wallboard')).toBeInTheDocument();
  });
});

/**
 * `/voice` merged in as a third tab.
 *
 * It is a route whose whole subject is calls — the ones the AI answered — and
 * reading it meant leaving the call log for a settings-area page. Merging it in
 * may not be a permission change, so navigation.ts's pair travels with it
 * verbatim: `feature: 'voiceAi'` AND `managerOnly`, mirroring VoiceAiController.
 */
describe('CallsPage — the merged voice tab', () => {
  const entitled = (features: Record<string, boolean>) => {
    getMock.mockImplementation((url: string) => {
      if (url === '/calls')
        return Promise.resolve({
          data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } },
        });
      if (url === '/users') return Promise.resolve({ data: [] });
      if (url === '/billing/summary')
        return Promise.resolve({ data: { entitlements: { features } } });
      if (url === '/telephony/queues/stats') return Promise.resolve({ data: { queues: [] } });
      return Promise.resolve({ data: {} });
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    auth.role = 'OWNER';
  });

  it('offers the tab to an entitled manager, and mounts the page on it', async () => {
    const user = userEvent.setup();
    auth.role = 'MANAGER';
    entitled({ voiceAi: true });
    renderAt();

    await user.click(await screen.findByRole('tab', { name: 'Yapay zekâ görüşmeleri' }));
    expect(await screen.findByText('voice-stub')).toBeInTheDocument();
  });

  /**
   * Both absence tests wait for the WALLBOARD first, and that is load-bearing
   * rather than belt-and-braces. `useEntitlements` resolves asynchronously and
   * fails CLOSED, so asserting "the tab is not there" on the first paint passes
   * for every workspace alive — including one whose gate has been deleted. The
   * wallboard is the same query's other consumer: once it is on screen,
   * `/billing/summary` has answered and the absence below is a decision.
   */
  it('withholds it from a workspace whose plan has no voiceAi', async () => {
    auth.role = 'MANAGER';
    entitled({ telephony: true, voiceAi: false });
    renderAt();

    await screen.findByText('Queue wallboard');
    // Positive anchor: the other two tabs are there, so this is about the gate.
    expect(screen.getByRole('tab', { name: 'Calls' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Power Dialer' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Yapay zekâ görüşmeleri' })).not.toBeInTheDocument();
  });

  it('withholds it from a REP even in an entitled workspace', async () => {
    auth.role = 'REP';
    entitled({ telephony: true, voiceAi: true });
    renderAt();

    await screen.findByText('Queue wallboard');
    expect(screen.getByRole('tab', { name: 'Calls' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Yapay zekâ görüşmeleri' })).not.toBeInTheDocument();
  });

  /**
   * The URL is the door, not the tab strip. `?tab=voice` is typeable, so the
   * BODY carries the same pair as the trigger — a REP who bookmarked it gets
   * nothing, not the page the tab strip declined to offer them.
   */
  it('refuses a REP the body too, not only the trigger', async () => {
    entitled({ voiceAi: true });
    // ONE QueryClient across both renders: `useEntitlements` fails closed while
    // `/billing/summary` is in flight, so a cold second render would answer
    // "not entitled" for a beat and the REP assertion below would pass for a
    // workspace with no gate at all. The manager render above warms it.
    const qc = testClient();

    auth.role = 'MANAGER';
    const managerView = renderAt('/?tab=voice', qc);
    // The control: the deep link really does mount the page for someone allowed
    // to see it, so the absence below is about the role and nothing else.
    expect(await screen.findByText('voice-stub')).toBeInTheDocument();
    managerView.unmount();

    auth.role = 'REP';
    renderAt('/?tab=voice', qc);
    await screen.findByRole('tab', { name: 'Calls' });
    expect(screen.queryByText('voice-stub')).not.toBeInTheDocument();
  });
});
