import { NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { ApiKeysService } from './api-keys.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function makeSvc() {
  const prisma = mockPrismaClient();
  const svc = new ApiKeysService(prisma as any);
  return { prisma, svc };
}

describe('ApiKeysService', () => {
  it('creates a key, returns the raw value once, and stores only its hash', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.apiKey.create as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve({ id: 'k1', status: 'ACTIVE', createdAt: new Date(), ...args.data }),
    );
    const out: any = await svc.create(WS, 'Zapier', ['read', 'write'], 'u1');
    expect(out.key).toMatch(/^mk_live_/);
    expect(out.prefix).toBe(out.key.slice(0, 16));
    const createArg = (prisma.apiKey.create as jest.Mock).mock.calls[0][0];
    expect(createArg.data.keyHash).toBe(sha256(out.key));
    expect(createArg.data.keyHash).not.toEqual(out.key);
  });

  it('authenticates a valid active key to its workspace + scopes', async () => {
    const { prisma, svc } = makeSvc();
    const raw = 'mk_live_abc123';
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'k1', workspaceId: WS, status: 'ACTIVE', scopes: ['read', 'write'],
    } as any);
    const auth = await svc.authenticate(raw);
    expect(prisma.apiKey.findUnique).toHaveBeenCalledWith({ where: { keyHash: sha256(raw) } });
    expect(auth).toEqual({ apiKeyId: 'k1', workspaceId: WS, scopes: ['read', 'write'] });
  });

  it('rejects an unknown or revoked key', async () => {
    const { prisma, svc } = makeSvc();
    prisma.apiKey.findUnique.mockResolvedValueOnce(null as any);
    expect(await svc.authenticate('mk_live_x')).toBeNull();
    prisma.apiKey.findUnique.mockResolvedValueOnce({ id: 'k1', workspaceId: WS, status: 'REVOKED', scopes: [] } as any);
    expect(await svc.authenticate('mk_live_y')).toBeNull();
  });

  it('rejects a malformed key without hitting the DB', async () => {
    const { prisma, svc } = makeSvc();
    expect(await svc.authenticate('not-a-key')).toBeNull();
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it('revoke flips status and 404s an unknown key', async () => {
    const { prisma, svc } = makeSvc();
    prisma.apiKey.findFirst.mockResolvedValue({ id: 'k1' } as any);
    (prisma.apiKey.update as jest.Mock).mockResolvedValue({});
    expect(await svc.revoke(WS, 'k1')).toEqual({ id: 'k1', status: 'REVOKED' });

    prisma.apiKey.findFirst.mockResolvedValue(null as any);
    await expect(svc.revoke(WS, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
  });
});
