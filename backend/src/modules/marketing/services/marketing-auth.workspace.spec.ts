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
  let membership: { resolveDefaultWorkspaceId: jest.Mock; getActiveMembership: jest.Mock };
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
      workspaceMembership: {
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
    const smsOtp = { issue: jest.fn(), verify: jest.fn() };
    // registerWorkspace never touches MembershipService (the owner IS the
    // first/only member, minted directly by generateTokens). The login-gate
    // tests below resolve the default membership onto the user's own home
    // workspace ('ws-1') with 'REP' (baseUser.role there) — none of their
    // assertions check the role claim, so this generic default is enough to
    // keep their pre-existing assertions (which predate MembershipService)
    // holding without per-test overrides.
    membership = {
      resolveDefaultWorkspaceId: jest.fn(async (_userId: string, homeWorkspaceId: string) => homeWorkspaceId),
      getActiveMembership: jest.fn(async (_userId: string, workspaceId: string) => ({
        workspaceId,
        role: 'REP',
        customRoleId: null,
      })),
    };
    svc = new MarketingAuthService(prisma, jwt as any, config as any, smsOtp as any, membership as any);
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
      // Self-serve signup collects no currency; default to TRY (the only PSP
      // live in prod is PayTR, which is TRY-only — a USD workspace can't pay).
      expect(wsData.defaultCurrency).toBe('TRY');

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
        currency: 'TRY',
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

    it('registerWorkspace creates an ACTIVE OWNER membership for the owner', async () => {
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

      await svc.registerWorkspace(DTO);

      expect(prisma.workspaceMembership.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'owner-1',
            workspaceId: 'ws-new',
            role: 'OWNER',
            status: 'ACTIVE',
          }),
        }),
      );
      // acceptedAt must be a real timestamp, not left null — an OWNER
      // membership is never a pending invite.
      const membershipData = prisma.workspaceMembership.create.mock.calls[0][0].data;
      expect(membershipData.acceptedAt).toBeInstanceOf(Date);
      // Exactly one membership — the SYSTEM research sentinel (the other
      // marketingUser.create call) never gets one; it can't authenticate.
      expect(prisma.workspaceMembership.create).toHaveBeenCalledTimes(1);
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

    /**
     * `Workspace.timezone` shipped with the first migration and a 'UTC'
     * default, and until this capture nothing on the self-serve path ever wrote
     * it — the only writer in the whole codebase was agency.service's
     * createLocation, which a customer never reaches. So every workspace that
     * ever signed up itself held 'UTC', while five separate consumers read the
     * column as though it were an answer: the dashboard aggregates, the tasks
     * list, sales targets, the daily-digest cron, and the Growth Studio rail on
     * the client. A Turkey workspace's "today" therefore ran 03:00→03:00
     * Istanbul, dropping its own early-morning rows off the top of every
     * today/this-week list and borrowing tomorrow's at the bottom.
     *
     * Registration is the one moment the zone can be learned without asking
     * anybody a question, so these three tests pin what it does with the answer:
     * pass a real zone through, ignore a junk one rather than poisoning the
     * column with it, and leave the field alone when the client says nothing so
     * the schema default still applies.
     */
    async function registerWith(dtoExtras: Record<string, unknown>) {
      prisma.marketingUser.findUnique.mockResolvedValue(null);
      prisma.workspace.findUnique.mockResolvedValue(null);
      prisma.workspace.create.mockResolvedValue({ ...WORKSPACE, id: 'ws-new' });
      prisma.marketingUser.create.mockResolvedValue({
        id: 'owner-1', workspaceId: 'ws-new', email: DTO.email,
        firstName: 'Ada', lastName: 'Lovelace', phone: null, avatar: null,
        role: 'OWNER', tokenVersion: 0,
      });
      await svc.registerWorkspace({ ...DTO, ...dtoExtras } as any);
      return prisma.workspace.create.mock.calls[0][0].data;
    }

    it('captures the browser timezone the client volunteered, so the workspace is not born on UTC', async () => {
      expect((await registerWith({ timezone: 'Europe/Istanbul' })).timezone).toBe('Europe/Istanbul');
    });

    it('leaves the column to its schema default when the client sends no zone', async () => {
      // An older frontend, or a non-browser caller: it must still sign up, and
      // it must land exactly where every pre-existing workspace already is
      // rather than on some zone we invented for it.
      expect((await registerWith({})).timezone).toBeUndefined();
    });

    it('refuses a junk zone at the service, not just at the DTO', async () => {
      // The decorator is the gate for HTTP callers, but this method is a plain
      // function a future path could reach with no ValidationPipe in front of
      // it — and a bad zone in this column fails NOWHERE loudly: every reader
      // wraps Intl in a try/catch and falls back, so the only symptom is dates
      // that are quietly wrong for one workspace forever.
      for (const junk of ['Mars/Olympus_Mons', '+03:00', '']) {
        prisma.workspace.create.mockClear();
        expect((await registerWith({ timezone: junk })).timezone).toBeUndefined();
      }
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
      // login() now returns a union: the success branch (with `user`) or a
      // 2FA-challenge branch. baseUser has 2FA off, so this is the success
      // path — narrow to it before asserting workspace isolation.
      expect('user' in res).toBe(true);
      if (!('user' in res)) throw new Error('expected a non-2FA login result');
      expect(res.user.workspaceId).toBe('ws-1');
    });
  });
});
