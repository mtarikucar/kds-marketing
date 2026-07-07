import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PackageMatrix, FEATURE_LABELS, type PackageRow } from './PackageMatrix';

// Mirror of the backend's FEATURE_KEYS (entitlements.service.ts). Hardcoded
// because the frontend doesn't import from the backend package; the backend's
// entitlements.tripwire.spec.ts pins this exact list, so if the vocabulary
// changes there, that suite fails and this list is updated in the same PR.
const BACKEND_FEATURE_KEYS = [
  'autoAssign',
  'telephony',
  'installations',
  'commissions',
  'advancedReports',
  'apiAccess',
  'conversationAi',
  'workflows',
  'campaigns',
  'funnels',
  'reviews',
  'askAi',
  'agentStudio',
  'voiceAi',
  'invoicing',
  'mediaGen',
  'socialCampaigns',
  'memberships',
  'research',
] as const;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
    i18n: { language: 'en' },
  }),
}));

const PKG = (code: string, name: string): PackageRow => ({
  code,
  name,
  description: '',
  dailyLeadQuota: 10,
  maxUsers: 3,
  maxResearchProfiles: 2,
  features: {},
  priceMonthlyTRY: '1000',
  priceMonthlyUSD: '30',
  priceYearlyTRY: null,
  priceYearlyUSD: null,
});

const baseProps = {
  packages: [PKG('STARTER', 'Starter'), PKG('GROWTH', 'Growth')],
  currentPackageCode: undefined,
  currency: 'TRY' as const,
  providers: ['stripe'],
  cycle: 'MONTHLY' as const,
  onCycleChange: vi.fn(),
  isOwner: true,
  onBuy: vi.fn(),
};

describe('PackageMatrix checkout loading', () => {
  // Regression: the buy button's loading was `isPending && !isCurrent ? false :
  // undefined` — a dead expression that is NEVER true, so no spinner ever showed
  // during checkout. The spinner must show ONLY on the package being checked out
  // (keyed off the checkout mutation's packageCode), not bleed across rows.
  it('spins only the package being checked out, not every button', () => {
    render(<PackageMatrix {...baseProps} isPending pendingCode="STARTER" />);
    const choose = screen.getAllByRole('button', { name: /choose/i });
    expect(choose).toHaveLength(2);
    // The package being purchased shows the loading spinner (aria-busy)…
    expect(choose[0]).toHaveAttribute('aria-busy', 'true');
    // …the other package's button does not.
    expect(choose[1]).not.toHaveAttribute('aria-busy');
  });

  it('shows no spinner when nothing is being checked out', () => {
    render(<PackageMatrix {...baseProps} isPending={false} />);
    for (const btn of screen.getAllByRole('button', { name: /choose/i })) {
      expect(btn).not.toHaveAttribute('aria-busy');
    }
  });
});

describe('PackageMatrix feature labels', () => {
  // Regression: public packages grant mediaGen/socialCampaigns/memberships/
  // research, but FEATURE_LABELS covered only 15 keys — so the pricing cards
  // printed raw camelCase ("mediaGen"). Every backend feature the packages can
  // grant must have a human-readable label; this pins the whole vocabulary so a
  // future feature key can't silently drift back to raw camelCase.
  it('has a readable label for every backend FEATURE_KEY', () => {
    for (const key of BACKEND_FEATURE_KEYS) {
      expect(FEATURE_LABELS[key], `missing label for '${key}'`).toBeTruthy();
    }
  });
});
