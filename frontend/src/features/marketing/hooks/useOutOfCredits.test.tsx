import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { isCreditsExhausted, useOutOfCredits } from './useOutOfCredits';
import { useMarketingAuthStore } from '@/store/marketingAuthStore';

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: unknown) =>
      (typeof d === 'string' ? d : (d as { defaultValue?: string })?.defaultValue) ?? _k,
  }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

function setRole(role: 'OWNER' | 'MANAGER' | 'REP' | null) {
  useMarketingAuthStore.setState({
    user: role
      ? {
          id: 'u1',
          workspaceId: 'w1',
          email: 'a@b.c',
          firstName: 'A',
          lastName: 'B',
          role,
        }
      : null,
  });
}

/** Fires `notify` once on mount so the toast payload can be inspected. */
function Probe({ error }: { error: unknown }) {
  const { notify } = useOutOfCredits();
  return (
    <button onClick={() => notify(error, 'Generation failed')} type="button">
      go
    </button>
  );
}

async function fire(error: unknown) {
  render(<Probe error={error} />, { wrapper: MemoryRouter });
  await userEvent.click(screen.getByRole('button', { name: 'go' }));
}

describe('isCreditsExhausted', () => {
  it('is true ONLY for a 403 carrying AI_CREDITS_EXHAUSTED', () => {
    expect(
      isCreditsExhausted({ response: { status: 403, data: { code: 'AI_CREDITS_EXHAUSTED' } } }),
    ).toBe(true);
  });

  /**
   * The two negatives are the point of the helper. Keying on the CODE alone
   * would re-label a genuine entitlement 403 as a billing wall; keying on the
   * STATUS alone would do the same to every other 403. Both halves stay.
   */
  it('is false for a 403 that is an entitlement problem, not a credit one', () => {
    expect(
      isCreditsExhausted({ response: { status: 403, data: { code: 'FEATURE_NOT_IN_PACKAGE' } } }),
    ).toBe(false);
  });

  it('is false for a 500 that happens to carry the same code', () => {
    expect(
      isCreditsExhausted({ response: { status: 500, data: { code: 'AI_CREDITS_EXHAUSTED' } } }),
    ).toBe(false);
  });

  it('is false for a bare Error and for nothing at all', () => {
    expect(isCreditsExhausted(new Error('boom'))).toBe(false);
    expect(isCreditsExhausted(undefined)).toBe(false);
  });
});

describe('useOutOfCredits — role routing', () => {
  const creditsError = { response: { status: 403, data: { code: 'AI_CREDITS_EXHAUSTED' } } };

  beforeEach(() => {
    toastError.mockReset();
    navigate.mockReset();
  });

  it('gives an OWNER a toast whose action navigates to /billing', async () => {
    setRole('OWNER');
    await fire(creditsError);

    const [message, opts] = toastError.mock.calls[0];
    expect(message).toMatch(/buy a pack in Billing/i);
    expect(opts.action.label).toBe('Add credits');
    opts.action.onClick();
    expect(navigate).toHaveBeenCalledWith('/billing');
  });

  it('gives a MANAGER the member copy and still a /billing action', async () => {
    setRole('MANAGER');
    await fire(creditsError);

    const [message, opts] = toastError.mock.calls[0];
    expect(message).toMatch(/only the workspace owner can buy a pack/i);
    expect(opts.action.label).toBe('Open Billing');
    opts.action.onClick();
    expect(navigate).toHaveBeenCalledWith('/billing');
  });

  /**
   * navigation.ts:501 makes /billing `managerOnly`, so a REP has no menu entry
   * for it. Offering the link anyway would send them to a page they cannot
   * otherwise reach — the copy names who can act instead.
   */
  it('gives a REP the member copy and NO action', async () => {
    setRole('REP');
    await fire(creditsError);

    const [message, opts] = toastError.mock.calls[0];
    expect(message).toMatch(/only the workspace owner can buy a pack/i);
    expect(opts.action).toBeUndefined();
  });

  it('falls through to the caller’s own message when the error is not a credit wall', async () => {
    setRole('OWNER');
    await fire({ response: { status: 500, data: { message: 'boom' } } });

    expect(toastError).toHaveBeenCalledWith('Generation failed');
  });

  /** Fan-out publishes fail once per target; one toast id collapses them. */
  it('tags the credits toast with a stable id so N failures do not stack N toasts', async () => {
    setRole('OWNER');
    await fire(creditsError);

    expect(toastError.mock.calls[0][1].id).toBe('ai-credits-exhausted');
  });
});
