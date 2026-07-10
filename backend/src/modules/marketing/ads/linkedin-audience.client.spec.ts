// ── linkedinRest mock (the seam the DMP write client transports over) ────────
const mockLinkedinRest = jest.fn();
jest.mock('../../../common/util/linkedin-api.util', () => ({
  linkedinRest: (...args: unknown[]) => mockLinkedinRest(...args),
}));

import { createLinkedinDmpSegment, addLinkedinDmpUsers } from './linkedin-audience.client';

function ok(status: number, data: unknown, restliId: string | null = null) {
  return { ok: true, status, data, restliId, error: null };
}
function err(status: number, message: string, isAuthError: boolean) {
  return {
    ok: false,
    status,
    data: null,
    restliId: null,
    error: { message, status, serviceErrorCode: null, isAuthError, raw: {} },
  };
}

beforeEach(() => mockLinkedinRest.mockReset());

describe('createLinkedinDmpSegment', () => {
  it('creates a USER dmpSegment and returns the id from the x-restli-id header', async () => {
    mockLinkedinRest.mockResolvedValue(ok(201, null, '123456'));
    const out = await createLinkedinDmpSegment('tok', '512345', { name: 'CRM: VIP' });
    expect(out).toEqual({ ok: true, id: '123456' });

    const [path, opts] = mockLinkedinRest.mock.calls[0] as [string, any];
    expect(path).toBe('/rest/dmpSegments');
    expect(opts.method).toBe('POST');
    expect(opts.body).toMatchObject({
      name: 'CRM: VIP',
      account: 'urn:li:sponsoredAccount:512345',
      sourcePlatform: 'PROGRAMMATIC_MEDIA',
      type: 'USER',
      accessPolicy: 'PRIVATE',
    });
  });

  it('returns {ok:false,isAuthError:true} on a 401 (drives TOKEN_EXPIRED)', async () => {
    mockLinkedinRest.mockResolvedValue(err(401, 'Invalid access token', true));
    const out = await createLinkedinDmpSegment('tok', '512345', { name: 'x' });
    expect(out.ok).toBe(false);
    expect(out.isAuthError).toBe(true);
    expect(out.error).toContain('401');
  });

  it('returns a non-auth error on a 403 (permission gating stays retry-friendly)', async () => {
    mockLinkedinRest.mockResolvedValue(err(403, 'Not enough permissions', false));
    const out = await createLinkedinDmpSegment('tok', '512345', { name: 'x' });
    expect(out.ok).toBe(false);
    expect(out.isAuthError).toBe(false);
  });
});

describe('addLinkedinDmpUsers', () => {
  it('batch-adds SHA256_EMAIL users with the BATCH_CREATE method header', async () => {
    mockLinkedinRest.mockResolvedValue(ok(200, {}));
    const out = await addLinkedinDmpUsers('tok', '123456', ['h1', 'h2']);
    expect(out).toEqual({ ok: true, numAccepted: 2 });

    const [path, opts] = mockLinkedinRest.mock.calls[0] as [string, any];
    expect(path).toBe('/rest/dmpSegments/123456/users');
    expect(opts.method).toBe('POST');
    expect(opts.headers['X-RestLi-Method']).toBe('BATCH_CREATE');
    expect(opts.body.elements).toHaveLength(2);
    expect(opts.body.elements[0]).toMatchObject({
      action: 'ADD',
      userIds: [{ idType: 'SHA256_EMAIL', idValue: 'h1' }],
    });
  });

  it('splits into <=500-element batches (multi-request)', async () => {
    mockLinkedinRest.mockResolvedValue(ok(200, {}));
    const hashes = Array.from({ length: 501 }, (_, i) => `h${i}`);
    const out = await addLinkedinDmpUsers('tok', '123456', hashes);
    expect(mockLinkedinRest).toHaveBeenCalledTimes(2);
    expect(out.numAccepted).toBe(501);
    expect((mockLinkedinRest.mock.calls[0][1] as any).body.elements).toHaveLength(500);
    expect((mockLinkedinRest.mock.calls[1][1] as any).body.elements).toHaveLength(1);
  });

  it('drops blank hashes and makes no request for an all-empty list', async () => {
    const out = await addLinkedinDmpUsers('tok', '123456', ['', '']);
    expect(out).toEqual({ ok: true, numAccepted: 0 });
    expect(mockLinkedinRest).not.toHaveBeenCalled();
  });

  it('returns {ok:false} and stops on a failing batch', async () => {
    mockLinkedinRest.mockResolvedValue(err(403, 'Not enough permissions', false));
    const out = await addLinkedinDmpUsers('tok', '123456', ['h1']);
    expect(out.ok).toBe(false);
    expect(out.isAuthError).toBe(false);
  });
});
