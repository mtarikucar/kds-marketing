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
import { EntitlementsService } from '../../src/modules/billing/entitlements.service';
import { TwoFactorService } from '../../src/modules/marketing/services/two-factor.service';

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

/**
 * Money-path fix: the SMS-factor routes (`sms/send`, `sms/enable`) trigger a
 * real, billed NetGSM OTP send — they must be gated on the `smsOtp` add-on,
 * the same way MarketingLeadsController's verify-phone routes are. TOTP
 * enroll/enable/disable/status carry no `@RequiresFeature` and must stay
 * reachable regardless of `smsOtp`. EntitlementsService and TwoFactorService
 * are overridden here so the assertions isolate the FeatureGuard's own
 * allow/deny decision from both the real entitlement-fold logic (covered by
 * entitlements.service.spec.ts) and the 2FA business logic (covered by
 * two-factor.service.spec.ts).
 */
describe('SMS-2FA feature gate (smsOtp add-on)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;
  let entitlements: { getEffective: jest.Mock };
  let svc: {
    sendSmsCode: jest.Mock;
    enableSms: jest.Mock;
    beginEnroll: jest.Mock;
    status: jest.Mock;
  };

  beforeAll(async () => {
    entitlements = { getEffective: jest.fn() };
    svc = {
      sendSmsCode: jest.fn().mockResolvedValue({ sent: true }),
      enableSms: jest.fn().mockResolvedValue({ enabled: true, backupCodes: ['a', 'b'] }),
      beginEnroll: jest.fn().mockResolvedValue({ secret: 's', otpauthUri: 'u', qrDataUri: 'd' }),
      status: jest.fn().mockResolvedValue({ enabled: false, method: null }),
    };
    ctx = await createTestApp((builder) => {
      builder.overrideProvider(EntitlementsService).useValue(entitlements);
      builder.overrideProvider(TwoFactorService).useValue(svc);
    });
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => {
    jest.clearAllMocks();
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(mockMarketingUser({ id: 'mu-1' }) as never);
  });

  const auth = () => `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1' })}`;

  it('sms/send without the smsOtp add-on -> 403, never reaches the service', async () => {
    entitlements.getEffective.mockResolvedValue({ features: { smsOtp: false } } as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/auth/2fa/sms/send')
      .set('Authorization', auth())
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_NOT_IN_PACKAGE');
    expect(svc.sendSmsCode).not.toHaveBeenCalled();
  });

  it('sms/enable without the smsOtp add-on -> 403, never reaches the service', async () => {
    entitlements.getEffective.mockResolvedValue({ features: { smsOtp: false } } as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/auth/2fa/sms/enable')
      .set('Authorization', auth())
      .send({ code: '123456' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_NOT_IN_PACKAGE');
    expect(svc.enableSms).not.toHaveBeenCalled();
  });

  it('sms/send WITH the smsOtp add-on -> allowed through to the service', async () => {
    entitlements.getEffective.mockResolvedValue({ features: { smsOtp: true } } as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/auth/2fa/sms/send')
      .set('Authorization', auth())
      .send({});

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ sent: true });
    expect(svc.sendSmsCode).toHaveBeenCalledWith('mu-1');
  });

  it('sms/enable WITH the smsOtp add-on -> allowed through to the service', async () => {
    entitlements.getEffective.mockResolvedValue({ features: { smsOtp: true } } as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/auth/2fa/sms/enable')
      .set('Authorization', auth())
      .send({ code: '123456' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ enabled: true, backupCodes: ['a', 'b'] });
    expect(svc.enableSms).toHaveBeenCalledWith('mu-1', '123456');
  });

  it('TOTP routes (enroll/status) stay reachable without the smsOtp add-on', async () => {
    entitlements.getEffective.mockResolvedValue({ features: { smsOtp: false } } as never);

    const enroll = await request(app.getHttpServer())
      .post('/api/marketing/auth/2fa/enroll')
      .set('Authorization', auth());
    expect(enroll.status).toBe(201);
    expect(svc.beginEnroll).toHaveBeenCalledWith('mu-1');

    const status = await request(app.getHttpServer())
      .get('/api/marketing/auth/2fa/status')
      .set('Authorization', auth());
    expect(status.status).toBe(200);
    expect(svc.status).toHaveBeenCalledWith('mu-1');
  });
});
