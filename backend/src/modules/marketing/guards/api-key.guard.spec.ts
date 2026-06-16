import { ForbiddenException, UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';

function ctxFor(req: any): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

const AUTH = { apiKeyId: 'k1', workspaceId: 'ws-1', scopes: ['read', 'write'] };

function makeGuard(authReturn: any) {
  const apiKeys = { authenticate: jest.fn().mockResolvedValue(authReturn) };
  return { apiKeys, guard: new ApiKeyGuard(apiKeys as any) };
}

describe('ApiKeyGuard', () => {
  it('accepts a Bearer key with the write scope on a POST and attaches apiAuth', async () => {
    const { guard } = makeGuard(AUTH);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer mk_live_x' } };
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(req.apiAuth).toEqual({ workspaceId: 'ws-1', scopes: ['read', 'write'], apiKeyId: 'k1' });
  });

  it('accepts via the X-Api-Key header', async () => {
    const { guard } = makeGuard(AUTH);
    const req: any = { method: 'GET', headers: { 'x-api-key': 'mk_live_x' } };
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
  });

  it('401s when the key is missing', async () => {
    const { guard } = makeGuard(AUTH);
    await expect(guard.canActivate(ctxFor({ method: 'GET', headers: {} })))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401s when authenticate returns null', async () => {
    const { guard } = makeGuard(null);
    const req: any = { method: 'GET', headers: { authorization: 'Bearer mk_live_x' } };
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('403s a read-only key on a write method', async () => {
    const { guard } = makeGuard({ ...AUTH, scopes: ['read'] });
    const req: any = { method: 'POST', headers: { authorization: 'Bearer mk_live_x' } };
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
