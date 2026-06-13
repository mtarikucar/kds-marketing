import { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  signMarketingToken,
  TEST_ENV,
  TestApp,
} from '../utils/test-app';

/**
 * Cross-realm authorization isolation. The service runs THREE credential realms
 * (marketing-user JWT, platform-operator JWT, service token). This proves a
 * token from one realm is dead on arrival in another — the property that keeps
 * a workspace rep from reaching the operator console and vice versa.
 */
describe('Authorization & realm isolation (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  const signPlatformToken = () =>
    new JwtService({ secret: TEST_ENV.PLATFORM_JWT_SECRET }).sign(
      { sub: 'op-1', type: 'platform', role: 'OPERATOR' },
      { algorithm: 'HS256', expiresIn: '1h' },
    );

  describe('Marketing routes reject non-marketing credentials', () => {
    it('401s a protected marketing route with no token', async () => {
      const res = await request(app.getHttpServer()).get('/api/marketing/leads');
      expect(res.status).toBe(401);
    });

    it('401s a marketing route presented a PLATFORM-realm token', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/marketing/leads')
        .set('Authorization', `Bearer ${signPlatformToken()}`);
      expect(res.status).toBe(401);
    });

    it('401s a token signed with a bogus secret (signature forgery)', async () => {
      const forged = new JwtService({ secret: 'attacker-secret-not-the-real-one' }).sign(
        { sub: 'mu-1', wsp: 'ws-1', type: 'marketing', role: 'OWNER' },
        { algorithm: 'HS256' },
      );
      const res = await request(app.getHttpServer())
        .get('/api/marketing/leads')
        .set('Authorization', `Bearer ${forged}`);
      expect(res.status).toBe(401);
    });
  });

  describe('Platform routes reject non-platform credentials', () => {
    it('401s a platform route with no token', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/platform/workspaces',
      );
      expect(res.status).toBe(401);
    });

    it('401s a platform route presented a MARKETING-realm token', async () => {
      const token = signMarketingToken({ sub: 'mu-1', wsp: 'ws-1' });
      const res = await request(app.getHttpServer())
        .get('/api/platform/workspaces')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });
  });
});
