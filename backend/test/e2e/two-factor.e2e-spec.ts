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
import { SmsOtpService } from '../../src/modules/marketing/services/sms-otp.service';

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
    // verify2fa's TOTP branch atomically claims the 30s time-step via
    // marketingUser.updateMany (RFC 6238 replay guard); the shared harness
    // defaults this to { count: 0 } (no rows claimed), so drive the
    // claim-succeeds case explicitly for this happy-path test.
    (ctx.prisma.marketingUser.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    // Multi-workspace: issueForDefaultWorkspace() resolves the session's
    // workspace/role off a live WorkspaceMembership row (resolveDefaultWorkspaceId
    // + getActiveMembership both read workspaceMembership.findFirst), not off the
    // MarketingUser row's own `role`/`workspaceId` columns. findFirst defaults to
    // `undefined` (not-found) in the harness, so without this the claim resolves
    // to "no active workspace" and 401s even though the 2FA code itself checks out.
    ctx.prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'wm-1', workspaceId: 'ws-1', role: 'OWNER', customRoleId: null,
    } as never);

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
 * Money-path fix: `sms/enable` (arming the factor) trigger a real, billed
 * NetGSM OTP verify and stays gated on the `smsOtp` add-on, the same way
 * MarketingLeadsController's verify-phone routes are. TOTP enroll/enable/
 * disable/status carry no `@RequiresFeature` and must stay reachable
 * regardless of `smsOtp`. EntitlementsService and TwoFactorService are
 * overridden here so the assertions isolate the FeatureGuard's own
 * allow/deny decision from both the real entitlement-fold logic (covered by
 * entitlements.service.spec.ts) and the 2FA business logic (covered by
 * two-factor.service.spec.ts).
 *
 * `sms/send` is deliberately NOT covered by this route-level gate anymore —
 * see the next describe block, "SMS-2FA sms/send" below, for its
 * purpose-aware, service-level entitlement check (NetGSM SMS v2 Task 13).
 */
describe('SMS-2FA feature gate (smsOtp add-on) — sms/enable + TOTP reachability', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;
  let entitlements: { getEffective: jest.Mock };
  let svc: {
    enableSms: jest.Mock;
    beginEnroll: jest.Mock;
    status: jest.Mock;
  };

  beforeAll(async () => {
    entitlements = { getEffective: jest.fn() };
    svc = {
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

/**
 * Lockout fix (NetGSM SMS v2 Task 13): `sms/send` is dual-purpose — it also
 * issues the reauth code `disable()` needs to remove an already-armed SMS
 * factor — so it can no longer carry a blanket route-level `@RequiresFeature`
 * (see two-factor.controller.ts). The `smsOtp` decision now lives INSIDE
 * TwoFactorService.sendSmsCode() and is purpose-aware: required for a NEW
 * enrollment send, bypassed for a send that services an ALREADY-armed SMS
 * factor. TwoFactorService itself runs for REAL here (only EntitlementsService
 * and SmsOtpService are stubbed) so these assertions exercise the actual
 * armed/non-armed branch, not a re-declaration of it.
 */
describe('SMS-2FA sms/send — purpose-aware smsOtp gate (Task 13 lockout fix)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;
  let entitlements: { getEffective: jest.Mock };
  let smsOtp: { issue: jest.Mock; verify: jest.Mock };

  beforeAll(async () => {
    entitlements = { getEffective: jest.fn() };
    smsOtp = { issue: jest.fn(), verify: jest.fn() };
    ctx = await createTestApp((builder) => {
      builder.overrideProvider(EntitlementsService).useValue(entitlements);
      builder.overrideProvider(SmsOtpService).useValue(smsOtp);
    });
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => jest.clearAllMocks());

  const auth = () => `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1' })}`;
  const nonArmedUser = mockMarketingUser({
    id: 'mu-1', phone: '05551234567', twoFactorEnabled: false, twoFactorSecret: null,
  });
  const smsArmedUser = mockMarketingUser({
    id: 'mu-1', phone: '05551234567', twoFactorEnabled: true, twoFactorSecret: null,
  });

  it('(a) non-armed user WITHOUT smsOtp -> 403, NetGSM never contacted (new enrollment needs the add-on)', async () => {
    entitlements.getEffective.mockResolvedValue({ features: { smsOtp: false } } as never);
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(nonArmedUser as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/auth/2fa/sms/send')
      .set('Authorization', auth())
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_NOT_IN_PACKAGE');
    expect(smsOtp.issue).not.toHaveBeenCalled();
  });

  it('(b) already-SMS-armed user WITHOUT smsOtp -> allowed (disable-reauth must never lock the user out)', async () => {
    entitlements.getEffective.mockResolvedValue({ features: { smsOtp: false } } as never);
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(smsArmedUser as never);
    smsOtp.issue.mockResolvedValue({ ok: true });

    const res = await request(app.getHttpServer())
      .post('/api/marketing/auth/2fa/sms/send')
      .set('Authorization', auth())
      .send({});

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ sent: true });
    expect(entitlements.getEffective).not.toHaveBeenCalled();
    expect(smsOtp.issue).toHaveBeenCalledWith(
      'ws-1',
      { purpose: 'TWO_FACTOR', targetType: 'USER', targetId: 'mu-1' },
      '05551234567',
    );
  });

  it('non-armed user WITH smsOtp -> allowed (new enrollment, entitled)', async () => {
    entitlements.getEffective.mockResolvedValue({ features: { smsOtp: true } } as never);
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(nonArmedUser as never);
    smsOtp.issue.mockResolvedValue({ ok: true });

    const res = await request(app.getHttpServer())
      .post('/api/marketing/auth/2fa/sms/send')
      .set('Authorization', auth())
      .send({});

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ sent: true });
    expect(smsOtp.issue).toHaveBeenCalledWith(
      'ws-1',
      { purpose: 'TWO_FACTOR', targetType: 'USER', targetId: 'mu-1' },
      '05551234567',
    );
  });
});
