import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  TestApp,
  signPlatformToken,
  mockPlatformOperator,
} from '../utils/test-app';

/**
 * The audit interceptor (backlog #3) end to end: a real `@Audit`-tagged route,
 * driven through the production pipeline, must emit exactly one append-only
 * audit row carrying the resolved actor, the action/resource, the correlation
 * id — and the right SUCCESS/FAILURE outcome. The DB seam is mocked, so we
 * assert on the `auditLog.create` payload (the service-layer contract); the
 * model/migration itself is exercised against real Postgres in the unit spec.
 */
describe('Audit trail (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => {
    jest.clearAllMocks();
    ctx.prisma.platformOperator.findUnique.mockResolvedValue(
      mockPlatformOperator() as never,
    );
  });

  const auth = () => `Bearer ${signPlatformToken({ sub: 'op-1' })}`;

  it('records a SUCCESS row for a workspace status change, with actor + resource + correlation id', async () => {
    ctx.prisma.workspace.findUnique.mockResolvedValue({ id: 'ws-9' } as never);
    ctx.prisma.workspace.update.mockResolvedValue({
      id: 'ws-9',
      slug: 'acme',
      name: 'Acme',
      status: 'SUSPENDED',
    } as never);

    const res = await request(app.getHttpServer())
      .patch('/api/platform/workspaces/ws-9/status')
      .set('Authorization', auth())
      .set('X-Request-ID', 'audit-trace-1')
      .send({ status: 'SUSPENDED' });

    expect(res.status).toBe(200);
    expect(ctx.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const { data } = (ctx.prisma.auditLog.create as jest.Mock).mock.calls[0][0];
    expect(data).toMatchObject({
      action: 'workspace.status.update',
      resourceType: 'workspace',
      resourceId: 'ws-9',
      actorType: 'PLATFORM_OPERATOR',
      actorId: 'op-1',
      actorEmail: 'operator@example.com',
      requestId: 'audit-trace-1',
      outcome: 'SUCCESS',
    });
    // Only the whitelisted body field is captured — never the whole payload.
    expect(data.metadata).toEqual({ status: 'SUSPENDED' });
  });

  it('records a FAILURE row when the handler throws (the action did not happen)', async () => {
    // No such workspace → the service throws NotFound → 404.
    ctx.prisma.workspace.findUnique.mockResolvedValue(null as never);

    const res = await request(app.getHttpServer())
      .patch('/api/platform/workspaces/ghost/status')
      .set('Authorization', auth())
      .send({ status: 'CLOSED' });

    expect(res.status).toBe(404);
    expect(ctx.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const { data } = (ctx.prisma.auditLog.create as jest.Mock).mock.calls[0][0];
    expect(data).toMatchObject({
      action: 'workspace.status.update',
      resourceId: 'ghost',
      outcome: 'FAILURE',
    });
  });

  it('does NOT audit an un-tagged route on the same controller', async () => {
    ctx.prisma.workspace.findMany.mockResolvedValue([] as never);
    await request(app.getHttpServer())
      .get('/api/platform/workspaces')
      .set('Authorization', auth());
    expect(ctx.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('never lets an audit-write failure break the user action', async () => {
    ctx.prisma.workspace.findUnique.mockResolvedValue({ id: 'ws-9' } as never);
    ctx.prisma.workspace.update.mockResolvedValue({
      id: 'ws-9',
      slug: 'acme',
      name: 'Acme',
      status: 'ACTIVE',
    } as never);
    (ctx.prisma.auditLog.create as jest.Mock).mockRejectedValueOnce(
      new Error('audit table unreachable'),
    );

    const res = await request(app.getHttpServer())
      .patch('/api/platform/workspaces/ws-9/status')
      .set('Authorization', auth())
      .send({ status: 'ACTIVE' });

    // The business action still succeeds even though the audit insert failed.
    expect(res.status).toBe(200);
  });
});
