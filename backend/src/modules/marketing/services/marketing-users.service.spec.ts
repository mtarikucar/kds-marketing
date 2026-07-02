import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { MarketingUsersService } from './marketing-users.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc(maxUsers: number) {
  const prisma = mockPrismaClient();
  // The seat-limit paths (create + reactivation) run under an advisory-locked
  // $transaction; make it execute the callback against the same mock client.
  (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
  (prisma.$queryRawUnsafe as any).mockResolvedValue([{ locked: 'x' }]);
  const config = { get: () => undefined } as any;
  const entitlements = { getEffective: jest.fn().mockResolvedValue({ maxUsers }) } as any;
  const svc = new MarketingUsersService(prisma as any, config, entitlements);
  return { prisma, svc, entitlements };
}

describe('MarketingUsersService — deactivate (delete) guards', () => {
  // A MANAGER could deactivate a MANAGER — including THEMSELVES — locking
  // themselves out mid-session (only another admin can reactivate). The OWNER is
  // already protected; this closes the same footgun for self-deactivation.
  it('refuses to let an actor deactivate their own account', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.marketingUser.findFirst.mockResolvedValue({ id: 'mgr-1', workspaceId: WS, role: 'MANAGER', status: 'ACTIVE' } as any);
    await expect((svc.delete as any)(WS, 'mgr-1', 'MANAGER', 'mgr-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
  });

  it('allows a manager to deactivate a DIFFERENT manager', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.marketingUser.findFirst.mockResolvedValue({ id: 'mgr-2', workspaceId: WS, role: 'MANAGER', status: 'ACTIVE' } as any);
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
    await (svc.delete as any)(WS, 'mgr-2', 'MANAGER', 'mgr-1');
    expect(prisma.marketingUser.update).toHaveBeenCalled();
  });
});

describe('MarketingUsersService — update() deactivation guards (parity with delete())', () => {
  // update() writes dto.status, so `status: 'INACTIVE'` deactivates a user — but it
  // must NOT bypass the same guards delete() enforces, or a user locks themselves
  // out (self-deactivation) / the OWNER account gets deactivated via a PATCH.
  it('refuses to let an actor deactivate THEIR OWN account via a status update', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.marketingUser.findFirst.mockResolvedValue({ id: 'mgr-1', workspaceId: WS, role: 'MANAGER', status: 'ACTIVE', email: 'm@x.co' } as any);
    await expect((svc.update as any)(WS, 'mgr-1', { status: 'INACTIVE' }, 'MANAGER', 'mgr-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
  });

  it('refuses to deactivate the OWNER account via a status update', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.marketingUser.findFirst.mockResolvedValue({ id: 'owner-1', workspaceId: WS, role: 'OWNER', status: 'ACTIVE', email: 'o@x.co' } as any);
    await expect((svc.update as any)(WS, 'owner-1', { status: 'INACTIVE' }, 'OWNER', 'owner-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
  });

  it('still allows deactivating a DIFFERENT user via a status update', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.marketingUser.findFirst.mockResolvedValue({ id: 'mgr-2', workspaceId: WS, role: 'MANAGER', status: 'ACTIVE', email: 'm2@x.co' } as any);
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({ id: 'mgr-2' });
    await (svc.update as any)(WS, 'mgr-2', { status: 'INACTIVE' }, 'MANAGER', 'mgr-1');
    expect(prisma.marketingUser.update).toHaveBeenCalled();
  });
});

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

  // A bare seat-count-then-write lets two concurrent seat-consuming requests at
  // (cap-1) BOTH pass and exceed maxUsers. The seat-check + write is serialized
  // under a per-workspace advisory xact-lock (the research / knowledge pattern).
  describe('seat-limit — advisory-lock race safety', () => {
    it('create() serializes the seat-check + create under a per-workspace advisory lock', async () => {
      const { prisma, svc } = makeSvc(5);
      prisma.marketingUser.findUnique.mockResolvedValue(null);
      (prisma.marketingUser.count as jest.Mock).mockResolvedValue(4);
      (prisma.marketingUser.create as jest.Mock).mockResolvedValue({ id: 'u1' });
      await svc.create(WS, { email: 'a@b.com', password: 'Abcd1234', role: 'REP' } as any);
      expect(prisma.$transaction).toHaveBeenCalled();
      const lockSql = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0][0] as string;
      expect(lockSql).toContain('pg_advisory_xact_lock');
      expect(lockSql).toContain('users:ws-1');
      expect(prisma.marketingUser.create).toHaveBeenCalled();
    });

    it('reactivation locks the seat-check + the ACTIVE flip', async () => {
      const { prisma, svc } = makeSvc(5);
      prisma.marketingUser.findFirst.mockResolvedValue({ id: 'u1', workspaceId: WS, role: 'REP', status: 'INACTIVE' } as any);
      (prisma.marketingUser.count as jest.Mock).mockResolvedValue(4);
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({ id: 'u1' });
      await svc.update(WS, 'u1', { status: 'ACTIVE' } as any, 'MANAGER');
      expect(prisma.$transaction).toHaveBeenCalled();
      const lockSql = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0][0] as string;
      expect(lockSql).toContain('users:ws-1');
      expect(prisma.marketingUser.update).toHaveBeenCalled();
    });

    it('create() on an unlimited (-1) plan skips the lock', async () => {
      const { prisma, svc } = makeSvc(-1);
      prisma.marketingUser.findUnique.mockResolvedValue(null);
      (prisma.marketingUser.create as jest.Mock).mockResolvedValue({ id: 'u1' });
      await svc.create(WS, { email: 'a@b.com', password: 'Abcd1234', role: 'REP' } as any);
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(prisma.marketingUser.create).toHaveBeenCalled();
    });
  });

  describe('update() email change', () => {
    it('rejects changing the email to one already used by another user (clean 409, not a 500)', async () => {
      const { prisma, svc } = makeSvc(-1);
      prisma.marketingUser.findFirst.mockResolvedValue({
        id: 'u1',
        workspaceId: WS,
        role: 'REP',
        status: 'ACTIVE',
        email: 'old@b.com',
      } as any);
      // Another user already owns the target email.
      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u2' } as any);

      await expect(
        svc.update(WS, 'u1', { email: 'taken@b.com' } as any, 'MANAGER'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.marketingUser.update).not.toHaveBeenCalled();
    });

    it('allows changing the email to an unused address', async () => {
      const { prisma, svc } = makeSvc(-1);
      prisma.marketingUser.findFirst.mockResolvedValue({
        id: 'u1',
        workspaceId: WS,
        role: 'REP',
        status: 'ACTIVE',
        email: 'old@b.com',
      } as any);
      prisma.marketingUser.findUnique.mockResolvedValue(null); // free
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({ id: 'u1', email: 'new@b.com' });

      await expect(
        svc.update(WS, 'u1', { email: 'new@b.com' } as any, 'MANAGER'),
      ).resolves.toMatchObject({ id: 'u1' });
    });

    it('does not treat re-saving the SAME email as a conflict', async () => {
      const { prisma, svc } = makeSvc(-1);
      prisma.marketingUser.findFirst.mockResolvedValue({
        id: 'u1',
        workspaceId: WS,
        role: 'REP',
        status: 'ACTIVE',
        email: 'same@b.com',
      } as any);
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({ id: 'u1' });

      await expect(
        svc.update(WS, 'u1', { email: 'same@b.com', firstName: 'X' } as any, 'MANAGER'),
      ).resolves.toBeDefined();
      // No uniqueness lookup needed when the email is unchanged.
      expect(prisma.marketingUser.findUnique).not.toHaveBeenCalled();
    });
  });
});
