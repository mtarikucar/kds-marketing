import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import {
  IngestTokenGuard,
  hashIngestToken,
  INGEST_TOKEN_PREFIX,
} from './ingest-token.guard';

/**
 * DB-backed per-workspace ingest tokens (Phase E): the guard hashes the
 * presented token, resolves the owning workspace and attaches it to the
 * request. Revoked/unknown tokens die with the same generic 401.
 */
describe('IngestTokenGuard — per-workspace hashed tokens', () => {
  const RAW = `${INGEST_TOKEN_PREFIX}${'a'.repeat(48)}`;

  let prisma: {
    ingestToken: { findUnique: jest.Mock; update: jest.Mock };
  };
  let guard: IngestTokenGuard;
  let request: any;

  function ctx(): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    prisma = {
      ingestToken: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    guard = new IngestTokenGuard(prisma as any);
    request = { headers: { 'x-ingest-token': RAW } };
  });

  it('accepts an ACTIVE token, attaches its workspace and looks up by sha256 (never the raw)', async () => {
    prisma.ingestToken.findUnique.mockResolvedValue({
      id: 'tok-1',
      workspaceId: 'ws-1',
      status: 'ACTIVE',
    });

    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(request.ingestWorkspaceId).toBe('ws-1');

    const where = prisma.ingestToken.findUnique.mock.calls[0][0].where;
    expect(where.tokenHash).toBe(hashIngestToken(RAW));
    expect(where.tokenHash).not.toContain(RAW);
  });

  it('rejects unknown tokens', async () => {
    prisma.ingestToken.findUnique.mockResolvedValue(null);
    await expect(guard.canActivate(ctx())).rejects.toThrow(UnauthorizedException);
  });

  it('rejects REVOKED tokens with the same generic error', async () => {
    prisma.ingestToken.findUnique.mockResolvedValue({
      id: 'tok-1',
      workspaceId: 'ws-1',
      status: 'REVOKED',
    });
    await expect(guard.canActivate(ctx())).rejects.toThrow('Invalid ingest token');
  });

  it('rejects a missing header without touching the database', async () => {
    request = { headers: {} };
    await expect(guard.canActivate(ctx())).rejects.toThrow('Missing ingest token');
    expect(prisma.ingestToken.findUnique).not.toHaveBeenCalled();
  });

  it('does not fail the request when the lastUsedAt telemetry write breaks', async () => {
    prisma.ingestToken.findUnique.mockResolvedValue({
      id: 'tok-1',
      workspaceId: 'ws-1',
      status: 'ACTIVE',
    });
    prisma.ingestToken.update.mockRejectedValue(new Error('db hiccup'));
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });
});
