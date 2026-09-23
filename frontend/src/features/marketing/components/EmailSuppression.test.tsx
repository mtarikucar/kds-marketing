import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmailSuppressionActions, type EmailSuppressionLead } from './EmailSuppression';
import { useMarketingAuthStore } from '@/store/marketingAuthStore';

vi.mock('@/features/marketing/api/marketingApi', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'tr' },
  }),
}));

function setRole(role: 'OWNER' | 'MANAGER' | 'REP') {
  useMarketingAuthStore.setState({
    user: { id: 'u1', workspaceId: 'ws1', email: 'm@acme.test', firstName: 'M', lastName: 'K', role },
    isAuthenticated: true,
  });
}

const answered = (over: Partial<EmailSuppressionLead> = {}): EmailSuppressionLead => ({
  id: 'l1',
  email: 'ayse@acme.test',
  emailOptOut: false,
  emailBouncedAt: null,
  emailVerifiedStatus: 'UNKNOWN',
  ...over,
});

function renderActions(lead: EmailSuppressionLead) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <EmailSuppressionActions lead={lead} />
    </QueryClientProvider>,
  );
}

const CLEAR = /Bounce kaydını temizle|Geçersiz işaretini kaldır/;

beforeEach(() => setRole('MANAGER'));

/**
 * One endpoint action (`CLEAR_BOUNCE`), which lifts HARD_BOUNCE and INVALID
 * together — and two labels, because the operator is looking at two different
 * facts. A button that says "clear the bounce" over an address that never
 * bounced (a Null-MX domain marked INVALID at create) names a record that does
 * not exist; the honest name is the mark it carries, and the hint says the
 * lift does not re-check the address.
 */
describe('EmailSuppressionActions — the machine-verdict button names what the address carries', () => {
  it('says "clear the bounce" for a bounced address', () => {
    renderActions(answered({ emailBouncedAt: '2026-09-01T00:00:00.000Z' }));

    const btn = screen.getByRole('button', { name: CLEAR });
    expect(btn).toHaveTextContent('Bounce kaydını temizle');
    expect(btn).not.toHaveAttribute('title');
  });

  it('says "clear the invalid mark" for an address that is invalid and never bounced', () => {
    renderActions(answered({ emailVerifiedStatus: 'INVALID' }));

    const btn = screen.getByRole('button', { name: CLEAR });
    expect(btn).toHaveTextContent('Geçersiz işaretini kaldır');
    expect(btn).toHaveAttribute('title', expect.stringMatching(/yeniden kontrol edilmez/));
  });

  it('leads with the bounce when both are on record — the one action lifts both', () => {
    renderActions(
      answered({ emailBouncedAt: '2026-09-01T00:00:00.000Z', emailVerifiedStatus: 'INVALID' }),
    );

    expect(screen.getAllByRole('button', { name: CLEAR })).toHaveLength(1);
    expect(screen.getByRole('button', { name: CLEAR })).toHaveTextContent(
      'Bounce kaydını temizle',
    );
  });

  it('offers no clearing at all when nothing machine-made is on record', () => {
    renderActions(answered({ emailVerifiedStatus: 'VALID' }));

    expect(screen.getByRole('button', { name: /Pazarlama e-postasından çıkar/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CLEAR })).not.toBeInTheDocument();
  });

  it('is absent for a REP, whatever the address carries', () => {
    setRole('REP');
    renderActions(answered({ emailVerifiedStatus: 'INVALID' }));

    expect(screen.queryByTestId('email-suppression-actions')).not.toBeInTheDocument();
  });
});

/**
 * These buttons sit in narrow columns: the lead detail's Contact Info card is
 * a third of the content width at `lg`. Button's base is `whitespace-nowrap
 * h-8`, and with it "Pazarlama e-postasından çıkar" ran out of the card at a
 * 1024px viewport. jsdom does no layout, so the classes that let the label
 * wrap are pinned here; e2e/leads.spec.ts measures the real thing.
 */
describe('EmailSuppressionActions — the buttons fit a narrow column', () => {
  it('lets every label wrap and the button grow, instead of spilling out', () => {
    renderActions(answered({ emailVerifiedStatus: 'INVALID' }));

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    for (const btn of buttons) {
      expect(btn).toHaveClass('whitespace-normal', 'h-auto', 'min-h-8', 'max-w-full');
      expect(btn).not.toHaveClass('whitespace-nowrap');
      expect(btn).not.toHaveClass('h-8');
    }
  });
});
