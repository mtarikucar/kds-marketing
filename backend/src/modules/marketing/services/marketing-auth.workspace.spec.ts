import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { MarketingAuthService } from './marketing-auth.service';
import * as bcrypt from 'bcryptjs';

/**
 * Workspace-era auth contract: signup provisions the whole workspace in one
 * tx (org + OWNER + SYSTEM sentinel + distribution config), tokens carry the
 * wsp claim, and login refuses sentinels and non-ACTIVE workspaces.
 */
describe('MarketingAuthService — workspace signup + login gates', () => {
  let prisma: any;
  let jwt: { sign: jest.Mock; verifyAsync: jest.Mock };
  let config: { get: jest.Mock };
  let svc: MarketingAuthService;

  const WORKSPACE = { id: 'ws-1', slug: 'acme', status: 'ACTIVE' };

  beforeEach(() => {
    prisma = {
      marketingUser: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      workspace: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      marketingDistributionConfig: {
        create: jest.fn().mockResolvedValue({}),
      },
      package: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'pkg-trial', trialDays: 14 }),
      },
      workspaceSubscription: {
        create: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    jwt = { sign: jest.fn().mockReturnValue('signed'), verifyAsync: jest.fn() };
    config = {
      get: jest.fn((key: string) => {
        if (key === 'MARKETING_JWT_SECRET') return 'access-secret';
        if (key === 'MARKETING_JWT_REFRESH_SECRET') return 'refresh-secret';
        if (key === 'BCRYPT_COST') return '10';
        return undefined;
      }),
    };
    svc = new MarketingAuthService(prisma, jwt as any, config as any);
  });

  describe('registerWorkspace', () => {
    const DTO = {
      workspaceName: 'Acme Inc.',
      productName: 'Acme CRM',
      email: 'owner@acme.test',
      password: 'Passw0rd1',
      firstName: 'Ada',
      lastName: 'Lovelace',
    } as any;

    it('creates workspace + OWNER + SYSTEM sentinel + distribution config in one tx', async () => {
      prisma.marketingUser.findUnique.mockResolvedValue(null); // email free
      prisma.workspace.findUnique.mockResolvedValue(null); // slug free
      prisma.workspace.create.mockResolvedValue({ ...WORKSPACE, id: 'ws-new' });
      prisma.marketingUser.create
        .mockResolvedValueOnce({
          id: 'owner-1',
          workspaceId: 'ws-new',
          email: DTO.email,
          firstName: 'Ada',
          lastName: 'Lovelace',
          phone: null,
          avatar: null,
          role: 'OWNER',
          tokenVersion: 0,
        })
        .mockResolvedValueOnce({ id: 'sys-1', role: 'SYSTEM' });

      const res = await svc.registerWorkspace(DTO, '1.2.3.4');

      // Workspace born with slugified handle + default taxonomy.
      const wsData = prisma.workspace.create.mock.calls[0][0].data;
      expect(wsData.slug).toBe('acme-inc');
      expect(wsData.settings.businessTypes).toContain('OTHER');

      // First create = OWNER, second = SYSTEM sentinel (unguessable email).
      const ownerData = prisma.marketingUser.create.mock.calls[0][0].data;
      expect(ownerData).toMatchObject({ workspaceId: 'ws-new', role: 'OWNER' });
      const sentinelData = prisma.marketingUser.create.mock.calls[1][0].data;
      expect(sentinelData).toMatchObject({ workspaceId: 'ws-new', role: 'SYSTEM' });
      expect(sentinelData.email).toContain('ws-new');

      expect(prisma.marketingDistributionConfig.create).toHaveBeenCalledWith({
        data: { workspaceId: 'ws-new', strategy: 'DISABLED' },
      });

      // Signup lands every workspace on the TRIAL package.
      const trialSub = prisma.workspaceSubscription.create.mock.calls[0][0].data;
      expect(trialSub).toMatchObject({
        workspaceId: 'ws-new',
        packageId: 'pkg-trial',
        status: 'TRIALING',
      });
      expect(trialSub.trialEndsAt.getTime()).toBeGreaterThan(Date.now());

      // Token payload carries the workspace claim.
      expect(jwt.sign.mock.calls[0][0]).toMatchObject({
        sub: 'owner-1',
        wsp: 'ws-new',
        role: 'OWNER',
        type: 'marketing',
      });
      expect(res.user).toMatchObject({ workspaceId: 'ws-new', role: 'OWNER' });
    });

    it('suffixes the slug when taken', async () => {
      prisma.marketingUser.findUnique.mockResolvedValue(null);
      prisma.workspace.findUnique
        .mockResolvedValueOnce({ id: 'other' }) // "acme-inc" taken
        .mockResolvedValueOnce(null); // "acme-inc-2" free
      prisma.workspace.create.mockResolvedValue({ ...WORKSPACE, id: 'ws-new' });
      prisma.marketingUser.create.mockResolvedValue({
        id: 'owner-1', workspaceId: 'ws-new', email: DTO.email,
        firstName: 'Ada', lastName: 'Lovelace', phone: null, avatar: null,
        role: 'OWNER', tokenVersion: 0,
      });

      await svc.registerWorkspace(DTO);
      expect(prisma.workspace.create.mock.calls[0][0].data.slug).toBe('acme-inc-2');
    });

    it('survives an unseeded catalog: no TRIAL package → no subscription, signup still works', async () => {
      prisma.marketingUser.findUnique.mockResolvedValue(null);
      prisma.workspace.findUnique.mockResolvedValue(null);
      prisma.package.findUnique.mockResolvedValue(null);
      prisma.workspace.create.mockResolvedValue({ ...WORKSPACE, id: 'ws-new' });
      prisma.marketingUser.create.mockResolvedValue({
        id: 'owner-1', workspaceId: 'ws-new', email: DTO.email,
        firstName: 'Ada', lastName: 'Lovelace', phone: null, avatar: null,
        role: 'OWNER', tokenVersion: 0,
      });

      const res = await svc.registerWorkspace(DTO);
      expect(res.user).toMatchObject({ workspaceId: 'ws-new' });
      expect(prisma.workspaceSubscription.create).not.toHaveBeenCalled();
    });

    it('rejects an already-registered email before any insert', async () => {
      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'existing' });
      await expect(svc.registerWorkspace(DTO)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.workspace.create).not.toHaveBeenCalled();
    });
  });

  describe('login gates', () => {
    const baseUser = {
      id: 'u-1',
      workspaceId: 'ws-1',
      email: 'rep@acme.test',
      password: bcrypt.hashSync('Passw0rd1', 4),
      firstName: 'R',
      lastName: 'One',
      phone: null,
      avatar: null,
      role: 'REP',
      status: 'ACTIVE',
      failedLogins: 0,
      lockedUntil: null,
      tokenVersion: 0,
    };

    it('refuses SYSTEM sentinels with the generic credentials error', async () => {
      prisma.marketingUser.findUnique.mockResolvedValue({ ...baseUser, role: 'SYSTEM' });
      await expect(
        svc.login({ email: baseUser.email, password: 'Passw0rd1' } as any),
      ).rejects.toThrow('Invalid credentials');
    });

    it('refuses logins into a SUSPENDED workspace', async () => {
      prisma.marketingUser.findUnique.mockResolvedValue({ ...baseUser });
      prisma.workspace.findUnique.mockResolvedValue({ status: 'SUSPENDED' });
      await expect(
        svc.login({ email: baseUser.email, password: 'Passw0rd1' } as any),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('mints wsp-claim tokens for a healthy login', async () => {
      prisma.marketingUser.findUnique.mockResolvedValue({ ...baseUser });
      prisma.workspace.findUnique.mockResolvedValue({ status: 'ACTIVE' });

      const res = await svc.login(
        { email: baseUser.email, password: 'Passw0rd1' } as any,
        '1.2.3.4',
      );
      expect(jwt.sign.mock.calls[0][0]).toMatchObject({ wsp: 'ws-1' });
      expect(res.user.workspaceId).toBe('ws-1');
    });
  });
});
