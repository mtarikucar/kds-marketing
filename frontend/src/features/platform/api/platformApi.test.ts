import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above the module body, so the stubs it closes over must be
// created inside vi.hoisted rather than as plain consts.
const { get, patch } = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));

// axios.create() is called at module load; hand it a stub with the interceptor
// surface the real client wires up.
vi.mock('axios', () => ({
  default: {
    create: () => ({
      get,
      patch,
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    }),
  },
}));

vi.mock('../../../store/platformAuthStore', () => ({
  usePlatformAuthStore: { getState: () => ({ accessToken: 'tok', logout: vi.fn() }) },
}));

import { listPackages, assignPackage } from './platformApi';

const GROWTH = {
  code: 'GROWTH',
  name: 'Growth',
  description: null,
  isPublic: true,
  sortOrder: 2,
  trialDays: 0,
  prices: { monthlyTRY: 2400, monthlyUSD: 79, yearlyTRY: null, yearlyUSD: null },
  limits: { dailyLeadQuota: 50 },
};
const OPERATOR = { ...GROWTH, code: 'OPERATOR', name: 'Operator (internal)', isPublic: false };

describe('platformApi.listPackages', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GETs the PLATFORM-realm catalog, not the marketing pricing route', async () => {
    get.mockResolvedValue({ data: [GROWTH, OPERATOR] });
    await listPackages();
    expect(get).toHaveBeenCalledWith('/packages');
    // baseURL is `${API_URL}/platform`, so this can never hit marketing/billing.
    expect(get.mock.calls[0][0]).not.toMatch(/billing/);
  });

  it('returns the catalog including non-public internal packages', async () => {
    get.mockResolvedValue({ data: [GROWTH, OPERATOR] });
    const packages = await listPackages();
    expect(packages.map((p) => p.code)).toEqual(['GROWTH', 'OPERATOR']);
    expect(packages.find((p) => p.code === 'OPERATOR')!.isPublic).toBe(false);
  });
});

describe('platformApi.assignPackage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PATCHes /workspaces/:id/subscription with the package code', async () => {
    patch.mockResolvedValue({
      data: { workspaceId: 'ws-1', packageCode: 'OPERATOR', changed: true },
    });
    const res = await assignPackage('ws-1', 'OPERATOR');

    expect(patch).toHaveBeenCalledWith('/workspaces/ws-1/subscription', {
      packageCode: 'OPERATOR',
    });
    expect(res).toEqual(expect.objectContaining({ changed: true }));
  });

  it('surfaces changed:false rather than normalising it away', async () => {
    patch.mockResolvedValue({
      data: { workspaceId: 'ws-1', packageCode: 'OPERATOR', changed: false },
    });
    expect((await assignPackage('ws-1', 'OPERATOR')).changed).toBe(false);
  });

  it('rejects with the axios error untouched so callers can read the 400 body', async () => {
    const err = {
      response: { status: 400, data: { message: 'Unknown package code "X". Valid codes: TRIAL, OPERATOR' } },
    };
    patch.mockRejectedValue(err);
    await expect(assignPackage('ws-1', 'X')).rejects.toBe(err);
  });
});
