import 'reflect-metadata';
import { CanActivate, ExecutionContext, ForbiddenException, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MediaModelDefaultsService } from '../ai/media/media-model-defaults.service';
import { MarketingWorkspacesController } from './marketing-workspaces.controller';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RolesService } from '../roles/roles.service';
import { MarketingAuthService } from '../services/marketing-auth.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { MARKETING_ROLES_KEY } from '../decorators/marketing-roles.decorator';
import { REQUIRE_PERMISSION_KEY } from '../roles/require-permission.decorator';
import { AUDIT_METADATA } from '../../audit/audit.decorator';

/**
 * MCP write-surface activation — the switch that lets a workspace opt out of
 * the human approval gate for MCP tool calls. The most safety-sensitive
 * endpoint in the whole plan: getting the role gate wrong in the permissive
 * direction lets a MANAGER disable it.
 *
 * Reads @MarketingRoles metadata directly off the prototype (mirrors
 * MarketingUsersController's `requiredPermission()` pattern for
 * @RequirePermission) — no DI, no mocking, just pins the decorator — and then
 * feeds that SAME metadata through the real MarketingRolesGuard so "refuses a
 * non-OWNER" is proven against the actual guard logic, not asserted in the
 * abstract.
 */
function requiredRoles(method: string): unknown {
  return Reflect.getMetadata(
    MARKETING_ROLES_KEY,
    (MarketingWorkspacesController.prototype as Record<string, unknown>)[method] as object,
  );
}

function auditAction(method: string): unknown {
  const meta = Reflect.getMetadata(
    AUDIT_METADATA,
    (MarketingWorkspacesController.prototype as Record<string, unknown>)[method] as object,
  );
  return meta?.action;
}

function ctxFor(handler: (...args: unknown[]) => unknown, role?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ marketingUser: role ? { role } : undefined }),
    }),
    getHandler: () => handler,
    getClass: () => MarketingWorkspacesController,
  } as unknown as ExecutionContext;
}

