import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TwoFactorService } from './two-factor.service';
import { generateTotpSecret, generateTotpCode } from '../util/totp';
import { openSecret } from '../../../common/crypto/secret-box.helper';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

function makeSvc() {
  const prisma = mockPrismaClient();
  const smsOtp = { issue: jest.fn(), verify: jest.fn() } as any;
  // Default to entitled so every EXISTING test (written before the Task 13
  // purpose-aware gate) keeps passing without having to know about
  // entitlements; the dedicated "smsOtp entitlement gate" describe block
  // below overrides this per-test to exercise the 403/bypass branches.
  const entitlements = { getEffective: jest.fn().mockResolvedValue({ features: { smsOtp: true } }) } as any;
  return { prisma, smsOtp, entitlements, svc: new TwoFactorService(prisma as any, smsOtp, entitlements) };
}

describe('TwoFactorService', () => {
  it('beginEnroll stores a secret and returns an otpauth URI', async () => {
    const { prisma, svc } = makeSvc();
    prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' } as any);
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
    const out: any = await svc.beginEnroll('u1');
    expect(out.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect((prisma.marketingUser.update as jest.Mock).mock.calls[0][0].data.twoFactorSecret).toBe(out.secret);
  });

  it('beginEnroll renders the QR server-side as a data URI (no third-party QR service)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' } as any);
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
    const out: any = await svc.beginEnroll('u1');
    // The secret-bearing otpauth URI must never be handed to an external QR
    // renderer — the QR is generated here and returned as a self-contained PNG.
    expect(out.qrDataUri).toMatch(/^data:image\/png;base64,/);
  });

  it('beginEnroll refuses when 2FA is already enabled (no code-free disable / re-enroll)', async () => {
    // `disable` deliberately requires a valid code so a hijacked session can't
    // turn 2FA off. beginEnroll must not become a code-free backdoor for that:
    // it used to unconditionally set twoFactorEnabled=false (silently disabling
    // an enrolled user and desyncing their authenticator). Refuse instead.
    const { prisma, svc } = makeSvc();
    prisma.marketingUser.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      twoFactorEnabled: true,
      twoFactorSecret: 'sealed',
    } as any);
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
    await expect(svc.beginEnroll('u1')).rejects.toBeInstanceOf(BadRequestException);
    // It must NOT have written anything (no flip of twoFactorEnabled to false).
    expect(prisma.marketingUser.update as jest.Mock).not.toHaveBeenCalled();
  });

  it('enable verifies a TOTP code, flips the flag, and issues backup codes', async () => {
    const { prisma, svc } = makeSvc();
    const secret = generateTotpSecret();
    prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', twoFactorSecret: secret } as any);
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
    const out: any = await svc.enable('u1', generateTotpCode(secret));
    expect(out.enabled).toBe(true);
    expect(out.backupCodes).toHaveLength(10);
    expect((prisma.marketingUser.update as jest.Mock).mock.calls[0][0].data.twoFactorEnabled).toBe(true);
  });

  it('disable verifies a code then clears 2FA', async () => {
    const { prisma, svc } = makeSvc();
    const secret = generateTotpSecret();
    prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', twoFactorEnabled: true, twoFactorSecret: secret, twoFactorBackupCodes: [] } as any);
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
    const out: any = await svc.disable('u1', generateTotpCode(secret));
    expect(out.enabled).toBe(false);
    const data = (prisma.marketingUser.update as jest.Mock).mock.calls[0][0].data;
    expect(data.twoFactorEnabled).toBe(false);
    // ALL 2FA state is cleared — secret, backup codes AND the replay-guard step.
    expect(data.twoFactorSecret).toBeNull();
    expect(data.twoFactorLastStep).toBeNull();
  });

  it('status reports the flag (+ method — see the dedicated SMS-factor describe block below)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', twoFactorEnabled: true, twoFactorSecret: 'sealed' } as any);
    expect(await svc.status('u1')).toEqual({ enabled: true, method: 'TOTP' });
  });

  describe('TOTP secret is SEALED at rest (secret-box configured)', () => {
    const KEY = Buffer.alloc(32, 9).toString('base64');
    beforeAll(() => (process.env.MARKETING_SECRET_KEY = KEY));
    afterAll(() => delete process.env.MARKETING_SECRET_KEY);

    it('beginEnroll stores the secret SEALED (v1:...), not plaintext', async () => {
      const { prisma, svc } = makeSvc();
      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' } as any);
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
      const out: any = await svc.beginEnroll('u1');
      const stored = (prisma.marketingUser.update as jest.Mock).mock.calls[0][0].data
        .twoFactorSecret as string;
      // Persisted ciphertext, never the raw base32 seed; opens back to it.
      expect(stored.startsWith('v1:')).toBe(true);
      expect(stored).not.toBe(out.secret);
      expect(openSecret(stored)).toBe(out.secret);
    });

    it('enable verifies against a SEALED stored secret', async () => {
      const { prisma, svc } = makeSvc();
      // Simulate a sealed enrollment row.
      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' } as any);
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
      const enroll: any = await svc.beginEnroll('u1');
      const sealed = (prisma.marketingUser.update as jest.Mock).mock.calls[0][0].data
        .twoFactorSecret as string;
      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', twoFactorSecret: sealed } as any);
      const out: any = await svc.enable('u1', generateTotpCode(enroll.secret));
      expect(out.enabled).toBe(true);
    });

    it('still verifies a LEGACY plaintext secret enrolled before the change', async () => {
      const { prisma, svc } = makeSvc();
      const legacy = generateTotpSecret(); // unsealed, as old rows are stored
      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', twoFactorSecret: legacy } as any);
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
      const out: any = await svc.enable('u1', generateTotpCode(legacy));
      expect(out.enabled).toBe(true);
    });
  });

  describe('SMS factor (NetGSM SMS v2 Task 12)', () => {
    it('sendSmsCode requires a phone on file', async () => {
      const { prisma, svc } = makeSvc();
      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', workspaceId: 'ws1', phone: null } as any);
      await expect(svc.sendSmsCode('u1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sendSmsCode refuses when TOTP is already the active factor', async () => {
      const { prisma, svc } = makeSvc();
      prisma.marketingUser.findUnique.mockResolvedValue({
        id: 'u1', workspaceId: 'ws1', phone: '05551234567',
        twoFactorEnabled: true, twoFactorSecret: 'sealed',
      } as any);
      await expect(svc.sendSmsCode('u1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sendSmsCode issues via SmsOtpService, scoped to (TWO_FACTOR, USER, userId)', async () => {
      const { prisma, smsOtp, svc } = makeSvc();
      prisma.marketingUser.findUnique.mockResolvedValue({
        id: 'u1', workspaceId: 'ws1', phone: '05551234567', twoFactorEnabled: false, twoFactorSecret: null,
      } as any);
      smsOtp.issue.mockResolvedValue({ ok: true });
      const out = await svc.sendSmsCode('u1');
      expect(out).toEqual({ sent: true });
      expect(smsOtp.issue).toHaveBeenCalledWith(
        'ws1',
        { purpose: 'TWO_FACTOR', targetType: 'USER', targetId: 'u1' },
        '05551234567',
      );
    });

    it('sendSmsCode surfaces the SmsOtpService failure message (e.g. NetGSM code 60)', async () => {
      const { prisma, smsOtp, svc } = makeSvc();
      prisma.marketingUser.findUnique.mockResolvedValue({
        id: 'u1', workspaceId: 'ws1', phone: '05551234567', twoFactorEnabled: false, twoFactorSecret: null,
      } as any);
      smsOtp.issue.mockResolvedValue({ ok: false, code: '60', message: 'no OTP package' });
      await expect(svc.sendSmsCode('u1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('enableSms verifies the code, flips the flag, keeps twoFactorSecret null, and issues backup codes', async () => {
      const { prisma, smsOtp, svc } = makeSvc();
      prisma.marketingUser.findUnique.mockResolvedValue({
        id: 'u1', workspaceId: 'ws1', phone: '05551234567', twoFactorEnabled: false, twoFactorSecret: null,
      } as any);
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
      smsOtp.verify.mockResolvedValue({ ok: true });
      const out: any = await svc.enableSms('u1', '123456');
      expect(out.enabled).toBe(true);
      expect(out.backupCodes).toHaveLength(10);
      const data = (prisma.marketingUser.update as jest.Mock).mock.calls[0][0].data;
      expect(data.twoFactorEnabled).toBe(true);
      expect(data.twoFactorSecret).toBeNull();
      // Review fix round 1 (Finding 2) — verify() now requires the target's
      // current phone.
      expect(smsOtp.verify).toHaveBeenCalledWith(
        'ws1',
        { purpose: 'TWO_FACTOR', targetType: 'USER', targetId: 'u1' },
        '123456',
        '05551234567',
      );
    });

    it('enableSms refuses re-enrolling over an already-active factor (no code-free bypass)', async () => {
      const { prisma, svc } = makeSvc();
      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', twoFactorEnabled: true } as any);
      await expect(svc.enableSms('u1', '123456')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('enableSms rejects an invalid code', async () => {
      const { prisma, smsOtp, svc } = makeSvc();
      prisma.marketingUser.findUnique.mockResolvedValue({
        id: 'u1', workspaceId: 'ws1', twoFactorEnabled: false, twoFactorSecret: null,
      } as any);
      smsOtp.verify.mockResolvedValue({ ok: false, message: 'Invalid code.' });
      await expect(svc.enableSms('u1', '000000')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('disable verifies via SmsOtpService when the active factor is SMS (twoFactorSecret null)', async () => {
      const { prisma, smsOtp, svc } = makeSvc();
      prisma.marketingUser.findUnique.mockResolvedValue({
        id: 'u1', workspaceId: 'ws1', phone: '05551234567', twoFactorEnabled: true, twoFactorSecret: null, twoFactorBackupCodes: [],
      } as any);
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
      smsOtp.verify.mockResolvedValue({ ok: true });
      const out: any = await svc.disable('u1', '123456');
      expect(out.enabled).toBe(false);
      // Review fix round 1 (Finding 2) — verify() now requires the target's
      // current phone, so the disable-reauth call must pass it too.
      expect(smsOtp.verify).toHaveBeenCalledWith(
        'ws1',
        { purpose: 'TWO_FACTOR', targetType: 'USER', targetId: 'u1' },
        '123456',
        '05551234567',
      );
    });

    it('disable via a valid backup code never calls SmsOtpService.verify (no wasted attempt on an unrelated pending code)', async () => {
      const { prisma, smsOtp, svc } = makeSvc();
      const { hashBackupCode } = jest.requireActual('../util/totp');
      prisma.marketingUser.findUnique.mockResolvedValue({
        id: 'u1', workspaceId: 'ws1', twoFactorEnabled: true, twoFactorSecret: null,
        twoFactorBackupCodes: [hashBackupCode('deadbeef00')],
      } as any);
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
      const out: any = await svc.disable('u1', 'deadbeef00');
      expect(out.enabled).toBe(false);
      expect(smsOtp.verify).not.toHaveBeenCalled();
    });

    it('disable rejects an invalid code for an SMS-armed account', async () => {
      const { prisma, smsOtp, svc } = makeSvc();
      prisma.marketingUser.findUnique.mockResolvedValue({
        id: 'u1', workspaceId: 'ws1', twoFactorEnabled: true, twoFactorSecret: null, twoFactorBackupCodes: [],
      } as any);
      smsOtp.verify.mockResolvedValue({ ok: false });
      await expect(svc.disable('u1', '000000')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('status reports method TOTP when a secret is set, SMS when not, null when disabled', async () => {
      const { prisma, svc } = makeSvc();
      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', twoFactorEnabled: true, twoFactorSecret: 'sealed' } as any);
      expect(await svc.status('u1')).toEqual({ enabled: true, method: 'TOTP' });

      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', twoFactorEnabled: true, twoFactorSecret: null } as any);
      expect(await svc.status('u1')).toEqual({ enabled: true, method: 'SMS' });

      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', twoFactorEnabled: false, twoFactorSecret: null } as any);
      expect(await svc.status('u1')).toEqual({ enabled: false, method: null });
    });
  });

  describe('sendSmsCode — purpose-aware smsOtp entitlement gate (NetGSM SMS v2 Task 13)', () => {
    // Lockout fix: `sms/send` no longer carries a blanket route-level
    // @RequiresFeature — see two-factor.controller.ts. A NEW enrollment send
    // (caller isn't SMS-armed yet) still requires the `smsOtp` add-on; a send
    // that services an ALREADY-armed SMS factor (disable()'s reauth code)
    // must stay available even without it, so a workspace that armed
    // SMS-2FA and then lost the add-on (cancel/downgrade) is never stranded
    // on a factor it can't remove.
    it('(a) non-armed user WITHOUT smsOtp -> ForbiddenException, NetGSM never contacted', async () => {
      const { prisma, smsOtp, entitlements, svc } = makeSvc();
      entitlements.getEffective.mockResolvedValue({ features: { smsOtp: false } });
      prisma.marketingUser.findUnique.mockResolvedValue({
        id: 'u1', workspaceId: 'ws1', phone: '05551234567', twoFactorEnabled: false, twoFactorSecret: null,
      } as any);
      await expect(svc.sendSmsCode('u1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(smsOtp.issue).not.toHaveBeenCalled();
    });

    it('(b) already-SMS-armed user WITHOUT smsOtp -> allowed, entitlements never even consulted', async () => {
      const { prisma, smsOtp, entitlements, svc } = makeSvc();
      entitlements.getEffective.mockResolvedValue({ features: { smsOtp: false } });
      prisma.marketingUser.findUnique.mockResolvedValue({
        id: 'u1', workspaceId: 'ws1', phone: '05551234567', twoFactorEnabled: true, twoFactorSecret: null,
      } as any);
      smsOtp.issue.mockResolvedValue({ ok: true });
      const out = await svc.sendSmsCode('u1');
      expect(out).toEqual({ sent: true });
      expect(entitlements.getEffective).not.toHaveBeenCalled();
      expect(smsOtp.issue).toHaveBeenCalledWith(
        'ws1',
        { purpose: 'TWO_FACTOR', targetType: 'USER', targetId: 'u1' },
        '05551234567',
      );
    });

    it('non-armed user WITH smsOtp -> allowed (new enrollment, entitled)', async () => {
      const { prisma, smsOtp, entitlements, svc } = makeSvc();
      entitlements.getEffective.mockResolvedValue({ features: { smsOtp: true } });
      prisma.marketingUser.findUnique.mockResolvedValue({
        id: 'u1', workspaceId: 'ws1', phone: '05551234567', twoFactorEnabled: false, twoFactorSecret: null,
      } as any);
      smsOtp.issue.mockResolvedValue({ ok: true });
      const out = await svc.sendSmsCode('u1');
      expect(out).toEqual({ sent: true });
      expect(smsOtp.issue).toHaveBeenCalled();
    });

    it('TOTP-armed user is refused before the entitlement check ever runs', async () => {
      const { prisma, entitlements, svc } = makeSvc();
      entitlements.getEffective.mockResolvedValue({ features: { smsOtp: false } });
      prisma.marketingUser.findUnique.mockResolvedValue({
        id: 'u1', workspaceId: 'ws1', phone: '05551234567', twoFactorEnabled: true, twoFactorSecret: 'sealed',
      } as any);
      await expect(svc.sendSmsCode('u1')).rejects.toBeInstanceOf(BadRequestException);
      expect(entitlements.getEffective).not.toHaveBeenCalled();
    });
  });
});
