import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useMarketingAuthStore } from '@/store/marketingAuthStore';
import { MarketingRole } from '@/features/marketing/types';
import { RoleGate, FeatureGate } from './access-gates';

// ── useEntitlements mock ─────────────────────────────────────────────────────
const mockHas = vi.fn();

vi.mock('@/features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    isLoading: false,
    isError: false,
    features: {},
    has: mockHas,
  }),
}));

// ── helpers ──────────────────────────────────────────────────────────────────
function setUserRole(role: 'OWNER' | 'MANAGER' | 'REP' | null) {
  useMarketingAuthStore.setState({
    user: role
      ? {
          id: '1',
          workspaceId: 'ws1',
          email: 'test@example.com',
          firstName: 'Test',
          lastName: 'User',
          role,
        }
      : null,
    isAuthenticated: !!role,
    accessToken: null,
    refreshToken: null,
  });
}

beforeEach(() => {
  mockHas.mockReset();
});

// ── RoleGate tests ────────────────────────────────────────────────────────────
describe('RoleGate', () => {
  it('renders children when the user has the required role (exact match)', () => {
    setUserRole('MANAGER');
    render(
      <RoleGate role={MarketingRole.MANAGER}>
        <span>Protected content</span>
      </RoleGate>,
    );
    expect(screen.getByText('Protected content')).toBeInTheDocument();
  });

  it('renders children when the user has a higher role (OWNER satisfies MANAGER)', () => {
    setUserRole('OWNER');
    render(
      <RoleGate role={MarketingRole.MANAGER}>
        <span>Protected content</span>
      </RoleGate>,
    );
    expect(screen.getByText('Protected content')).toBeInTheDocument();
  });

  it('hides children when the user role is insufficient (REP cannot satisfy MANAGER)', () => {
    setUserRole('REP');
    render(
      <RoleGate role={MarketingRole.MANAGER}>
        <span>Protected content</span>
      </RoleGate>,
    );
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('renders fallback when the user role is insufficient', () => {
    setUserRole('REP');
    render(
      <RoleGate role={MarketingRole.OWNER} fallback={<span>No access</span>}>
        <span>Secret</span>
      </RoleGate>,
    );
    expect(screen.queryByText('Secret')).not.toBeInTheDocument();
    expect(screen.getByText('No access')).toBeInTheDocument();
  });

  it('hides children when user is null (unauthenticated)', () => {
    setUserRole(null);
    render(
      <RoleGate role={MarketingRole.REP}>
        <span>Protected content</span>
      </RoleGate>,
    );
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });
});

// ── FeatureGate tests ─────────────────────────────────────────────────────────
describe('FeatureGate', () => {
  it('renders children when entitlement is true', () => {
    mockHas.mockReturnValue(true);
    render(
      <FeatureGate feature="telephony">
        <span>Call panel</span>
      </FeatureGate>,
    );
    expect(screen.getByText('Call panel')).toBeInTheDocument();
    expect(mockHas).toHaveBeenCalledWith('telephony');
  });

  it('hides children when entitlement is false', () => {
    mockHas.mockReturnValue(false);
    render(
      <FeatureGate feature="telephony">
        <span>Call panel</span>
      </FeatureGate>,
    );
    expect(screen.queryByText('Call panel')).not.toBeInTheDocument();
  });

  it('renders fallback when entitlement is false', () => {
    mockHas.mockReturnValue(false);
    render(
      <FeatureGate feature="campaigns" fallback={<span>Upgrade required</span>}>
        <span>Campaign builder</span>
      </FeatureGate>,
    );
    expect(screen.queryByText('Campaign builder')).not.toBeInTheDocument();
    expect(screen.getByText('Upgrade required')).toBeInTheDocument();
  });
});
