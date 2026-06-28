import { BadRequestException } from '@nestjs/common';
import { MarketingUsersService } from './marketing-users.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc(maxUsers: number) {
  const prisma = mockPrismaClient();
  const config = { get: () => undefined } as any;
  const entitlements = { getEffective: jest.fn().mockResolvedValue({ maxUsers }) } as any;
  const svc = new MarketingUsersService(prisma as any, config, entitlements);
  return { prisma, svc, entitlements };
}

describe('MarketingUsersService — seat limit', () => {
  describe('update() reactivation', () => {
    it('rejects reactivating an INACTIVE user when the workspace is at its seat cap', async () => {
      const { prisma, svc } = makeSvc(5);
      prisma.marketingUser.findFirst.mockResolvedValue({
        id: 'u1',
        workspaceId: WS,
        role: 'REP',
        status: 'INACTIVE',
      } as any);
      // Already 5 active seats — reactivating u1 would make 6.
      (prisma.marketingUser.count as jest.Mock).mockResolvedValue(5);

      await expect(
        svc.update(WS, 'u1', { status: 'ACTIVE' } as any, 'MANAGER'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.marketingUser.update).not.toHaveBeenCalled();
    });

    it('allows reactivation when a seat is free', async () => {
      const { prisma, svc } = makeSvc(5);
      prisma.marketingUser.findFirst.mockResolvedValue({
        id: 'u1',
        workspaceId: WS,
        role: 'REP',
        status: 'INACTIVE',
      } as any);
      (prisma.marketingUser.count as jest.Mock).mockResolvedValue(4); // room for one more
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({ id: 'u1', status: 'ACTIVE' });

      await expect(
        svc.update(WS, 'u1', { status: 'ACTIVE' } as any, 'MANAGER'),
      ).resolves.toMatchObject({ id: 'u1' });
      expect(prisma.marketingUser.update).toHaveBeenCalled();
    });

    it('does NOT seat-check a no-op (already ACTIVE) or a non-status edit', async () => {
      const { prisma, svc } = makeSvc(5);
      prisma.marketingUser.findFirst.mockResolvedValue({
        id: 'u1',
        workspaceId: WS,
        role: 'REP',
        status: 'ACTIVE',
      } as any);
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({ id: 'u1' });

      // status ACTIVE on an already-ACTIVE user, and a plain name edit — neither
      // consumes a new seat, so neither must hit the (cap-exceeded) limit.
      (prisma.marketingUser.count as jest.Mock).mockResolvedValue(5);
      await expect(
        svc.update(WS, 'u1', { status: 'ACTIVE', firstName: 'New' } as any, 'MANAGER'),
      ).resolves.toBeDefined();
      await expect(
        svc.update(WS, 'u1', { firstName: 'Other' } as any, 'MANAGER'),
      ).resolves.toBeDefined();
    });

    it('skips the limit entirely on an unlimited (-1) package', async () => {
      const { prisma, svc } = makeSvc(-1);
      prisma.marketingUser.findFirst.mockResolvedValue({
        id: 'u1',
        workspaceId: WS,
        role: 'REP',
        status: 'INACTIVE',
      } as any);
      (prisma.marketingUser.count as jest.Mock).mockResolvedValue(9999);
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({ id: 'u1' });
      await expect(
        svc.update(WS, 'u1', { status: 'ACTIVE' } as any, 'MANAGER'),
      ).resolves.toBeDefined();
    });
  });

  describe('create()', () => {
    it('still enforces the seat cap (shared check)', async () => {
      const { prisma, svc } = makeSvc(5);
      prisma.marketingUser.findUnique.mockResolvedValue(null); // email free
      (prisma.marketingUser.count as jest.Mock).mockResolvedValue(5); // at cap
      await expect(
        svc.create(WS, { email: 'a@b.com', password: 'Abcd1234', role: 'REP' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
