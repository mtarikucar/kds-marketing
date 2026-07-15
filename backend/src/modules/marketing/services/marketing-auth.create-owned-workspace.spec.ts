import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MarketingAuthService } from './marketing-auth.service';
import { CreateWorkspaceDto } from '../dto/create-workspace.dto';

/**
 * Multi-workspace membership — F1 (self-serve second-workspace creation),
 * the missing headline flow closed by the final whole-branch review.
 * `registerWorkspace` is public and 409s on an existing email;
 * `AgencyService.createLocation` mints the child's OWN NEW owner. Neither
 * lets an ALREADY-LOGGED-IN identity create ANOTHER workspace they own.
 * `createOwnedWorkspace` runs the SAME scaffold provisionWorkspace uses
 * (workspace + SYSTEM sentinel + distribution config + TRIAL subscription),
 * but reuses the CALLER'S EXISTING identity as owner (no new MarketingUser,
 * no password) and mints a session scoped to the new workspace so the caller
 * lands in it immediately.
 *
 * A real JwtService (not a jest.fn() stub) is used — mirrors
 * marketing-auth.membership.spec.ts — so the assertions decode the ACTUAL
 * `wsp`/`role` claims the method produces, rather than trusting the return
 * shape alone.
 */
describe('MarketingAuthService — createOwnedWorkspace (F1)', () => {
  let prisma: any;
  let jwtService: JwtService;
  let svc: MarketingAuthService;

  const EXISTING_USER = {
    id: 'user-1',
    workspaceId: 'ws-home',
    email: 'ada@acme.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: null,
    avatar: null,
    // Any non-SYSTEM role — creating a NEW workspace has nothing to do with
    // the caller's role in their CURRENT workspace.
    role: 'MANAGER',
    status: 'ACTIVE',
    tokenVersion: 0,
  };

  const DTO: CreateWorkspaceDto = { workspaceName: 'Second Shop' } as CreateWorkspaceDto;

  beforeEach(() => {
    jwtService = new JwtService();
    prisma = {
      marketingUser: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'sys-1', role: 'SYSTEM' }),
        update: jest.fn().mockResolvedValue({}),
      },
      workspace: {
        findUnique: jest.fn().mockResolvedValue(null), // slug free
        create: jest.fn(),
      },
      marketingDistributionConfig: { create: jest.fn().mockResolvedValue({}) },
      workspaceMembership: { create: jest.fn().mockResolvedValue({}) },
      package: {
        findUnique: jest.fn().mockResolvedValue({ id: 'pkg-trial', trialDays: 14 }),
      },
      workspaceSubscription: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'MARKETING_JWT_SECRET') return 'access-secret';
        if (key === 'MARKETING_JWT_REFRESH_SECRET') return 'refresh-secret';
        if (key === 'BCRYPT_COST') return '10';
        return undefined;
      }),
    };
    const smsOtp = { issue: jest.fn(), verify: jest.fn() };
    const membership = { resolveDefaultWorkspaceId: jest.fn(), getActiveMembership: jest.fn() };
    svc = new MarketingAuthService(
      prisma,
      jwtService,
      config as any,
      smsOtp as any,
      membership as any,
    );
  });

  it('creates the workspace + an ACTIVE OWNER membership for the EXISTING user and mints a session scoped to it', async () => {
    prisma.marketingUser.findUnique.mockResolvedValue(EXISTING_USER);
    prisma.workspace.create.mockResolvedValue({
      id: 'ws-new',
      name: 'Second Shop',
      slug: 'second-shop',
    });

    const res: any = await svc.createOwnedWorkspace('user-1', DTO);

    // No new OWNER identity minted — the only marketingUser.create call is
    // the SYSTEM research sentinel.
    expect(prisma.marketingUser.create).toHaveBeenCalledTimes(1);
    const sentinelData = prisma.marketingUser.create.mock.calls[0][0].data;
    expect(sentinelData).toMatchObject({ workspaceId: 'ws-new', role: 'SYSTEM' });

    // The EXISTING user gets a fresh ACTIVE OWNER membership for the new workspace.
    expect(prisma.workspaceMembership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          workspaceId: 'ws-new',
          role: 'OWNER',
          status: 'ACTIVE',
        }),
      }),
    );
    const membershipData = prisma.workspaceMembership.create.mock.calls[0][0].data;
    expect(membershipData.acceptedAt).toBeInstanceOf(Date);

    // Home pointer moves so a plain next login lands here too.
    expect(prisma.marketingUser.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { workspaceId: 'ws-new' },
    });

    // The scaffold still runs: SYSTEM sentinel (asserted above) + distribution
    // config + TRIAL subscription — same as provisionWorkspace's own scaffold.
    expect(prisma.marketingDistributionConfig.create).toHaveBeenCalledWith({
      data: { workspaceId: 'ws-new', strategy: 'DISABLED' },
    });
    expect(prisma.workspaceSubscription.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: 'ws-new',
          packageId: 'pkg-trial',
          status: 'TRIALING',
        }),
      }),
    );

    // The minted session is scoped to the NEW workspace with OWNER — decode
    // the real JWT rather than trusting the return shape alone.
    const decoded: any = jwtService.decode(res.accessToken);
    expect(decoded.wsp).toBe('ws-new');
    expect(decoded.role).toBe('OWNER');
    expect(decoded.sub).toBe('user-1');
    expect(res.user).toMatchObject({ id: 'user-1', workspaceId: 'ws-new', role: 'OWNER' });
    expect(res.workspace).toMatchObject({ id: 'ws-new', name: 'Second Shop', slug: 'second-shop' });
  });

  it('defaults productName to the workspace name when the DTO omits it', async () => {
    prisma.marketingUser.findUnique.mockResolvedValue(EXISTING_USER);
    prisma.workspace.create.mockResolvedValue({
      id: 'ws-new',
      name: 'Second Shop',
      slug: 'second-shop',
    });

    await svc.createOwnedWorkspace('user-1', DTO);

    expect(prisma.workspace.create.mock.calls[0][0].data).toMatchObject({
      name: 'Second Shop',
      productName: 'Second Shop',
    });
  });

  it('rejects a SYSTEM identity (belt-and-suspenders — MarketingGuard already blocks it)', async () => {
    prisma.marketingUser.findUnique.mockResolvedValue({ ...EXISTING_USER, role: 'SYSTEM' });

    await expect(svc.createOwnedWorkspace('user-1', DTO)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.workspace.create).not.toHaveBeenCalled();
  });

  it('rejects an inactive user', async () => {
    prisma.marketingUser.findUnique.mockResolvedValue({ ...EXISTING_USER, status: 'INACTIVE' });

    await expect(svc.createOwnedWorkspace('user-1', DTO)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.workspace.create).not.toHaveBeenCalled();
  });

  it('rejects a missing user', async () => {
    prisma.marketingUser.findUnique.mockResolvedValue(null);

    await expect(svc.createOwnedWorkspace('ghost', DTO)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.workspace.create).not.toHaveBeenCalled();
  });
});
