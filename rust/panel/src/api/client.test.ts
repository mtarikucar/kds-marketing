import { afterEach, describe, expect, it, vi } from 'vitest';
import { whoami } from './agents';
import { ApiError, request, setUnauthorizedHandler } from './client';
import { mockFetch } from '@/test/render';

function answer(status: number, body: unknown) {
  const stub = vi.fn(async () =>
    body === undefined
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
  );
  vi.stubGlobal('fetch', stub);
  return stub;
}

describe('api client', () => {
  afterEach(() => setUnauthorizedHandler(() => {}));

  it('sets X-Requested-With on POST and not on GET', async () => {
    const calls = mockFetch({ 'POST /api/auth/login': { ok: true }, 'GET /api/team': [] });
    await request('POST', '/api/auth/login', { body: { email: 'a@b.example', password: 'x' } });
    await request('GET', '/api/team');
    expect(calls[0].headers.get('x-requested-with')).toBe('jeeta-panel');
    expect(calls[0].headers.get('content-type')).toBe('application/json');
    expect(calls[0].body).toEqual({ email: 'a@b.example', password: 'x' });
    expect(calls[1].headers.get('x-requested-with')).toBeNull();
  });

  it('sets X-Requested-With on every mutating method', async () => {
    const calls = mockFetch({
      'PATCH /api/roles/r1': {},
      'PUT /api/x': {},
      'DELETE /api/api-keys/k1': null,
    });
    await request('PATCH', '/api/roles/r1', { body: { permissions: [] } });
    await request('PUT', '/api/x', { body: {} });
    await request('DELETE', '/api/api-keys/k1');
    expect(calls.map((c) => c.headers.get('x-requested-with'))).toEqual([
      'jeeta-panel',
      'jeeta-panel',
      'jeeta-panel',
    ]);
  });

  it('sends cookies same-origin only', async () => {
    const stub = answer(200, []);
    await request('GET', '/api/team');
    const init = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(init[1].credentials).toBe('same-origin');
  });

  it('asks who the caller is at /api/whoami', async () => {
    const answer = {
      actor: { kind: 'human', user_id: 'u1' },
      workspace_id: 'w1',
      role_key: 'owner',
      permissions: ['workspace.read'],
    };
    const calls = mockFetch({ 'GET /api/whoami': answer });
    await expect(whoami()).resolves.toEqual(answer);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get('x-requested-with')).toBeNull();
  });

  it('adds query parameters and skips empty ones', async () => {
    const calls = mockFetch({ 'GET /api/ledger': [] });
    await request('GET', '/api/ledger', {
      query: { action_prefix: 'team.', before_id: 7, actor_kind: undefined, limit: null },
    });
    expect(calls[0].search).toBe('?action_prefix=team.&before_id=7');
  });

  it('returns undefined for 204', async () => {
    answer(204, undefined);
    await expect(request('DELETE', '/api/team/m1')).resolves.toBeUndefined();
  });

  it('parses the structured error body', async () => {
    answer(409, { code: 'CONFLICT', message: 'cannot demote the last owner', details: { reason: 'last_owner' } });
    const err = await request('PATCH', '/api/team/m1/role', { body: { role_key: 'rep' } }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'CONFLICT',
      message: 'cannot demote the last owner',
      details: { reason: 'last_owner' },
      status: 409,
    });
  });

  it('turns an error without a structured body into an ApiError too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad gateway', { status: 502 })),
    );
    const err = await request('GET', '/api/team').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INTERNAL', status: 502, details: {} });
  });

  it('turns a network failure into a NETWORK error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const err = await request('GET', '/api/team').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'NETWORK', status: 0 });
  });

  it('sends a 401 to the user login, or the platform login for platform routes', async () => {
    const targets: string[] = [];
    setUnauthorizedHandler((target) => targets.push(target));
    const body = { code: 'UNAUTHENTICATED', message: 'not signed in', details: {} };
    answer(401, body);
    await expect(request('GET', '/api/team')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    answer(401, body);
    await expect(request('GET', '/api/platform/workspaces')).rejects.toMatchObject({ status: 401 });
    expect(targets).toEqual(['/login', '/platform/login']);
  });

  it('leaves a 401 to the caller when asked to', async () => {
    const targets: string[] = [];
    setUnauthorizedHandler((target) => targets.push(target));
    answer(401, { code: 'UNAUTHENTICATED', message: 'invalid email or password', details: {} });
    await expect(
      request('POST', '/api/auth/login', { body: {}, redirectOn401: false }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(targets).toEqual([]);
  });
});
