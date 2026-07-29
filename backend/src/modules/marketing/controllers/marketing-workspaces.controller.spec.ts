import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MarketingWorkspacesController } from './marketing-workspaces.controller';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
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
  });
});
