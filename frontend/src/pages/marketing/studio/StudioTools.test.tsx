import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useMarketingAuthStore } from '@/store/marketingAuthStore';
import BudgetAutopilotPage from '../budget/BudgetAutopilotPage';
import { AutopilotStatusBar } from './AutopilotStatusBar';
import { StudioToolsDrawer, type StudioTool } from './StudioToolsDrawer';
import * as svc from '../../../features/marketing/api/growthBudget.service';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

/**
 * `t(key, default)` returns the default — the inline Turkish string is what
 * actually renders in the console, so it is what the assertions hold. The
 * interpolation branch is here because the surfaces under test share a tree
 * with BudgetAutopilotPage, which does use `t(key, default, vars)`; without it
 * those lines would render raw `{{placeholders}}` and a future assertion on one
 * of them would fail for a reason that has nothing to do with the code.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: unknown, opts?: Record<string, unknown>) => {
      const base =
        typeof def === 'string' ? def : ((def as { defaultValue?: string } | undefined)?.defaultValue ?? key);
      const vars = (typeof def === 'object' && def !== null ? def : opts) as
        | Record<string, unknown>
        | undefined;
      return vars
        ? base.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(vars[k] ?? `{{${k}}}`))
        : base;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../features/marketing/api/growthBudget.service', async () => {
  // isMcpApprovalPayload is a real pure function ApprovalQueue relies on to
  // route an approval; keep it, stub only the network calls.
  const actual = await vi.importActual<typeof import('../../../features/marketing/api/growthBudget.service')>(
    '../../../features/marketing/api/growthBudget.service',
  );
  return {
    ...actual,
    listGrowthBudgets: vi.fn(),
    getGrowthBudget: vi.fn(),
    getWalletState: vi.fn(),
    listBudgetActivity: vi.fn(),
    listAutopilotRuns: vi.fn().mockResolvedValue([]),
    listPendingApprovals: vi.fn().mockResolvedValue([]),
    approveRequest: vi.fn(),
    rejectRequest: vi.fn(),
    applyRequest: vi.fn(),
    applyReallocation: vi.fn(),
    setBudgetKillSwitch: vi.fn(),
    setBudgetStatus: vi.fn(),
    setAutonomyLevel: vi.fn(),
    setContentAutoPublish: vi.fn(),
    proposeBudget: vi.fn(),
    upsertGrowthBudget: vi.fn(),
    quickStart: vi.fn(),
    walletTopup: vi.fn(),
  };
});

// Entitled to everything: the gate itself is covered by access-gates.test.tsx,
// and an un-entitled workspace would replace the AI Studio with the upgrade
// callout, which is not what these tests are about.
vi.mock('@/features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({ isLoading: false, isError: false, features: {}, entitledModules: [], has: () => true }),
}));

// The three tools that are NOT the Autopilot are stubbed: each drags in a whole
// page (a month calendar, the media generator, the OAuth connection matrix) and
// what is under test is which ONE of them the drawer mounts. The Autopilot
// console is deliberately left real — the drawer has to prove it renders the
// actual console, with approvals suppressed.
vi.mock('./StudioCalendarTab', () => ({ default: () => <div>calendar-tool</div> }));
vi.mock('../social/AiStudioPage', () => ({ default: () => <div>create-tool</div> }));
// The Account Center — the social + ad accounts — NOT settings/connections,
// which is the calendar-sync surface. The drawer mounted the wrong one until
// 2026-09-01; pinning the module path here is what stops that regressing.
vi.mock('../accounts/AccountCenterPage', () => ({ default: () => <div>connections-tool</div> }));

const budget: svc.GrowthBudget = {
  id: 'b1',
  workspaceId: 'ws1',
  periodKey: '2026-08',
  currency: 'TRY',
  totalAmount: '30000',
  scope: 'HOLISTIC',
  status: 'ACTIVE',
  killSwitch: false,
  explorationPct: 20,
  allocatorStage: 'MARGINAL',
  autonomyLevel: 'ASSISTED',
  contentAutoPublish: false,
  targetRoas: '2.5',
  targetCac: null,
  createdAt: '',
  updatedAt: '',
  allocations: [
    { id: 'a1', channel: 'META', campaignRef: '', plannedAmount: '20000', spentAmount: '5000', marginalRoas: '3.2', lastPacedAt: null },
  ],
};

const wallet: svc.GrowthWalletState = { workspaceId: 'ws1', balance: '10000', currency: 'TRY', exists: true };

const activity: svc.ActivityItem[] = [
  {
    ts: '2026-08-05T08:00:00.000Z',
    type: 'RUN',
    data: {
      id: 'r1',
      kind: 'REALLOCATION',
      autonomy: 'AUTO',
      ok: true,
      createdAt: '2026-08-05T08:00:00.000Z',
      objective: { channels: [{ channel: 'META', avgRoas: 3, marginalRoas: 2 }] },
    },
  },
];

const pendingApproval: svc.ApprovalRequest = {
  id: 'ap-1',
  kind: 'SEND',
  status: 'PENDING',
  summary: 'MCP agent requested "jeeta.send_message"',
  payload: { tool: 'jeeta.send_message', args: { to: '+905551234567', body: 'hello' } },
  resourceType: null,
  resourceId: null,
  createdAt: '2026-08-20T10:00:00.000Z',
};

function setRole(role: 'OWNER' | 'MANAGER' | 'REP') {
  useMarketingAuthStore.setState({
    user: { id: 'u1', workspaceId: 'ws1', email: 'a@b.c', firstName: 'Ada', lastName: 'L', role },
    isAuthenticated: true,
    accessToken: null,
    refreshToken: null,
  });
}

/** Same tree as `wrap`, but on a client the test holds — needed wherever the
 *  assertion is about the CACHE (a failing background refetch, a shared entry's
 *  `meta`) rather than about a first paint. */
