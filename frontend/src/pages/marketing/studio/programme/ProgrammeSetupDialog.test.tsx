import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgrammeSetupDialog, CAP_MAX, CAP_MIN } from './ProgrammeSetupDialog';
import * as api from '../../../../features/marketing/api/contentProgramme.service';
import * as social from '../../../../features/marketing/api/socialPosts.service';

vi.mock('../../../../features/marketing/api/contentProgramme.service', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return { ...actual, createProgramme: vi.fn() };
});
vi.mock('../../../../features/marketing/api/socialPosts.service', () => ({
  listSocialAccounts: vi.fn(),
  socialQueryKeys: { accounts: ['marketing', 'social', 'accounts'] },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: string | Record<string, unknown>, o?: Record<string, unknown>) => {
      const def = typeof d === 'string' ? d : '';
      const vars = (typeof d === 'string' ? o : (d as Record<string, unknown>)) ?? {};
      return def.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k] ?? ''));
    },
    i18n: { language: 'tr' },
  }),
}));

const createProgramme = vi.mocked(api.createProgramme);
const listSocialAccounts = vi.mocked(social.listSocialAccounts);

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{children}</QueryClientProvider>);
}

/** Name, brief and the one account filled in; the cap is left to the test. */
async function fillRequired(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.type(within(dialog).getByLabelText('Ad'), 'Sonbahar');
  await user.type(within(dialog).getByLabelText('Konu / ürün / ton'), 'Kinetik heykeller');
  await user.click(await within(dialog).findByRole('checkbox', { name: 'INSTAGRAM @heykel' }));
}

async function setCap(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, value: string) {
  const cap = within(dialog).getByLabelText('Haftalık kredi tavanı');
  await user.clear(cap);
  if (value) await user.type(cap, value);
}

beforeEach(() => {
  vi.clearAllMocks();
  listSocialAccounts.mockResolvedValue([
    { id: 'a1', network: 'INSTAGRAM', externalId: 'x', displayName: '@heykel', accessToken: '••', tokenExpiresAt: null, enabled: true, createdAt: '2026-09-01T00:00:00.000Z' },
  ] as never);
  createProgramme.mockResolvedValue({ programme: null, dashboard: null });
});

describe('ProgrammeSetupDialog — validation is the form\'s own, not the browser\'s', () => {
  it('opts out of native constraint validation and bounds the cap to what the backend accepts', async () => {
    wrap(<ProgrammeSetupDialog open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const form = dialog.querySelector('form')!;
    expect(form).toHaveAttribute('novalidate');
    const cap = within(dialog).getByLabelText('Haftalık kredi tavanı');
    expect(cap).toHaveAttribute('step', '1');
    expect(cap).toHaveAttribute('min', String(CAP_MIN));
    expect(cap).toHaveAttribute('max', String(CAP_MAX));
    // Native `required` is gone; the requirement is still announced.
    expect(within(dialog).getByLabelText('Ad')).not.toHaveAttribute('required');
    expect(within(dialog).getByLabelText('Ad')).toHaveAttribute('aria-required', 'true');
  });

  it('accepts a cap of 555 — a value a step of 10 used to refuse', async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<ProgrammeSetupDialog open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    await fillRequired(user, dialog);
    await setCap(user, dialog, '555');
    await user.click(within(dialog).getByRole('button', { name: 'Başlat' }));
    await waitFor(() => expect(createProgramme).toHaveBeenCalledWith(expect.objectContaining({ weeklyCreditCap: 555 })));
  });

  it('names a missing name and brief through the localized alert, not a browser bubble', async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<ProgrammeSetupDialog open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Başlat' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Programa bir ad verin.');

    await user.type(within(dialog).getByLabelText('Ad'), 'X');
    await user.click(within(dialog).getByRole('button', { name: 'Başlat' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Program neyle ilgili? Kısaca yazın.');
    expect(createProgramme).not.toHaveBeenCalled();
  });

  it('refuses a cap below 50, above 20000, or fractional, with the one cap message', async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<ProgrammeSetupDialog open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    await fillRequired(user, dialog);
    const submit = within(dialog).getByRole('button', { name: 'Başlat' });

    for (const bad of ['30', '25000', '100.5', '']) {
      await setCap(user, dialog, bad);
      await user.click(submit);
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Haftalık kredi tavanı 50 ile 20000 arasında bir tam sayı olmalı.');
    }
    expect(createProgramme).not.toHaveBeenCalled();
  });

  it('labels the publish time with the zone the engine schedules in', async () => {
    wrap(<ProgrammeSetupDialog open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Yayın saati (Türkiye saati, SS:DD)')).toHaveAttribute('type', 'time');
  });
});
