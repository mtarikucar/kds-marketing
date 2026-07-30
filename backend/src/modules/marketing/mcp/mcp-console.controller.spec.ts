import 'reflect-metadata';
import { CanActivate, ExecutionContext, INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { McpConsoleController } from './mcp-console.controller';
import { McpConsoleService } from './mcp-console.service';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RolesService } from '../roles/roles.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { MARKETING_ROLES_KEY } from '../decorators/marketing-roles.decorator';
import { REQUIRE_PERMISSION_KEY } from '../roles/require-permission.decorator';
import { AUDIT_METADATA } from '../../audit/audit.decorator';
import { IS_MARKETING_ROUTE_KEY } from '../decorators/marketing-public.decorator';

/**
 * Faz 4 — the connector console controller.
 *
 * Two things are proven here, in the style MarketingWorkspacesController's spec
 * established: (a) the decorator metadata is pinned, and (b) the guard stack is
 * actually WIRED — a real Nest pipeline runs the REAL MarketingRolesGuard /
 * PermissionsGuard against the controller's own `@UseGuards`, so deleting a
 * guard from the class breaks a test instead of silently opening the surface.
 */
function methodMeta(key: string, method: string): any {
  return Reflect.getMetadata(
    key,
    (McpConsoleController.prototype as Record<string, unknown>)[method] as object,
  );
}

function svcMock(over: Record<string, jest.Mock> = {}) {
  return {
    listConnections: jest.fn().mockResolvedValue({ oauth: [], apiKeys: [] }),
    revokeOAuthClient: jest.fn().mockResolvedValue({ clientId: 'c', revoked: 0 }),
    listSessions: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 }),
    getSession: jest.fn().mockResolvedValue({ id: 'run-1', toolCalls: [], approvals: [] }),
    ...over,
  } as unknown as McpConsoleService & Record<string, jest.Mock>;
}

class FakeMarketingGuard implements CanActivate {
  constructor(
    private readonly user: {
      id: string;
      workspaceId: string;
      role: string;
      email: string;
      customRoleId: string | null;
    },
  ) {}
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().marketingUser = this.user;
    return true;
  }
}