function wrapOn(qc: QueryClient, ui: ReactNode) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const testClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function wrap(ui: ReactNode) {
  return wrapOn(testClient(), ui);
}

/**
 * Radix's modal Dialog (which Sheet is) parks `pointer-events: none` on the
 * body while open and re-enables it on the layer; jsdom does not resolve that
 * inheritance, so userEvent's pointer-events guard refuses every click inside
 * an open sheet. Turning the guard off is the standard escape hatch — the
 * clicks are real, only the CSS check is skipped.
 */
const setupUser = () => userEvent.setup({ pointerEventsCheck: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  setRole('MANAGER');
  (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
  (svc.getGrowthBudget as any).mockResolvedValue(budget);
  (svc.getWalletState as any).mockResolvedValue(wallet);
  (svc.listBudgetActivity as any).mockResolvedValue(activity);
  (svc.listPendingApprovals as any).mockResolvedValue([]);
  (svc.listAutopilotRuns as any).mockResolvedValue([]);
});

describe('AutopilotStatusBar', () => {
  it('reports the armed state and the wallet balance from the shared queries', async () => {
    (svc.listGrowthBudgets as any).mockResolvedValue([{ ...budget, autonomyLevel: 'AUTONOMOUS' }]);
    wrap(<AutopilotStatusBar onOpenConsole={vi.fn()} />);

    expect(await screen.findByTestId('autopilot-state')).toHaveTextContent('Otomatik pilot açık');
    // Balance is the WALLET's number, the cap is the BUDGET's — each under its
    // own currency, never summed.
    expect(within(await screen.findByTestId('autopilot-balance')).getByText(/10[.,]000/)).toBeInTheDocument();
    expect(within(screen.getByTestId('autopilot-budget')).getByText(/30[.,]000/)).toBeInTheDocument();
    expect(screen.getByText('2026-08')).toBeInTheDocument();
  });

  it('reports a paused engine as paused, not as armed', async () => {
    // Armed AND paused: reading autonomyLevel alone would print "on" over an
    // engine that is doing nothing.
    (svc.listGrowthBudgets as any).mockResolvedValue([
      { ...budget, autonomyLevel: 'AUTONOMOUS', status: 'PAUSED' },
    ]);
    wrap(<AutopilotStatusBar onOpenConsole={vi.fn()} />);

    expect(await screen.findByTestId('autopilot-state')).toHaveTextContent('Duraklatıldı');
  });

  it('reports the kill-switch above everything else', async () => {
    (svc.listGrowthBudgets as any).mockResolvedValue([
      { ...budget, autonomyLevel: 'AUTONOMOUS', killSwitch: true },
    ]);
    wrap(<AutopilotStatusBar onOpenConsole={vi.fn()} />);

    expect(await screen.findByTestId('autopilot-state')).toHaveTextContent('Acil durdurma açık');
  });

  it('renders the Growth Multiple only once the helper can compute one', async () => {
    wrap(<AutopilotStatusBar onOpenConsole={vi.fn()} />);
    // spend 5000 × avgRoas 3 = 15000 revenue → 3.00×
    expect(await screen.findByText('3.00×')).toBeInTheDocument();
  });

  it('omits the Growth Multiple rather than printing a fabricated zero when there is no run signal', async () => {
    (svc.listBudgetActivity as any).mockResolvedValue([]);
    wrap(<AutopilotStatusBar onOpenConsole={vi.fn()} />);

    await screen.findByTestId('autopilot-balance');
    expect(screen.queryByTestId('autopilot-multiple')).not.toBeInTheDocument();
  });

  it('with no budget shows the single setup CTA instead of a row of dashes', async () => {
    const onOpenConsole = vi.fn();
    (svc.listGrowthBudgets as any).mockResolvedValue([]);
    const user = setupUser();
    wrap(<AutopilotStatusBar onOpenConsole={onOpenConsole} />);

    const cta = await screen.findByRole('button', { name: 'Otomatik pilotu kur' });
    expect(screen.getByTestId('autopilot-state')).toHaveTextContent('Kurulmadı');
    // No stats at all — not empty ones.
    expect(screen.queryByTestId('autopilot-balance')).not.toBeInTheDocument();
    expect(screen.queryByTestId('autopilot-budget')).not.toBeInTheDocument();
    expect(screen.queryByTestId('autopilot-multiple')).not.toBeInTheDocument();

    await user.click(cta);
    expect(onOpenConsole).toHaveBeenCalled();
  });

  it('does not offer a REP a setup CTA that would 403 at the end of the wizard', async () => {
    setRole('REP');
    (svc.listGrowthBudgets as any).mockResolvedValue([]);
    wrap(<AutopilotStatusBar onOpenConsole={vi.fn()} />);

    expect(await screen.findByText('Kurulumu bir yönetici yapabilir.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Otomatik pilotu kur' })).not.toBeInTheDocument();
  });

  it('reports a SHADOW budget as observation-only, never as an approval mode', async () => {
    // SHADOW is record-only on the backend — no approvals are ever raised. A
    // badge reading "Onaylı mod" would send the operator looking for a queue
    // that will never fill.
    (svc.listGrowthBudgets as any).mockResolvedValue([{ ...budget, autonomyLevel: 'SHADOW' }]);
    wrap(<AutopilotStatusBar onOpenConsole={vi.fn()} />);

    const state = await screen.findByTestId('autopilot-state');
    expect(state).toHaveTextContent('Yalnızca gözlem');
    expect(state).not.toHaveTextContent('Onaylı mod');
  });

  it('says the state is unknown (and offers a retry) rather than drawing a calm default over a failed read', async () => {
    (svc.listGrowthBudgets as any).mockRejectedValue(new Error('boom'));
    wrap(<AutopilotStatusBar onOpenConsole={vi.fn()} />);

    expect(await screen.findByText('Otomatik pilot durumu okunamadı.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yeniden dene' })).toBeInTheDocument();
    expect(screen.queryByTestId('autopilot-state')).not.toBeInTheDocument();
  });

  /**
   * The failure this strip must survive, because everything else on the screen
   * hangs off it: React Query KEEPS `data` and flips `status` to 'error' when a
   * background refetch fails, so an `isError` check that runs before any data
   * check hands the whole strip — including the button that opens the console —
   * to the error line on one flaky poll.
   */
  it('keeps the state badge and the console button when a background refetch fails on cached data', async () => {
    const qc = testClient();
    wrapOn(qc, <AutopilotStatusBar onOpenConsole={vi.fn()} />);
    expect(await screen.findByTestId('autopilot-state')).toHaveTextContent('Onaylı mod');

    (svc.listGrowthBudgets as any).mockRejectedValue(new Error('flaky poll'));
    await act(async () => {
      await qc.refetchQueries({ queryKey: ['growth-budgets'] });
    });
    await waitFor(() =>
      expect(qc.getQueryState(['growth-budgets'])?.status).toBe('error'),
    );

    // Still the real strip, with the cached answer intact...
    expect(screen.getByTestId('autopilot-state')).toHaveTextContent('Onaylı mod');
    expect(screen.getByRole('button', { name: /Otomatik pilot konsolu/ })).toBeInTheDocument();
    expect(screen.queryByText('Otomatik pilot durumu okunamadı.')).not.toBeInTheDocument();
    // ...and honest that the answer is no longer fresh.
    expect(screen.getByTestId('autopilot-stale')).toBeInTheDocument();
  });

  /**
   * `meta: { silent: true }` lives on the QUERY, not on the observer, and
   * query-core re-applies `observer.options` on every fetch — so a sibling
   * observer that omits the flag clears it for everyone. The console shares all
   * four keys with this strip, and it is mounted (in the drawer) on top of it,
   * which is exactly when a person can least afford a toast landing over two
   * inline error states. `onError` below mirrors main.tsx's global QueryCache.
   */
  it('stays opted out of the global error toast after the console mounts on the same keys', async () => {
    const toasted = vi.fn();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
      queryCache: new QueryCache({
        onError: (error, query) => {
          if (query.meta?.silent) return;
          toasted(error);
        },
      }),
    });

    wrapOn(qc, <AutopilotStatusBar onOpenConsole={vi.fn()} />);
    await screen.findByTestId('autopilot-state');

    // The drawer opens on the Autopilot: the console mounts and refetches the
    // very same entries.
    wrapOn(qc, <BudgetAutopilotPage embedded hideApprovals />);
    await screen.findByText('Growth Multiple');

    (svc.listGrowthBudgets as any).mockRejectedValue(new Error('flaky poll'));
    (svc.getWalletState as any).mockRejectedValue(new Error('flaky poll'));
    await act(async () => {
      await qc.refetchQueries({ queryKey: ['growth-budgets'] });
      await qc.refetchQueries({ queryKey: ['growth-wallet'] });
    });

    expect(toasted).not.toHaveBeenCalled();
  });
});

