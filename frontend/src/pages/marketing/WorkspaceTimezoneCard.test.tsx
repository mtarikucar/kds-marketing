import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import marketingApi from '../../features/marketing/api/marketingApi';
import { WorkspaceTimezoneCard } from './WorkspaceTimezoneCard';

vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: { get: vi.fn(), patch: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: string, vars?: Record<string, unknown>) =>
      (d ?? '').replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars?.[k] ?? '')),
    i18n: { language: 'tr' },
  }),
}));

const get = vi.mocked(marketingApi.get);
const patch = vi.mocked(marketingApi.patch);

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ data: { timezone: 'UTC' } } as never);
  patch.mockResolvedValue({ data: { timezone: 'Europe/Istanbul' } } as never);
});

/**
 * `GET`/`PATCH marketing/workspaces/timezone` shipped guarded, validated and
 * audited with NO caller anywhere in the client — a write surface that could not
 * be written, over a column whose stored 'UTC' every existing workspace was
 * stuck with. This suite is the door.
 */
describe('WorkspaceTimezoneCard', () => {
  it('reads the workspace zone and preselects it', async () => {
    get.mockResolvedValue({ data: { timezone: 'Europe/Istanbul' } } as never);
    wrap(<WorkspaceTimezoneCard />);

    await waitFor(() => expect(get).toHaveBeenCalledWith('/workspaces/timezone'));
    await waitFor(() =>
      expect(screen.getByRole('combobox')).toHaveValue('Europe/Istanbul'),
    );
  });

  it('PATCHes the chosen zone — the write half that had no caller', async () => {
    const user = userEvent.setup();
    wrap(<WorkspaceTimezoneCard />);

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('UTC'));
    await user.selectOptions(screen.getByRole('combobox'), 'Europe/Istanbul');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/workspaces/timezone', { timezone: 'Europe/Istanbul' }),
    );
  });

  it('refreshes the profile too, because the Studio rail reads its timezone', async () => {
    const user = userEvent.setup();
    const { qc } = wrap(<WorkspaceTimezoneCard />);
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('UTC'));
    await user.selectOptions(screen.getByRole('combobox'), 'Europe/Istanbul');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ['marketing', 'workspace', 'profile'] }),
    );
  });

  it('will not save an unchanged zone', async () => {
    wrap(<WorkspaceTimezoneCard />);
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('UTC'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('keeps a stored zone selectable even when it is a link name Intl does not list canonically', async () => {
    // `Intl.supportedValuesOf('timeZone')` returns the CANONICAL set. Registration
    // writes whatever the browser reported, and browsers and operating systems
    // still hand out link names — so a stored value can legitimately be missing
    // from that list, and dropping it from the options would show a manager an
    // empty picker over a perfectly valid setting.
    //
    // Which names are missing depends on the runtime's ICU data, so the test
    // picks one at runtime rather than hard-coding a guess (this Node lists
    // 'Asia/Calcutta' and 'Europe/Kiev' but not 'US/Eastern').
    const canonical = new Set(
      (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone'),
    );
    const legacy = ['US/Eastern', 'Asia/Calcutta', 'Europe/Kiev', 'Japan', 'GMT'].find(
      (z) => !canonical.has(z),
    );
    expect(legacy).toBeDefined();

    get.mockResolvedValue({ data: { timezone: legacy } } as never);
    wrap(<WorkspaceTimezoneCard />);

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue(legacy));
  });
});
