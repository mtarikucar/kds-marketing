import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  TestApp,
  signMarketingToken,
  mockMarketingUser,
} from '../utils/test-app';

/**
 * Epic F — custom roles end to end (DB seam mocked): the permission catalog,
 * create a role, assign it to a user, and REP forbidden.
 */
describe('Custom roles (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => jest.clearAllMocks());

  const ownerAuth = () => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(mockMarketingUser({ role: 'OWNER' }) as never);
    return `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role: 'OWNER' })}`;
  };

  it('returns the permission catalog', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/marketing/roles/catalog')
      .set('Authorization', ownerAuth());
    expect(res.status).toBe(200);
    expect(res.body).toContain('leads.write');
  });

  it('creates a role and assigns it to a user', async () => {
    const auth = ownerAuth();
    ctx.prisma.customRole.findUnique.mockResolvedValue(null as never);
    (ctx.prisma.customRole.create as jest.Mock).mockImplementation(({ data }: any) => Promise.resolve({ id: 'r1', ...data }));
    const create = await request(app.getHttpServer())
      .post('/api/marketing/roles')
      .set('Authorization', auth)
      .send({ name: 'Sales Lead', permissions: ['leads.read', 'leads.write', 'reports.read'] });
    expect(create.status).toBe(201);
    expect(create.body.id).toBe('r1');

    // Multi-workspace membership (Task 13 review fix, 0b7c35ca): assignToUser()
    // reads the TARGET's role/customRoleId off their live WorkspaceMembership
    // row, not the (frozen-at-creation) MarketingUser row, so it can't evaluate
    // a promoted/demoted user at a stale role. workspaceMembership.findFirst
    // defaults to undefined (not-found) in the harness, so without this the
    // service 404s with "User not found" before ever reaching customRole/update.
    ctx.prisma.workspaceMembership.findFirst.mockResolvedValue({ role: 'REP', customRoleId: null } as never);
    ctx.prisma.customRole.findFirst.mockResolvedValue({ id: 'r1' } as never);
    (ctx.prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
    const assign = await request(app.getHttpServer())
      .post('/api/marketing/roles/assign')
      .set('Authorization', auth)
      .send({ userId: 'u2', roleId: 'r1' });
    expect(assign.status).toBe(201);
    expect(assign.body).toEqual({ userId: 'u2', customRoleId: 'r1' });
  });

  it('rejects an unknown permission', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/marketing/roles')
      .set('Authorization', ownerAuth())
      .send({ name: 'Bad', permissions: ['leads.read', 'nope.bad'] });
    expect(res.status).toBe(400);
  });

  it('forbids a REP from managing roles', async () => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(mockMarketingUser({ role: 'REP' }) as never);
    const res = await request(app.getHttpServer())
      .get('/api/marketing/roles')
      .set('Authorization', `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role: 'REP' })}`);
    expect(res.status).toBe(403);
  });
});