describe('StudioToolsDrawer', () => {
  const renderDrawer = (tool: StudioTool | null, open = true) =>
    wrap(<StudioToolsDrawer open={open} tool={tool} onOpenChange={vi.fn()} />);

  it('mounts the Autopilot console — and only it — when opened on autopilot', async () => {
    renderDrawer('autopilot');

    // The real console, not a stub: its hero strip is the proof.
    expect(await screen.findByText('Growth Multiple')).toBeInTheDocument();
    expect(screen.queryByText('calendar-tool')).not.toBeInTheDocument();
    expect(screen.queryByText('create-tool')).not.toBeInTheDocument();
    expect(screen.queryByText('connections-tool')).not.toBeInTheDocument();
  });

  it('mounts the calendar — and only it — when opened on calendar', async () => {
    renderDrawer('calendar');

    expect(await screen.findByText('calendar-tool')).toBeInTheDocument();
    expect(screen.queryByText('create-tool')).not.toBeInTheDocument();
    expect(screen.queryByText('connections-tool')).not.toBeInTheDocument();
    expect(screen.queryByText('Growth Multiple')).not.toBeInTheDocument();
  });

  it('mounts the AI Studio — and only it — when opened on create', async () => {
    renderDrawer('create');

    expect(await screen.findByText('create-tool')).toBeInTheDocument();
    expect(screen.queryByText('calendar-tool')).not.toBeInTheDocument();
    expect(screen.queryByText('connections-tool')).not.toBeInTheDocument();
  });

  it('mounts the ACCOUNT CENTER — and only it — when opened on connections', async () => {
    renderDrawer('connections');

    expect(await screen.findByText('connections-tool')).toBeInTheDocument();
    expect(screen.queryByText('calendar-tool')).not.toBeInTheDocument();
    expect(screen.queryByText('create-tool')).not.toBeInTheDocument();
  });

  it('mounts nothing at all while closed', () => {
    renderDrawer('calendar', false);
    expect(screen.queryByText('calendar-tool')).not.toBeInTheDocument();
    expect(screen.queryByTestId('studio-tools-drawer')).not.toBeInTheDocument();
  });

  /**
   * The bug the drawer exists to close: `embedded` hides the PageHeader, and
   * the PageHeader is where both of these triggers live — so on the live
   * /studio a workspace that already HAS a budget can reach neither the budget
   * dialog nor the enable wizard.
   */
  it('carries the budget + enable triggers that `embedded` hides, and the budget one really opens the dialog', async () => {
    const user = setupUser();
    renderDrawer('autopilot');

    const edit = await screen.findByRole('button', { name: 'Bütçeyi düzenle' });
    expect(screen.getByRole('button', { name: /Otomatik pilotu etkinleştir/ })).toBeInTheDocument();

    await user.click(edit);
    // BudgetDialog's own title (English inline default, its file not ours).
    expect(await screen.findByText('Edit budget')).toBeInTheDocument();
  });

  it('labels the budget trigger create-not-edit when there is no budget yet', async () => {
    (svc.listGrowthBudgets as any).mockResolvedValue([]);
    renderDrawer('autopilot');

    expect(await screen.findByRole('button', { name: 'Bütçe oluştur' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bütçeyi düzenle' })).not.toBeInTheDocument();
  });

  /**
   * The nested-dialog case. `<Sheet>` is a Radix dialog, and a second Radix
   * dialog mounted inside its content fights it for the focus trap — which is
   * why the wizard and the budget dialog are hoisted out of the Sheet at the
   * bottom of StudioToolsDrawer. The no-budget state used to defeat that
   * entirely: the drawer withheld its own trigger, and the console's empty
   * state offered one that opened the console's OWN wizard, mounted inside the
   * SheetContent subtree. `embedded` now suppresses the page's pair and the
   * drawer supplies the trigger in both states.
   */
  it('owns the enable-autopilot trigger with no budget too, and mounts its wizard outside the Sheet', async () => {
    const user = setupUser();
    (svc.listGrowthBudgets as any).mockResolvedValue([]);
    renderDrawer('autopilot');

    // The console's empty state is there; its own CTA (and the nested wizard
    // behind it) is not.
    expect(await screen.findByText('No growth budget yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable Autopilot' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Otomatik pilotu etkinleştir/ }));

    const wizardTitle = await screen.findByText('Enable Autopilot');
    const sheet = screen.getByTestId('studio-tools-drawer');
    expect(sheet).toBeInTheDocument();
    expect(sheet.contains(wizardTitle)).toBe(false);
  });

  /**
   * The queue is on the Studio's right rail and `<Sheet>` is MODAL, so while
   * this console is open the rail is behind the overlay — unreachable and
   * unreadable, in the state where a pending SPEND approval is most likely to
   * be on someone's mind. A count, not a second queue: a duplicate list goes
   * stale the moment you act on either copy, which is the reason
   * `hideApprovals` exists.
   */
  it('surfaces the pending-approval count the modal overlay is hiding, and returns you to the rail', async () => {
    const user = setupUser();
    const onOpenChange = vi.fn();
    (svc.listPendingApprovals as any).mockResolvedValue([pendingApproval]);
    wrap(<StudioToolsDrawer open tool="autopilot" onOpenChange={onOpenChange} />);

    const link = await screen.findByTestId('drawer-pending-approvals');
    expect(link).toHaveTextContent('1');
    expect(link).toHaveTextContent('onay bekliyor');
    // Still no second copy of the queue itself.
    expect(screen.queryByTestId('standalone-approvals')).not.toBeInTheDocument();
    expect(screen.queryByText('jeeta.send_message')).not.toBeInTheDocument();

    await user.click(link);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says nothing about approvals when none are pending', async () => {
    (svc.listPendingApprovals as any).mockResolvedValue([]);
    renderDrawer('autopilot');

    await screen.findByText('Growth Multiple');
    expect(screen.queryByTestId('drawer-pending-approvals')).not.toBeInTheDocument();
  });

  it('hides both write triggers from a REP (both endpoints behind them are MANAGER-only)', async () => {
    setRole('REP');
    renderDrawer('autopilot');

    await screen.findByText('Growth Multiple');
    expect(screen.queryByRole('button', { name: 'Bütçeyi düzenle' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Otomatik pilotu etkinleştir/ })).not.toBeInTheDocument();
  });

  /**
   * The reachability guarantee, pinned. Every one of these surfaces lost its
   * entry when the Studio stopped being a tab hub; if an href here changes or a
   * row disappears, that surface is unreachable from the product and this test
   * is the only thing that says so.
   */
  it('lists every deep link, with its exact href', async () => {
    const user = setupUser();
    renderDrawer('autopilot');

    await user.click(await screen.findByRole('button', { name: /Diğer araçlar/ }));

    const expected: Array<[string, string]> = [
      ['Kampanyalar', '/studio?view=tools&tab=campaigns&sub=standard'],
      ['Sosyal kampanyalar', '/studio?view=tools&tab=campaigns&sub=social'],
      ['Sosyal planlayıcı', '/studio?view=tools&tab=campaigns&sub=planner'],
      ['Trendler', '/studio?view=tools&tab=trends'],
      ['UGC personaları', '/studio?view=tools&tab=create&sub=personas'],
      ['E-posta şablonları', '/email-templates'],
      ['Yorumlar', '/reviews'],
      ['Ortaklar', '/affiliates'],
      ['Raporlar', '/reports'],
      ['Strateji', '/studio/strategy'],
      ['Bağlantılar', '/accounts'],
    ];

    for (const [label, href] of expected) {
      expect(await screen.findByRole('menuitem', { name: label })).toHaveAttribute('href', href);
    }
    // Nothing silently added or dropped alongside them.
    expect(screen.getAllByRole('menuitem')).toHaveLength(expected.length);
  });

  it('suppresses the console approvals queue it embeds, because the Studio rail already shows it', async () => {
    (svc.listPendingApprovals as any).mockResolvedValue([pendingApproval]);
    renderDrawer('autopilot');

    await screen.findByText('Growth Multiple');
    expect(screen.queryByRole('tab', { name: 'Approvals' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('standalone-approvals')).not.toBeInTheDocument();
  });
});

/**
 * `hideApprovals` is a prop on someone else's page, so both directions are
 * pinned here: the host that opts in gets no queue, and the page's own,
 * untouched behaviour still renders one.
 */
describe('BudgetAutopilotPage — hideApprovals', () => {
  const renderPage = (props: { hideApprovals?: boolean } = {}) => wrap(<BudgetAutopilotPage {...props} />);

  it('renders no approvals tab and no standalone queue when hideApprovals is set', async () => {
    (svc.listPendingApprovals as any).mockResolvedValue([pendingApproval]);
    renderPage({ hideApprovals: true });

    await waitFor(() => expect(screen.getByText('Growth Multiple')).toBeInTheDocument());
    expect(screen.queryByRole('tab', { name: 'Approvals' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('standalone-approvals')).not.toBeInTheDocument();
    expect(screen.queryByText('jeeta.send_message')).not.toBeInTheDocument();
  });

  it('still renders the approvals tab when the prop is absent', async () => {
    (svc.listPendingApprovals as any).mockResolvedValue([pendingApproval]);
    renderPage();

    expect(await screen.findByRole('tab', { name: 'Approvals' })).toBeInTheDocument();
  });

  it('suppresses the page-level standalone queue too (no budget, so no tab could hold it)', async () => {
    (svc.listGrowthBudgets as any).mockResolvedValue([]);
    (svc.listPendingApprovals as any).mockResolvedValue([pendingApproval]);
    renderPage({ hideApprovals: true });

    expect(await screen.findByText('No growth budget yet')).toBeInTheDocument();
    expect(screen.queryByTestId('standalone-approvals')).not.toBeInTheDocument();
  });

  it('still renders that standalone queue when the prop is absent', async () => {
    (svc.listGrowthBudgets as any).mockResolvedValue([]);
    (svc.listPendingApprovals as any).mockResolvedValue([pendingApproval]);
    renderPage();

    expect(await screen.findByTestId('standalone-approvals')).toBeInTheDocument();
  });
});

/**
 * `embedded` now means more than "hide the PageHeader": it also stops the page
 * mounting its own BudgetDialog / EnableAutopilotWizard, because the only host
 * is a modal Sheet and the host hoists its own copies outside it. Both
 * directions are pinned — a suppression that leaked into the standalone route
 * would leave `/budget` with no way to set a budget up at all.
 */
describe('BudgetAutopilotPage — embedded', () => {
  it('keeps its own empty-state CTA and wizard when it is NOT embedded', async () => {
    const user = setupUser();
    (svc.listGrowthBudgets as any).mockResolvedValue([]);
    wrap(<BudgetAutopilotPage />);

    await user.click(await screen.findByRole('button', { name: 'Enable Autopilot' }));
    // The wizard's own first-step copy, i.e. it really mounted.
    expect(await screen.findByText(/Load credit, set a cap and a goal once/)).toBeInTheDocument();
  });

  it('keeps its own budget dialog when it is NOT embedded', async () => {
    const user = setupUser();
    wrap(<BudgetAutopilotPage />);

    await user.click(await screen.findByRole('button', { name: 'Edit budget' }));
    // The dialog's own heading — the PageHeader button carries the same words.
    expect(await screen.findByRole('heading', { name: 'Edit budget' })).toBeInTheDocument();
  });
});
