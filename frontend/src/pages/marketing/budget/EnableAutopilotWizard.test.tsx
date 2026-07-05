import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EnableAutopilotWizard } from './EnableAutopilotWizard';
import * as svc from '../../../features/marketing/api/growthBudget.service';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      typeof opts === 'string' ? opts : (opts?.defaultValue ?? key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../features/marketing/api/growthBudget.service', () => ({
  getWalletState: vi.fn(),
  quickStart: vi.fn(),
  walletTopup: vi.fn(),
}));

const manifest: svc.QuickStartManifest = {
  wallet: { balance: '2500', currency: 'TRY', exists: true },
  budget: { id: 'b1', periodKey: '2026-07', totalAmount: '2500', autonomyLevel: 'AUTONOMOUS', status: 'ACTIVE' },
  channels: ['META', 'CONTENT'],
  allocations: [
    { channel: 'META', plannedAmount: '1250' },
    { channel: 'CONTENT', plannedAmount: '1250' },
  ],
  armed: true,
  contentCampaign: null,
};

function renderWizard(props: Partial<Parameters<typeof EnableAutopilotWizard>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EnableAutopilotWizard open onOpenChange={() => {}} {...props} />
    </QueryClientProvider>,
  );
}

describe('EnableAutopilotWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (svc.getWalletState as any).mockResolvedValue({ workspaceId: 'ws1', balance: '2500', currency: 'TRY', exists: true });
    (svc.quickStart as any).mockResolvedValue(manifest);
  });

  it('walks balance → cap+goal → arm and fires ONE quickStart call, then shows the manifest', async () => {
    const user = userEvent.setup();
    renderWizard();

    // Step 1 — wallet balance is shown.
    expect(await screen.findByText(/2,?500|2\.500/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Step 2 — cap prefilled from the wallet balance.
    const cap = screen.getByLabelText('Monthly cap') as HTMLInputElement;
    expect(cap.value).toBe('2500');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Step 3 — arm toggle defaults ON; one click provisions everything.
    expect(screen.getByRole('switch', { name: 'Turn on Autopilot' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Start Autopilot' }));

    expect(svc.quickStart).toHaveBeenCalledTimes(1);
    expect(svc.quickStart).toHaveBeenCalledWith({ amount: 2500, arm: true });

    // Success screen renders the manifest (everything provisioned).
    expect(await screen.findByText('Autopilot is live')).toBeInTheDocument();
    expect(screen.getByText('Meta')).toBeInTheDocument();
    expect(screen.getByText('Content')).toBeInTheDocument();
    expect(screen.getByText('2026-07')).toBeInTheDocument();
  });

  it('sends the edited cap + goal in the single quickStart call', async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByRole('button', { name: 'Next' }));
    const cap = screen.getByLabelText('Monthly cap');
    await user.clear(cap);
    await user.type(cap, '1000');
    await user.type(screen.getByLabelText('Target ROAS (optional)'), '2.5');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Start Autopilot' }));

    expect(svc.quickStart).toHaveBeenCalledTimes(1);
    expect(svc.quickStart).toHaveBeenCalledWith({ amount: 1000, targetRoas: 2.5, arm: true });
  });

  it('offers a top-up shortcut on step 1 that follows a redirect handle', async () => {
    const user = userEvent.setup();
    (svc.getWalletState as any).mockResolvedValue({ workspaceId: 'ws1', balance: '0', currency: 'TRY', exists: false });
    (svc.walletTopup as any).mockResolvedValue({ orderId: 'o1', handle: { kind: 'redirect', url: 'https://pay.example/x' } });
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { ...original, assign }, writable: true });

    renderWizard();
    const amount = await screen.findByLabelText('Top-up amount');
    await user.type(amount, '500');
    await user.click(screen.getByRole('button', { name: 'Load credit' }));

    expect(svc.walletTopup).toHaveBeenCalledWith({ amount: 500, provider: 'paytr' });
    expect(assign).toHaveBeenCalledWith('https://pay.example/x');
    Object.defineProperty(window, 'location', { value: original, writable: true });
  });
});
