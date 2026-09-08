import { NestExpressApplication } from '@nestjs/platform-express';
import { createHash } from 'crypto';
import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  TestApp,
  signMarketingToken,
  mockMarketingUser,
} from '../utils/test-app';

/**
 * The paired-phone lane through the real request pipeline.
 *
 * The unit tests prove the service scopes its queries. What they cannot prove
 * is that the ROUTES are wired to the guards we think they are — and this is
 * the one feature in the product whose effect lands outside it, on a handset in
 * somebody's hand. Two authentication realms meet here and they must not blur:
 *
 *  - `marketing/devices/*` is a signed-in MANAGER in the console.
 *  - `marketing/device-bridge/*` is a long-running desktop process holding an
 *    API KEY, because a bridge that sat on a human's session would need either
 *    a session that never expires or a person logging a background process in
 *    all day.
 *
 * The assertions below are about the seams, not the shapes: no key at all, a
 * key belonging to somebody else's workspace, and a command whose URL scheme
 * the queue must refuse before it ever reaches a phone.
 */
describe('Devices + bridge (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  const KEY_A = 'mk_live_workspace_a_key';
  const KEY_B = 'mk_live_workspace_b_key';
  const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => {
    jest.clearAllMocks();
    // Two live keys, two different workspaces. The guard resolves a key by the
    // hash it was presented with, so the fixture is keyed the same way.
    (ctx.prisma.apiKey.findUnique as jest.Mock).mockImplementation(({ where }: any) => {
      const byHash: Record<string, unknown> = {
        [hash(KEY_A)]: { id: 'k-a', workspaceId: 'ws-a', status: 'ACTIVE', scopes: ['read', 'write'] },
        [hash(KEY_B)]: { id: 'k-b', workspaceId: 'ws-b', status: 'ACTIVE', scopes: ['read', 'write'] },
      };
      return Promise.resolve(byHash[where.keyHash] ?? null);
    });
  });

  const managerAuth = () => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ role: 'MANAGER' }) as never,
    );
    return `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role: 'MANAGER' })}`;
  };

  describe('the console half', () => {
    it('will not list phones for an anonymous caller', async () => {
      const res = await request(app.getHttpServer()).get('/api/marketing/devices');
      expect(res.status).toBe(401);
    });

    it('refuses a command whose URL scheme is not one a phone may open', async () => {
      const auth = managerAuth();
      ctx.prisma.device.findFirst.mockResolvedValue({
        id: 'd1',
        workspaceId: 'ws-1',
        label: 'Ofis',
        status: 'ACTIVE',
        mode: 'MANUAL',
      } as never);

      const res = await request(app.getHttpServer())
        .post('/api/marketing/devices/d1/commands')
        .set('Authorization', auth)
        // `intent:` can name an Android component and its extras, which is a
        // different power from "open this link". It is refused at the queue, so
        // no phone ever has to be trusted to refuse it.
        .send({ kind: 'OPEN_URL', args: { url: 'intent://scan/#Intent;scheme=zxing;end' } });

      expect(res.status).toBe(400);
      expect(ctx.prisma.deviceCommand.create).not.toHaveBeenCalled();
    });

    it('queues a https link and never a shell', async () => {
      const auth = managerAuth();
      ctx.prisma.device.findFirst.mockResolvedValue({
        id: 'd1',
        workspaceId: 'ws-1',
        label: 'Ofis',
        status: 'ACTIVE',
        mode: 'MANUAL',
      } as never);
      (ctx.prisma.deviceCommand.create as jest.Mock).mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'c1', status: 'QUEUED', ...data }),
      );

      const ok = await request(app.getHttpServer())
        .post('/api/marketing/devices/d1/commands')
        .set('Authorization', auth)
        .send({ kind: 'OPEN_URL', args: { url: 'https://wa.me/905551112233?text=merhaba' } });
      expect(ok.status).toBe(201);

      const shell = await request(app.getHttpServer())
        .post('/api/marketing/devices/d1/commands')
        .set('Authorization', auth)
        .send({ kind: 'SHELL', args: { command: 'pm list packages' } });
      expect(shell.status).toBe(400);
    });
  });

  describe('the bridge half', () => {
    it('turns away a bridge with no key at all', async () => {
      const res = await request(app.getHttpServer()).post('/api/marketing/device-bridge/d1/claim');
      expect(res.status).toBe(401);
    });

    it('turns away a revoked or unknown key', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/marketing/device-bridge/d1/claim')
        .set('X-Api-Key', 'mk_live_never_issued');
      expect(res.status).toBe(401);
    });

    it('cannot reach another workspace phone with its own valid key', async () => {
      // The whole tenant story in one request: key B is real and active, and
      // `d-a` is a real device — in workspace A. A guard that authenticated the
      // key but forgot to narrow by its workspace would hand a stranger's phone
      // to a stranger's laptop.
      ctx.prisma.device.findFirst.mockResolvedValue(null as never);

      const res = await request(app.getHttpServer())
        .post('/api/marketing/device-bridge/d-a/claim')
        .set('X-Api-Key', KEY_B);

      expect(res.status).toBe(404);
      expect((ctx.prisma.device.findFirst as jest.Mock).mock.calls[0][0].where).toMatchObject({
        id: 'd-a',
        workspaceId: 'ws-b',
      });
    });

    it('claims for the workspace its key belongs to', async () => {
      ctx.prisma.device.findFirst.mockResolvedValue({
        id: 'd-a',
        workspaceId: 'ws-a',
        label: 'Ofis',
        status: 'ACTIVE',
        mode: 'MANUAL',
      } as never);
      (ctx.prisma.deviceCommand.updateMany as jest.Mock).mockResolvedValue({ count: 0 } as never);
      ctx.prisma.deviceCommand.findMany.mockResolvedValue([] as never);

      const res = await request(app.getHttpServer())
        .post('/api/marketing/device-bridge/d-a/claim')
        .set('X-Api-Key', KEY_A);

      expect(res.status).toBe(201);
      // Every queue read the claim makes is narrowed by the KEY's workspace.
      for (const call of (ctx.prisma.deviceCommand.findMany as jest.Mock).mock.calls) {
        expect(call[0].where).toMatchObject({ workspaceId: 'ws-a' });
      }
    });
  });
});
