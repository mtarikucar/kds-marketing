import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RoutineConfig } from './routines';

// platformApi is an axios instance — mock so no real request fires.
const patch = vi.fn((..._args: unknown[]) => Promise.resolve({ data: {} }));
vi.mock('../../../features/platform/api/platformApi', () => ({
  default: { patch: (url: string, body: unknown) => patch(url, body) },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { RoutineConfigDialog } from './RoutineConfigDialog';

const ROUTINE: RoutineConfig = {
  key: 'review-draft',
  enabled: true,
  cron: '0 3 * * *',
  onEvent: false,
  triggerUrl: null,
  hasToken: false,
  eventCooldownSec: 300,
  lastTriggeredAt: null,
  lastTriggerStatus: null,
  lastTriggerError: null,
};

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RoutineConfigDialog open routine={ROUTINE} onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('RoutineConfigDialog', () => {
  beforeEach(() => {
    patch.mockClear();
  });

  it('mounts open with the routine label and config fields', () => {
    renderDialog();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Review draft')).toBeInTheDocument();
    expect(screen.getByLabelText(/cron schedule/i)).toHaveValue('0 3 * * *');
  });

  it('fires validation and does not save when cooldown is invalid', async () => {
    const user = userEvent.setup();
    renderDialog();

    const cooldown = screen.getByLabelText(/event cooldown/i);
    await user.clear(cooldown);
    await user.type(cooldown, '-5');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(patch).not.toHaveBeenCalled();
  });

  it('saves with the original PATCH payload shape when valid', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        '/routines/review-draft',
        expect.objectContaining({
          enabled: true,
          onEvent: false,
          cron: '0 3 * * *',
          eventCooldownSec: 300,
        }),
      ),
    );
  });
});
