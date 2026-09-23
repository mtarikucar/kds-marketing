import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ContactInfo from './ContactInfo';
import type { DetailLead } from './types';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

// Verify-phone sits behind the `smsOtp` add-on and is not what this file is
// about; with no entitlement it renders nothing and fires nothing.
vi.mock('../../../features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({ has: () => false }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'tr' },
  }),
}));

const apiPost = vi.mocked(marketingApi.post);

function setRole(role: 'OWNER' | 'MANAGER' | 'REP' | null) {
  useMarketingAuthStore.setState({
    user: role
      ? { id: 'u1', workspaceId: 'ws1', email: 'm@acme.test', firstName: 'M', lastName: 'K', role }
      : null,
    isAuthenticated: !!role,
  });
}

/** What `GET /leads/:id` really carries for the email row: the address plus
 *  the three deliverability scalars, answered (so the three-state rule lets
 *  them speak). */
const lead = (over: Record<string, unknown> = {}) =>
  ({
    id: 'l1',
    businessName: 'Kahve Durağı',
    contactPerson: 'Ayşe Yılmaz',
    businessType: 'CAFE',
    source: 'WEBSITE',
    status: 'NEW',
    phone: '+905551112233',
    email: 'ayse@acme.test',
    emailOptOut: false,
    emailBouncedAt: null,
    emailVerifiedStatus: 'UNKNOWN',
    activities: [],
    offers: [],
    tasks: [],
    ...over,
  }) as unknown as DetailLead;

function renderCard(l: DetailLead) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  render(
    <QueryClientProvider client={qc}>
      <ContactInfo lead={l} fmtDate={(d) => (d ? String(d) : '')} />
    </QueryClientProvider>,
  );
  return { invalidate };
}

/** The email row — the one place on the lead page that talks about the address. */
const emailRow = () => screen.getByTestId('contact-email');

beforeEach(() => {
  vi.clearAllMocks();
  setRole('MANAGER');
});

/**
 * Where the consent chips and controls live on the lead detail page: beside the
 * address they are about, not in the page header.
 *
 * They were in the header's action row for one release. That row sits beside
 * the lead's name, and a chip plus two consent buttons made it wide enough to
 * squeeze the <h1> to zero width — the business name vanished from its own
 * page. The behaviour below moved here unchanged from LeadHeaderActions.test.
 */
