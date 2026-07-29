import 'reflect-metadata';
import { CanActivate, ExecutionContext, ForbiddenException, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MarketingWorkspacesController } from './marketing-workspaces.controller';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RolesService } from '../roles/roles.service';
import { MarketingAuthService } from '../services/marketing-auth.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { MARKETING_ROLES_KEY } from '../decorators/marketing-roles.decorator';
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
      opts: { customRoleId?: string | null; prisma?: Record<string, unknown> } = {},
    ): Promise<INestApplication> {
      const moduleRef = await Test.createTestingModule({
        controllers: [MarketingWorkspacesController],
        providers: [
          { provide: MarketingAuthService, useValue: authService },
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