async function buildApp(
  role: string,
  svc: McpConsoleService,
  opts: { customRoleId?: string | null; prisma?: Record<string, unknown> } = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [McpConsoleController],
    providers: [
      { provide: McpConsoleService, useValue: svc },
      // The REAL guards — the point of the integration block.
      MarketingRolesGuard,
      PermissionsGuard,
      RolesService,
      { provide: PrismaService, useValue: opts.prisma ?? {} },
    ],
  })
    .overrideGuard(MarketingGuard)
    .useValue(
      new FakeMarketingGuard({
        id: 'mu-1',
        workspaceId: 'ws-a',
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

describe('McpConsoleController — wiring', () => {
  it('is a marketing-realm route under marketing/mcp-console', () => {
    expect(Reflect.getMetadata(IS_MARKETING_ROUTE_KEY, McpConsoleController)).toBe(true);
    expect(Reflect.getMetadata('path', McpConsoleController)).toBe('marketing/mcp-console');
  });

  it('gates the whole console at MANAGER — a REP has no business here', () => {
    expect(Reflect.getMetadata(MARKETING_ROLES_KEY, McpConsoleController)).toEqual(['MANAGER']);
  });

  it('gates the revoke action on settings.manage and audits it', () => {
    expect(methodMeta(REQUIRE_PERMISSION_KEY, 'revokeOAuthConnection')).toBe('settings.manage');
    expect(methodMeta(AUDIT_METADATA, 'revokeOAuthConnection')).toEqual(
      expect.objectContaining({ action: 'mcp.connection.revoke', resourceType: 'mcp-oauth-client' }),
    );
  });
});

describe('McpConsoleController — connections', () => {
  it("reads connections for the CALLER'S OWN workspace (never a body/param)", async () => {
    const svc = svcMock();
    const ctrl = new McpConsoleController(svc);

    await ctrl.connections({ workspaceId: 'ws-a' } as never);

    expect(svc.listConnections).toHaveBeenCalledWith('ws-a');
  });

  it("revokes within the CALLER'S OWN workspace", async () => {
    const svc = svcMock();
    const ctrl = new McpConsoleController(svc);

    await ctrl.revokeOAuthConnection('https://claude.ai/mcp', { workspaceId: 'ws-a' } as never);

    expect(svc.revokeOAuthClient).toHaveBeenCalledWith('ws-a', 'https://claude.ai/mcp');
  });

  it('GET connections runs through the REAL guard stack for a MANAGER', async () => {
    const svc = svcMock();
    const app = await buildApp('MANAGER', svc);
    try {
      const res = await request(app.getHttpServer()).get('/marketing/mcp-console/connections');
      expect(res.status).toBe(200);
      expect(svc.listConnections).toHaveBeenCalledWith('ws-a');
    } finally {
      await app.close();
    }
  });

  it('GET connections as a REP is refused with 403 by the REAL guard stack', async () => {
    const svc = svcMock();
    const app = await buildApp('REP', svc);
    try {
      const res = await request(app.getHttpServer()).get('/marketing/mcp-console/connections');
      expect(res.status).toBe(403);
      expect(svc.listConnections).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('DELETE of a URL-encoded client_id reaches the service decoded', async () => {
    const svc = svcMock({ revokeOAuthClient: jest.fn().mockResolvedValue({ clientId: 'https://claude.ai/mcp', revoked: 2 }) });
    const app = await buildApp('OWNER', svc);
    try {
      const res = await request(app.getHttpServer()).delete(
        `/marketing/mcp-console/connections/oauth/${encodeURIComponent('https://claude.ai/mcp')}`,
      );
      expect(res.status).toBe(200);
      expect(svc.revokeOAuthClient).toHaveBeenCalledWith('ws-a', 'https://claude.ai/mcp');
      expect(res.body).toEqual({ clientId: 'https://claude.ai/mcp', revoked: 2 });
    } finally {
      await app.close();
    }
  });

  it('DELETE by an OWNER-rank user whose custom role lacks settings.manage is refused with 403', async () => {
    const svc = svcMock();
    const prisma = {
      customRole: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'cr-restricted',
          workspaceId: 'ws-a',
          permissions: ['leads.read'], // deliberately NOT settings.manage
        }),
      },
    };
    const app = await buildApp('OWNER', svc, { customRoleId: 'cr-restricted', prisma });
    try {
      const res = await request(app.getHttpServer()).delete(
        `/marketing/mcp-console/connections/oauth/${encodeURIComponent('https://claude.ai/mcp')}`,
      );
      expect(res.status).toBe(403);
      expect(svc.revokeOAuthClient).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('McpConsoleController — sessions', () => {
  it('forwards page/pageSize as given — the CAP lives in the service, not the edge', async () => {
    const svc = svcMock();
    const ctrl = new McpConsoleController(svc);

    await ctrl.sessions({ workspaceId: 'ws-a' } as never, '3', '100000');

    expect(svc.listSessions).toHaveBeenCalledWith('ws-a', '3', '100000');
  });

  it('reads one session within the caller\'s own workspace', async () => {
    const svc = svcMock();
    const ctrl = new McpConsoleController(svc);

    await ctrl.session('run-1', { workspaceId: 'ws-a' } as never);

    expect(svc.getSession).toHaveBeenCalledWith('ws-a', 'run-1');
  });

  it("GET sessions/:id for another workspace's run surfaces the service 404 through HTTP", async () => {
    const svc = svcMock({
      getSession: jest.fn().mockRejectedValue(new NotFoundException('MCP session not found')),
    });
    const app = await buildApp('MANAGER', svc);
    try {
      const res = await request(app.getHttpServer()).get('/marketing/mcp-console/sessions/run-in-ws-b');
      expect(res.status).toBe(404);
      expect(svc.getSession).toHaveBeenCalledWith('ws-a', 'run-in-ws-b');
    } finally {
      await app.close();
    }
  });

  it('GET sessions is refused for a REP by the REAL guard stack', async () => {
    const svc = svcMock();
    const app = await buildApp('REP', svc);
    try {
      const res = await request(app.getHttpServer()).get('/marketing/mcp-console/sessions');
      expect(res.status).toBe(403);
      expect(svc.listSessions).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('GET sessions/:id does not shadow the literal routes declared before it', async () => {
    const svc = svcMock();
    const app = await buildApp('MANAGER', svc);
    try {
      const res = await request(app.getHttpServer()).get('/marketing/mcp-console/connections');
      expect(res.status).toBe(200);
      expect(svc.getSession).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('leaves the session reads unaudited-by-mutation but keeps them behind the class role gate', () => {
    // Reads are not @Audit-logged (they would flood the trail); the class-level
    // @MarketingRoles('MANAGER') is what confines them.
    expect(methodMeta(AUDIT_METADATA, 'sessions')).toBeUndefined();
    expect(methodMeta(MARKETING_ROLES_KEY, 'sessions')).toBeUndefined();
  });

  it('keeps the reads free of @RequirePermission — revoke is the only gated action', () => {
    expect(methodMeta(REQUIRE_PERMISSION_KEY, 'sessions')).toBeUndefined();
    expect(methodMeta(REQUIRE_PERMISSION_KEY, 'session')).toBeUndefined();
    expect(methodMeta(REQUIRE_PERMISSION_KEY, 'connections')).toBeUndefined();
  });
});