describe('MarketingWorkspacesController — mcp-write-mode', () => {
  describe('delegation', () => {
    it('getMcpWriteMode reads the mode for the CALLER\'S OWN workspace', async () => {
      const authService = {
        getMcpWriteMode: jest.fn().mockResolvedValue({ mcpWriteMode: 'APPROVAL' }),
      } as any;
      const ctrl = new MarketingWorkspacesController(authService);

      const res = await ctrl.getMcpWriteMode({ workspaceId: 'ws-1' } as any);

      expect(authService.getMcpWriteMode).toHaveBeenCalledWith('ws-1');
      expect(res).toEqual({ mcpWriteMode: 'APPROVAL' });
    });

    it('setMcpWriteMode writes AUTONOMOUS to the CALLER\'S OWN workspace (never the body/path)', async () => {
      const authService = {
        setMcpWriteMode: jest.fn().mockResolvedValue({ mcpWriteMode: 'AUTONOMOUS' }),
      } as any;
      const ctrl = new MarketingWorkspacesController(authService);

      const res = await ctrl.setMcpWriteMode(
        { workspaceId: 'ws-1' } as any,
        { mode: 'AUTONOMOUS' } as any,
      );

      expect(authService.setMcpWriteMode).toHaveBeenCalledWith('ws-1', 'AUTONOMOUS');
      expect(res).toEqual({ mcpWriteMode: 'AUTONOMOUS' });
    });

    it('setMcpWriteMode writes APPROVAL (re-arming the gate)', async () => {
      const authService = {
        setMcpWriteMode: jest.fn().mockResolvedValue({ mcpWriteMode: 'APPROVAL' }),
      } as any;
      const ctrl = new MarketingWorkspacesController(authService);

      const res = await ctrl.setMcpWriteMode(
        { workspaceId: 'ws-1' } as any,
        { mode: 'APPROVAL' } as any,
      );

      expect(authService.setMcpWriteMode).toHaveBeenCalledWith('ws-1', 'APPROVAL');
      expect(res).toEqual({ mcpWriteMode: 'APPROVAL' });
    });
  });

  describe('OWNER-only gate', () => {
    it("is gated by exactly ['OWNER'] on both routes — never co-listed with a lower role", () => {
      // Co-listing (e.g. @MarketingRoles('OWNER', 'MANAGER')) does NOT mean
      // "either role" in this codebase's hierarchical guard — it takes the
      // HIGHEST rank among the list as the floor, so it would still end up
      // OWNER-only while reading as if MANAGER were admitted. Listing just
      // 'OWNER' says what it means and can't be misread later.
      expect(requiredRoles('getMcpWriteMode')).toEqual(['OWNER']);
      expect(requiredRoles('setMcpWriteMode')).toEqual(['OWNER']);
    });

    it('the real MarketingRolesGuard refuses MANAGER and REP against this metadata', () => {
      const guard = new MarketingRolesGuard(new Reflector());
      const proto = MarketingWorkspacesController.prototype as Record<string, (...args: unknown[]) => unknown>;

      for (const method of ['getMcpWriteMode', 'setMcpWriteMode']) {
        for (const role of ['MANAGER', 'REP', 'SYSTEM']) {
          expect(() => guard.canActivate(ctxFor(proto[method], role))).toThrow(ForbiddenException);
        }
        expect(guard.canActivate(ctxFor(proto[method], 'OWNER'))).toBe(true);
      }
    });
  });

  describe('audited', () => {
    it('setMcpWriteMode is @Audit-logged with an unambiguous action', () => {
      expect(auditAction('setMcpWriteMode')).toBe('workspace.mcp_write_mode.update');
    });

    // Fix round 1 (Minor): a read of this security posture leaves no trail
    // without this — nobody could later tell who checked whether the
    // approval gate was on.
    it('getMcpWriteMode is ALSO @Audit-logged — reading this posture leaves a trail too', () => {
      expect(auditAction('getMcpWriteMode')).toBe('workspace.mcp_write_mode.read');
    });
  });

  /**
   * Fix round 1 (Important): the tests above prove `@MarketingRoles('OWNER')`
   * rejects MANAGER WHEN THE GUARD RUNS, and that the metadata is pinned to
   * `['OWNER']`. Neither proves the guard is actually WIRED — delete
   * `MarketingRolesGuard`/`PermissionsGuard` from the controller's
   * `@UseGuards(...)` and both of those tests stay green, because they never
   * go through Nest's HTTP pipeline.
   *
   * This block does: a real `TestingModule` compiles the ACTUAL
   * `MarketingWorkspacesController` class with its own `@UseGuards(...)`
   * metadata untouched (only `MarketingGuard` — the JWT/session layer, not
   * the concern under test — is swapped for a fake that stamps a role onto
   * the request, exactly like `MarketingGuard` does after verifying a
   * token). `MarketingRolesGuard` and `PermissionsGuard` are the REAL
   * classes, so an HTTP request actually runs through them.
   *
   * Verified manually per review: temporarily removed `MarketingRolesGuard`
   * from the controller's `@UseGuards(...)` — the MANAGER test below failed
   * (200 instead of 403) — then restored it and reran to confirm green.
   *
   * No existing integration/HTTP harness in this repo is scoped to a single
   * controller (the only precedent, `test/utils/test-app.ts` +
   * `test/e2e/*.e2e-spec.ts`, boots the ENTIRE `AppModule` under the separate
   * `test:e2e` Jest config and is not reachable via `npm test -- <path>`).
   * This block instead builds the smallest real pipeline that still proves
   * the point — the controller's own guard metadata, unmodified, actually
   * enforced by Nest — and runs as a normal spec alongside the rest of this
   * file.
   */
  describe('integration — the @UseGuards stack actually runs (real Nest pipeline)', () => {
    /** Stands in for MarketingGuard: stamps a principal onto the request,
     *  same shape MarketingGuard leaves after verifying a JWT, without
     *  needing a real token/JwtService/PrismaService in this isolated module. */
    class FakeMarketingGuard implements CanActivate {
      constructor(private readonly user: { id: string; workspaceId: string; role: string; email: string; customRoleId: string | null }) {}
      canActivate(context: ExecutionContext): boolean {
        context.switchToHttp().getRequest().marketingUser = this.user;
        return true;
      }
    }

    async function buildApp(
      role: string,
      authService: Record<string, jest.Mock>,
      opts: {
        customRoleId?: string | null;
        prisma?: Record<string, unknown>;
        mediaModels?: Record<string, unknown>;
      } = {},
    ): Promise<INestApplication> {
      const moduleRef = await Test.createTestingModule({
        controllers: [MarketingWorkspacesController],
        providers: [
          { provide: MarketingAuthService, useValue: authService },
          // The media-model routes' service. Inert here: this block is about
          // the GUARD STACK, and a handler that is never reached because a
          // guard threw needs nothing behind it — but Nest still has to be able
          // to construct the controller.
          { provide: MediaModelDefaultsService, useValue: opts.mediaModels ?? {} },
          // The REAL guards — this is the whole point of this test.
          MarketingRolesGuard,
          PermissionsGuard,
          RolesService,
          // RolesService's only dependency. Inert for the plain-role cases
          // (PermissionsGuard never reaches it there — MarketingRolesGuard
          // throws first for MANAGER, and a legacy OWNER holds every
          // permission unconditionally); the custom-role case below drives
          // it for real via `customRole.findFirst`.
          { provide: PrismaService, useValue: opts.prisma ?? {} },
        ],
      })
        .overrideGuard(MarketingGuard)
        .useValue(
          new FakeMarketingGuard({
            id: 'mu-1',
            workspaceId: 'ws-1',
            role,
            email: 'actor@test.local',
            customRoleId: opts.customRoleId ?? null,
          }),
        )
        .compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      return app;
    }

    it('PATCH /marketing/workspaces/mcp-write-mode as MANAGER is refused with 403 by the REAL guard stack', async () => {
      const authService = { setMcpWriteMode: jest.fn().mockResolvedValue({ mcpWriteMode: 'AUTONOMOUS' }) };
      const app = await buildApp('MANAGER', authService);
      try {
        const res = await request(app.getHttpServer())
          .patch('/marketing/workspaces/mcp-write-mode')
          .send({ mode: 'AUTONOMOUS' });

        expect(res.status).toBe(403);
        expect(authService.setMcpWriteMode).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    /**
     * The media-model routes sit a rung LOWER than the two above, on purpose:
     * MANAGER, not OWNER. This is the assertion that says the difference is
     * real rather than a copy-paste that happened to land — the same request
     * that is 403'd on mcp-write-mode is admitted here.
     */
    it('PATCH /marketing/workspaces/media-models as MANAGER is ADMITTED (a lower floor than mcp-write-mode, deliberately)', async () => {
      const mediaModels = { set: jest.fn().mockResolvedValue({ defaultVideoModel: 'fal-ai/veo3.1/fast' }) };
      const app = await buildApp('MANAGER', {}, { mediaModels });
      try {
        const res = await request(app.getHttpServer())
          .patch('/marketing/workspaces/media-models')
          .send({ defaultVideoModel: 'fal-ai/veo3.1/fast' });

        expect(res.status).toBe(200);
        // Always the CALLER'S workspace, never a body or path param.
        expect(mediaModels.set).toHaveBeenCalledWith('ws-1', { defaultVideoModel: 'fal-ai/veo3.1/fast' });
      } finally {
        await app.close();
      }
    });

    it('PATCH /marketing/workspaces/media-models as REP is refused with 403 by the REAL guard stack', async () => {
      const mediaModels = { set: jest.fn() };
      const app = await buildApp('REP', {}, { mediaModels });
      try {
        const res = await request(app.getHttpServer())
          .patch('/marketing/workspaces/media-models')
          .send({ defaultVideoModel: 'fal-ai/veo3.1/fast' });

        expect(res.status).toBe(403);
        expect(mediaModels.set).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    /**
     * A MANAGER-rank user whose custom role has had `settings.manage` stripped
     * may still READ the card (no @RequirePermission on the GET) but may not
     * SAVE. Same seam as the OWNER case above: rank alone admits them, and
     * PermissionsGuard is the only thing left.
     */
    it('media-models: a custom role without settings.manage may read but not write', async () => {
      const mediaModels = {
        get: jest.fn().mockResolvedValue({ defaultVideoModel: null, models: [] }),
        set: jest.fn(),
      };
      const prisma = {
        customRole: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'cr-reader',
            workspaceId: 'ws-1',
            permissions: ['leads.read'],
          }),
        },
      };
      const app = await buildApp('MANAGER', {}, { customRoleId: 'cr-reader', prisma, mediaModels });
      try {
        const read = await request(app.getHttpServer()).get('/marketing/workspaces/media-models');
        expect(read.status).toBe(200);
        expect(mediaModels.get).toHaveBeenCalledWith('ws-1');

        const write = await request(app.getHttpServer())
          .patch('/marketing/workspaces/media-models')
          .send({ defaultVideoModel: 'fal-ai/veo3.1/fast' });
        expect(write.status).toBe(403);
        expect(mediaModels.set).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it('PATCH ... as OWNER is admitted (sanity check: the harness is not just always-403)', async () => {
      const authService = { setMcpWriteMode: jest.fn().mockResolvedValue({ mcpWriteMode: 'AUTONOMOUS' }) };
      const app = await buildApp('OWNER', authService);
      try {
        const res = await request(app.getHttpServer())
          .patch('/marketing/workspaces/mcp-write-mode')
          .send({ mode: 'AUTONOMOUS' });

        expect(res.status).toBe(200);
        expect(authService.setMcpWriteMode).toHaveBeenCalledWith('ws-1', 'AUTONOMOUS');
      } finally {
        await app.close();
      }
    });

    /**
     * Fix round 2: `MarketingRolesGuard` alone is not the whole story.
     * `RolesService.resolvePermissions` (roles.service.ts:188-200) checks
     * `user.customRoleId` FIRST — it does NOT fall through legacy-role
     * permissions when a custom role is present, even for OWNER rank:
     *   if (user.customRoleId) { ...read the custom role's permissions... }
     *   return LEGACY_ROLE_PERMISSIONS[user.role] ?? [];
     * So a custom role genuinely CAN strip `settings.manage` from an
     * OWNER-rank user — `MarketingRolesGuard` passes them (rank 3), and
     * `PermissionsGuard` is the ONLY thing left to stop them. This test
     * drives that exact seam: a real `PermissionsGuard` + real
     * `RolesService`, with `PrismaService.customRole.findFirst` stubbed to
     * return a custom role whose `permissions` excludes `settings.manage`.
     */
    it('PATCH ... as OWNER-rank with a custom role that excludes settings.manage is refused with 403 (PermissionsGuard, not just rank)', async () => {
      const authService = { setMcpWriteMode: jest.fn().mockResolvedValue({ mcpWriteMode: 'AUTONOMOUS' }) };
      const prisma = {
        customRole: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'cr-restricted',
            workspaceId: 'ws-1',
            permissions: ['leads.read'], // deliberately NOT settings.manage
          }),
        },
      };
      const app = await buildApp('OWNER', authService, { customRoleId: 'cr-restricted', prisma });
      try {
        const res = await request(app.getHttpServer())
          .patch('/marketing/workspaces/mcp-write-mode')
          .send({ mode: 'AUTONOMOUS' });

        expect(res.status).toBe(403);
        expect(prisma.customRole.findFirst).toHaveBeenCalledWith({
          where: { id: 'cr-restricted', workspaceId: 'ws-1' },
        });
        expect(authService.setMcpWriteMode).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });
  });
});

/**
 * Which side drains the nightly research queue. Same posture as
 * `mcp-write-mode` above and for the same reason: this decides whether an
 * unattended job runs on the platform's Anthropic key or waits for the
 * owner's own Claude, so it is OWNER-only, audited, and always the CALLER'S
 * OWN workspace.
 */
describe('MarketingWorkspacesController — research-execution', () => {
  describe('delegation', () => {
    it("getResearchExecution reads the mode for the CALLER'S OWN workspace", async () => {
      const authService = {
        getResearchExecution: jest.fn().mockResolvedValue({ researchExecution: 'SERVER' }),
      } as any;
      const ctrl = new MarketingWorkspacesController(authService);

      const res = await ctrl.getResearchExecution({ workspaceId: 'ws-1' } as any);

      expect(authService.getResearchExecution).toHaveBeenCalledWith('ws-1');
      expect(res).toEqual({ researchExecution: 'SERVER' });
    });

    it('setResearchExecution writes MCP to the CALLER\'S OWN workspace (never the body/path)', async () => {
      const authService = {
        setResearchExecution: jest.fn().mockResolvedValue({ researchExecution: 'MCP' }),
      } as any;
      const ctrl = new MarketingWorkspacesController(authService);

      const res = await ctrl.setResearchExecution(
        { workspaceId: 'ws-1' } as any,
        { mode: 'MCP' } as any,
      );

      expect(authService.setResearchExecution).toHaveBeenCalledWith('ws-1', 'MCP');
      expect(res).toEqual({ researchExecution: 'MCP' });
    });

    it('setResearchExecution writes SERVER (handing the queue back to the platform)', async () => {
      const authService = {
        setResearchExecution: jest.fn().mockResolvedValue({ researchExecution: 'SERVER' }),
      } as any;
      const ctrl = new MarketingWorkspacesController(authService);

      const res = await ctrl.setResearchExecution(
        { workspaceId: 'ws-1' } as any,
        { mode: 'SERVER' } as any,
      );

      expect(authService.setResearchExecution).toHaveBeenCalledWith('ws-1', 'SERVER');
      expect(res).toEqual({ researchExecution: 'SERVER' });
    });
  });

  describe('OWNER-only gate', () => {
    it("is gated by exactly ['OWNER'] on both routes — never co-listed with a lower role", () => {
      for (const method of ['getResearchExecution', 'setResearchExecution']) {
        expect(requiredRoles(method)).toEqual(['OWNER']);
      }
    });

    it('audits both the read and the write with unambiguous actions', () => {
      expect(auditAction('getResearchExecution')).toBe('workspace.research_execution.read');
      expect(auditAction('setResearchExecution')).toBe('workspace.research_execution.update');
    });
  });
});

/**
 * The workspace's IANA zone — what "today" means for this business.
 *
 * `Workspace.timezone` shipped with the first migration, defaulted to 'UTC',
 * and had exactly ONE writer in the entire codebase: agency.service's
 * createLocation, a path no self-serve customer ever walks. Meanwhile five
 * consumers read it as though it were an answer — the dashboard aggregates, the
 * tasks list, sales targets, the daily-digest cron, and the Growth Studio rail
 * on the client — so every Turkish workspace has been running its day from
 * 03:00 to 03:00. Signup now captures the browser's zone, which repairs new
 * workspaces; these two routes are the only way an EXISTING one is correctable
 * at all.
 */
describe('MarketingWorkspacesController — timezone', () => {
  describe('delegation', () => {
    it("setWorkspaceTimezone writes to the CALLER'S OWN workspace (never the body/path)", async () => {
      const authService = {
        setWorkspaceTimezone: jest.fn().mockResolvedValue({ timezone: 'Europe/Istanbul' }),
      } as any;
      const ctrl = new MarketingWorkspacesController(authService);

      const res = await ctrl.setWorkspaceTimezone(
        { workspaceId: 'ws-1' } as any,
        { timezone: 'Europe/Istanbul' } as any,
      );

      expect(authService.setWorkspaceTimezone).toHaveBeenCalledWith('ws-1', 'Europe/Istanbul');
      expect(res).toEqual({ timezone: 'Europe/Istanbul' });
    });

    it("getWorkspaceTimezone reads the CALLER'S OWN workspace", async () => {
      const authService = {
        getWorkspaceTimezone: jest.fn().mockResolvedValue({ timezone: 'UTC' }),
      } as any;
      const ctrl = new MarketingWorkspacesController(authService);

      const res = await ctrl.getWorkspaceTimezone({ workspaceId: 'ws-1' } as any);

      expect(authService.getWorkspaceTimezone).toHaveBeenCalledWith('ws-1');
      expect(res).toEqual({ timezone: 'UTC' });
    });
  });

  describe('guard stack', () => {
    it('sits on MANAGER + settings.manage — operational config, not security posture', () => {
      // Deliberately NOT the OWNER floor the two routes above carry. Those
      // decide whether an unattended agent may act without a human and whose
      // Anthropic key pays; this decides how dates are bucketed on reports,
      // which is ordinary operational configuration of the same weight as the
      // rest of what a MANAGER already owns.
      expect(requiredRoles('setWorkspaceTimezone')).toEqual(['MANAGER']);
      expect(requiredRoles('getWorkspaceTimezone')).toEqual(['MANAGER']);
      expect(
        Reflect.getMetadata(
          REQUIRE_PERMISSION_KEY,
          (MarketingWorkspacesController.prototype as Record<string, unknown>)
            .setWorkspaceTimezone as object,
        ),
      ).toBe('settings.manage');
    });

    it('the real MarketingRolesGuard admits MANAGER and OWNER, refuses REP and SYSTEM', () => {
      const guard = new MarketingRolesGuard(new Reflector());
      const proto = MarketingWorkspacesController.prototype as Record<
        string,
        (...args: unknown[]) => unknown
      >;

      for (const method of ['getWorkspaceTimezone', 'setWorkspaceTimezone']) {
        for (const role of ['REP', 'SYSTEM']) {
          expect(() => guard.canActivate(ctxFor(proto[method], role))).toThrow(ForbiddenException);
        }
        // The guard is hierarchical: listing MANAGER alone admits OWNER too.
        expect(guard.canActivate(ctxFor(proto[method], 'MANAGER'))).toBe(true);
        expect(guard.canActivate(ctxFor(proto[method], 'OWNER'))).toBe(true);
      }
    });

    it('audits the write AND the read', () => {
      // A changed zone silently moves every historical day boundary the panel
      // draws. "Why did last Tuesday's numbers move?" is answerable only if the
      // change left a row.
      expect(auditAction('setWorkspaceTimezone')).toBe('workspace.timezone.update');
      expect(auditAction('getWorkspaceTimezone')).toBe('workspace.timezone.read');
    });
  });
});