describe('ContactInfo — email consent, beside the address', () => {
  it('keeps the address itself a mailto link named by the address', () => {
    renderCard(lead({ emailVerifiedStatus: 'INVALID' }));

    // e2e/leads.spec.ts finds the lead again by exactly this: a link whose
    // name IS the address. The chips below it must not change that name.
    const link = within(emailRow()).getByRole('link', { name: 'ayse@acme.test' });
    expect(link).toHaveAttribute('href', 'mailto:ayse%40acme.test');
  });

  it('shows the standing state on the email row rather than leaving the rep to guess', () => {
    renderCard(lead({ emailOptOut: true }));

    expect(within(emailRow()).getByTestId('email-chip-optedOut')).toHaveTextContent(
      'Abonelikten çıktı',
    );
  });

  it('puts the controls on the email row too', () => {
    renderCard(lead());

    expect(within(emailRow()).getByTestId('email-suppression-actions')).toBeInTheDocument();
  });

  it('prints no claim about a lead whose payload does not carry the fields', () => {
    renderCard(
      lead({ emailOptOut: undefined, emailBouncedAt: undefined, emailVerifiedStatus: undefined }),
    );

    expect(screen.queryByTestId('email-suppression-chips')).not.toBeInTheDocument();
    // …and offers no toggle for a state nobody has stated.
    expect(screen.queryByTestId('email-suppression-actions')).not.toBeInTheDocument();
  });

  it('prints nothing about email at all for a lead with no address', () => {
    renderCard(lead({ email: '', emailOptOut: true }));

    expect(screen.queryByTestId('contact-email')).not.toBeInTheDocument();
    expect(screen.queryByTestId('email-suppression-actions')).not.toBeInTheDocument();
  });

  it('opts the person out through the endpoint that writes the consent ledger', async () => {
    const user = userEvent.setup({ delay: null });
    apiPost.mockResolvedValue({
      data: { emailOptOut: true, emailBouncedAt: null, emailVerifiedStatus: 'UNKNOWN', suppressed: true, reason: 'OPT_OUT' },
    } as never);
    const { invalidate } = renderCard(lead());

    await user.click(
      within(emailRow()).getByRole('button', { name: /Pazarlama e-postasından çıkar/ }),
    );

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/leads/l1/email-suppression', { action: 'OPT_OUT' }),
    );
    expect(toastSuccess).toHaveBeenCalled();
    // The page's own copy of the lead (`['marketing','lead', id]`) is what the
    // chip above the button reads — it has to be refreshed, or the button
    // flips to "Yeniden abone et" under a chip that still says nothing.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['marketing', 'lead'] });
  });

  it('puts them back through the same endpoint', async () => {
    const user = userEvent.setup({ delay: null });
    apiPost.mockResolvedValue({
      data: { emailOptOut: false, emailBouncedAt: null, emailVerifiedStatus: 'UNKNOWN', suppressed: false },
    } as never);
    renderCard(lead({ emailOptOut: true }));

    await user.click(within(emailRow()).getByRole('button', { name: /Yeniden abone et/ }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/leads/l1/email-suppression', {
        action: 'RESUBSCRIBE',
      }),
    );
  });

  // `writeLift` refuses to clear `emailOptOut` while a live COMPLAINT row still
  // owns that column, so the endpoint can answer 200 for a lift that changed
  // nothing. Reporting that as success is the same lie a 2xx FAILED send is.
  it('does not claim success for a lift the server could not apply', async () => {
    const user = userEvent.setup({ delay: null });
    apiPost.mockResolvedValue({
      data: { emailOptOut: true, emailBouncedAt: null, emailVerifiedStatus: 'UNKNOWN', suppressed: true, reason: 'COMPLAINT' },
    } as never);
    renderCard(lead({ emailOptOut: true }));

    await user.click(within(emailRow()).getByRole('button', { name: /Yeniden abone et/ }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(String(toastError.mock.calls[0][0])).toContain('Spam şikâyeti');
  });

  it('clears a bounce without touching consent', async () => {
    const user = userEvent.setup({ delay: null });
    apiPost.mockResolvedValue({
      data: { emailOptOut: false, emailBouncedAt: null, emailVerifiedStatus: 'UNKNOWN', suppressed: false },
    } as never);
    renderCard(lead({ emailBouncedAt: '2026-09-01T00:00:00.000Z' }));

    await user.click(within(emailRow()).getByRole('button', { name: /Bounce kaydını temizle/ }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/leads/l1/email-suppression', {
        action: 'CLEAR_BOUNCE',
      }),
    );
  });

  // The CI case: an address on a Null-MX domain is marked INVALID at create
  // and has never been mailed, let alone bounced. "Bounce kaydını temizle"
  // named a record that does not exist. The same CLEAR_BOUNCE lifts the mark
  // (INVALID → UNKNOWN) and does NOT re-check the address — the label and its
  // hint say exactly that.
  it('offers an address marked invalid — never bounced — the lift it really gets', async () => {
    const user = userEvent.setup({ delay: null });
    apiPost.mockResolvedValue({
      data: { emailOptOut: false, emailBouncedAt: null, emailVerifiedStatus: 'UNKNOWN', suppressed: false },
    } as never);
    renderCard(lead({ emailVerifiedStatus: 'INVALID' }));

    expect(within(emailRow()).getByTestId('email-chip-invalid')).toHaveTextContent(
      'Geçersiz adres',
    );
    expect(
      within(emailRow()).queryByRole('button', { name: /Bounce kaydını temizle/ }),
    ).not.toBeInTheDocument();

    const clear = within(emailRow()).getByRole('button', { name: 'Geçersiz işaretini kaldır' });
    expect(clear).toHaveAttribute('title', expect.stringMatching(/yeniden kontrol edilmez/));
    await user.click(clear);

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/leads/l1/email-suppression', {
        action: 'CLEAR_BOUNCE',
      }),
    );
  });

  // MANAGER + settings.manage on the server. A rep who could press it would
  // collect a 403 — and a recorded consent decision is not theirs to erase.
  it('offers a REP the chips but not the controls', () => {
    setRole('REP');
    renderCard(lead({ emailOptOut: true }));

    expect(within(emailRow()).getByTestId('email-chip-optedOut')).toBeInTheDocument();
    expect(screen.queryByTestId('email-suppression-actions')).not.toBeInTheDocument();
  });
});
