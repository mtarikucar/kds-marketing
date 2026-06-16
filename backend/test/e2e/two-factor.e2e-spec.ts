import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import {
  createTestApp,
  closeTestApp,
  TestApp,
  signMarketingToken,
  mockMarketingUser,
} from '../utils/test-app';
import { generateTotpSecret, generateTotpCode } from '../../src/modules/marketing/util/totp';

/**
 * Epic F — 2FA end to end (DB seam mocked): enroll + enable for the signed-in
 * user, then a full login that returns a challenge and is completed at
 * /auth/2fa/verify with a TOTP code.
 */
describe('Two-factor auth (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => jest.clearAllMocks());

  const auth = () => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(mockMarketingUser({ id: 'mu-1' }) as never);
    return `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1' })}`;
  };

  it('enrolls and enables 2FA for the signed-in user', async () => {
    const secret = generateTotpSecret();
    // enable() reads the stored secret; arrange the user to already hold it
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ id: 'mu-1', twoFactorSecret: secret }) as never,
    );
    (ctx.prisma.marketingUser.update as jest.Mock).mockResolvedValue({});

    const enable = await request(app.getHttpServer())
      .post('/api/marketing/auth/2fa/enable')
      .set('Authorization', `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1' })}`)
      .send({ code: generateTotpCode(secret) });

    expect(enable.status).toBe(201);
    expect(enable.body.enabled).toBe(true);
    expect(enable.body.backupCodes).toHaveLength(10);
  });

  it('login with 2FA returns a challenge, completed at /2fa/verify', async () => {
    const secret = generateTotpSecret();
    const user = {
      id: 'mu-1', email: 'owner@example.com', password: bcrypt.hashSync('pw123456', 10),
      status: 'ACTIVE', role: 'OWNER', workspaceId: 'ws-1', firstName: 'O', lastName: 'W',
      phone: null, avatar: null, tokenVersion: 0, failedLogins: 0, lockedUntil: null,
      twoFactorEnabled: true, twoFactorSecret: secret, twoFactorBackupCodes: [],
    };
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(user as never);
    ctx.prisma.workspace.findUnique.mockResolvedValue({ status: 'ACTIVE' } as never);
    (ctx.prisma.marketingUser.update as jest.Mock).mockResolvedValue({});

    const login = await request(app.getHttpServer())
      .post('/api/marketing/auth/login')
      .send({ email: 'owner@example.com', password: 'pw123456' });

    expect(login.status).toBe(201);
    expect(login.body.twoFactorRequired).toBe(true);
    expect(login.body.accessToken).toBeUndefined();

    const verify = await request(app.getHttpServer())
      .post('/api/marketing/auth/2fa/verify')
      .send({ challengeToken: login.body.challengeToken, code: generateTotpCode(secret) });

    expect(verify.status).toBe(201);
    expect(verify.body.accessToken).toBeDefined();
  });

  it('rejects 2fa/verify with a bad code', async () => {
    const secret = generateTotpSecret();
    const user = {
      id: 'mu-1', email: 'owner@example.com', password: bcrypt.hashSync('pw123456', 10),
      status: 'ACTIVE', role: 'OWNER', workspaceId: 'ws-1', firstName: 'O', lastName: 'W',
      phone: null, avatar: null, tokenVersion: 0, failedLogins: 0, lockedUntil: null,
      twoFactorEnabled: true, twoFactorSecret: secret, twoFactorBackupCodes: [],
    };
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(user as never);
    ctx.prisma.workspace.findUnique.mockResolvedValue({ status: 'ACTIVE' } as never);
    (ctx.prisma.marketingUser.update as jest.Mock).mockResolvedValue({});

    const login = await request(app.getHttpServer())
      .post('/api/marketing/auth/login')
      .send({ email: 'owner@example.com', password: 'pw123456' });

    const bad = generateTotpCode(secret) === '000000' ? '111111' : '000000';
    const verify = await request(app.getHttpServer())
      .post('/api/marketing/auth/2fa/verify')
      .send({ challengeToken: login.body.challengeToken, code: bad });

    expect(verify.status).toBe(401);
  });
});
