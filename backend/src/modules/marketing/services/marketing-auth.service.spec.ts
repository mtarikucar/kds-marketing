import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { MarketingAuthService } from './marketing-auth.service';
import { hashBackupCode, verifyTotpStep } from '../util/totp';

// Keep hashBackupCode real (the backup-code tests hash for real); control the
// TOTP step + unseal so the replay-guard tests don't need a real secret box.
jest.mock('../util/totp', () => ({
  ...jest.requireActual('../util/totp'),
  verifyTotpStep: jest.fn(),
  openTotpSecret: jest.fn((s: string) => s),
}));
const mockVerifyTotpStep = verifyTotpStep as jest.Mock;

/**
 * registerWorkspace pre-checks the owner email, then provisions the workspace
 * (owner + sentinel + config + trial) in a transaction. The email/slug unique
 * indexes are the real arbiters under concurrency — two simultaneous signups
 * that both pass the pre-check race on INSERT. The loser must surface a clean
 * 409, not leak the raw Prisma P2002 as a 500.
 */
describe('MarketingAuthService.registerWorkspace — concurrent-duplicate → 409', () => {
  const DTO = {
    email: 'owner@acme.test',
    password: 'sufficiently-long-pw',
    firstName: 'Ada',
    lastName: 'Lovelace',
    workspaceName: 'Acme',
    productName: 'Acme CRM',
  } as never;

  function make() {
    const prisma = {
      marketingUser: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(),
    };
    const jwt = { sign: jest.fn().mockReturnValue('tok') };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const smsOtp = { issue: jest.fn(), verify: jest.fn() };
    // registerWorkspace never touches MembershipService — the owner IS the
    // first/only member, minted directly by generateTokens — so this only
    // needs to exist to satisfy the constructor.
    const membership = { resolveDefaultWorkspaceId: jest.fn(), getActiveMembership: jest.fn() };
    const svc = new MarketingAuthService(
      prisma as never,
      jwt as never,
      config as never,
      smsOtp as never,
      membership as never,
    );
    return { prisma, svc };
  }

  const p2002 = (target: string[]) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target },
    });

  it('maps a racing duplicate-email P2002 to a ConflictException', async () => {
    const { prisma, svc } = make();
    prisma.$transaction.mockRejectedValue(p2002(['email']));
    await expect(svc.registerWorkspace(DTO)).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a racing duplicate-slug P2002 to a ConflictException', async () => {
    const { prisma, svc } = make();
    prisma.$transaction.mockRejectedValue(p2002(['slug']));
    await expect(svc.registerWorkspace(DTO)).rejects.toBeInstanceOf(ConflictException);
  });
});

/**
 * NetGSM SMS v2 Task 12 — the SMS 2FA factor is read off `twoFactorSecret`
 * being null (see two-factor.service.ts's class doc): TOTP has no server-side
 * push, so login() must proactively text a code for an SMS-armed account,
 * and verify2fa()/resendTwoFactorSms() must route to SmsOtpService instead of
 * verifyTotp for that same account.
 */
describe('MarketingAuthService — SMS 2FA login integration', () => {
  const PASSWORD = 'correct-horse-battery-staple';
  let PASSWORD_HASH: string;
  beforeAll(async () => {
    PASSWORD_HASH = await bcrypt.hash(PASSWORD, 4); // low cost — tests only, not security-relevant
  });

  function baseUser(overrides: Record<string, unknown> = {}) {
    return {
      id: 'u1',
      workspaceId: 'ws1',
      email: 'rep@acme.test',
      password: PASSWORD_HASH,
      firstName: 'Rep',
      lastName: 'One',
      phone: '05551234567',
      avatar: null,
      role: 'REP',
      status: 'ACTIVE',
      failedLogins: 0,
      lockedUntil: null,
      tokenVersion: 0,
      twoFactorEnabled: true,
      twoFactorSecret: null, // SMS factor
      twoFactorBackupCodes: [],
      ...overrides,
    };
  }

  function make() {
    const prisma = {
      marketingUser: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // Atomic backup-code consume (jsonb) returns the affected-row count.
      $executeRaw: jest.fn().mockResolvedValue(1),
      workspace: {
        findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }),
      },
    };
    const jwt = {
      sign: jest.fn().mockReturnValue('challenge-tok'),
      verifyAsync: jest.fn().mockResolvedValue({ sub: 'u1', type: 'marketing', tokenType: '2fa-challenge' }),
    };
    const config = { get: jest.fn().mockReturnValue('test-secret') };
    const smsOtp = { issue: jest.fn(), verify: jest.fn() };
    // verify2fa() now ends by resolving the default membership (Phase 1 Task
    // 5): land back on the user's own home workspace/role so this file's
    // pre-existing assertions (which predate MembershipService) still hold.
    const membership = {
      resolveDefaultWorkspaceId: jest.fn(async (_userId: string, homeWorkspaceId: string) => homeWorkspaceId),
      getActiveMembership: jest.fn(async (_userId: string, workspaceId: string) => ({
        workspaceId,
        role: 'REP',
        customRoleId: null,
      })),
    };
    const svc = new MarketingAuthService(
      prisma as never,
      jwt as never,
      config as never,
      smsOtp as never,
      membership as never,
    );
    return { prisma, jwt, smsOtp, svc };
  }

  describe('login()', () => {
    it('texts a fresh code for an SMS-armed account (twoFactorSecret null) and still returns the challenge', async () => {
      const { prisma, smsOtp, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
      smsOtp.issue.mockResolvedValue({ ok: true });

      const out = await svc.login({ email: 'rep@acme.test', password: PASSWORD } as never);

      expect(out).toEqual({ twoFactorRequired: true, challengeToken: 'challenge-tok' });
      expect(smsOtp.issue).toHaveBeenCalledWith(
        'ws1',
        { purpose: 'TWO_FACTOR', targetType: 'USER', targetId: 'u1' },
        '05551234567',
      );
    });

    it('does NOT text a code for a TOTP-armed account (twoFactorSecret set)', async () => {
      const { prisma, smsOtp, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser({ twoFactorSecret: 'sealed-secret' }));

      const out = await svc.login({ email: 'rep@acme.test', password: PASSWORD } as never);

      expect(out).toEqual({ twoFactorRequired: true, challengeToken: 'challenge-tok' });
      expect(smsOtp.issue).not.toHaveBeenCalled();
    });

    it('a NetGSM/SMS outage during the challenge send never fails the login call', async () => {
      const { prisma, smsOtp, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
      smsOtp.issue.mockRejectedValue(new Error('NetGSM unreachable'));

      const out = await svc.login({ email: 'rep@acme.test', password: PASSWORD } as never);
      expect(out).toEqual({ twoFactorRequired: true, challengeToken: 'challenge-tok' });
    });
  });

  // Review fix round 1 (Finding 6) — the response used to leak which 2FA
  // factor the account uses ({sent:false} for TOTP vs {sent:true}/a thrown
  // exception for SMS). It's now uniformly {sent:true} regardless of factor
  // or delivery outcome; the SMS send itself stays best-effort.
  describe('resendTwoFactorSms()', () => {
    it('re-issues a code for an SMS-armed account', async () => {
      const { prisma, smsOtp, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
      smsOtp.issue.mockResolvedValue({ ok: true });
      const out = await svc.resendTwoFactorSms('tok');
      expect(out).toEqual({ sent: true });
      expect(smsOtp.issue).toHaveBeenCalledWith(
        'ws1',
        { purpose: 'TWO_FACTOR', targetType: 'USER', targetId: 'u1' },
        '05551234567',
      );
    });

    it('is a safe no-op for a TOTP-armed account — but the response is now indistinguishable from the SMS-armed case', async () => {
      const { prisma, smsOtp, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser({ twoFactorSecret: 'sealed-secret' }));
      const out = await svc.resendTwoFactorSms('tok');
      expect(out).toEqual({ sent: true });
      expect(smsOtp.issue).not.toHaveBeenCalled();
    });

    it('never throws when the SMS-armed account has no phone on file — uniform {sent:true}, no factor-revealing exception', async () => {
      const { prisma, smsOtp, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser({ phone: null }));
      const out = await svc.resendTwoFactorSms('tok');
      expect(out).toEqual({ sent: true });
      expect(smsOtp.issue).not.toHaveBeenCalled();
    });

    it('a NetGSM/SmsOtpService failure during resend never fails the call (best-effort, mirrors login())', async () => {
      const { prisma, smsOtp, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
      smsOtp.issue.mockRejectedValue(new Error('NetGSM unreachable'));
      const out = await svc.resendTwoFactorSms('tok');
      expect(out).toEqual({ sent: true });
    });
  });

  describe('verify2fa()', () => {
    it('completes login when SmsOtpService confirms the code (SMS-armed account)', async () => {
      const { prisma, smsOtp, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
      smsOtp.verify.mockResolvedValue({ ok: true });

      const out: any = await svc.verify2fa('tok', '123456');

      expect(out.accessToken).toBe('challenge-tok');
      // Review fix round 1 (Finding 2) — verify() now requires the user's
      // current phone, binding the proof to the number the code was texted to.
      expect(smsOtp.verify).toHaveBeenCalledWith(
        'ws1',
        { purpose: 'TWO_FACTOR', targetType: 'USER', targetId: 'u1' },
        '123456',
        '05551234567',
      );
    });

    it('rejects when SmsOtpService says the code is wrong (SMS-armed account, no backup code)', async () => {
      const { prisma, smsOtp, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
      smsOtp.verify.mockResolvedValue({ ok: false });
      await expect(svc.verify2fa('tok', '000000')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('a valid backup code completes login WITHOUT ever calling SmsOtpService.verify', async () => {
      const { prisma, smsOtp, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(
        baseUser({ twoFactorBackupCodes: [hashBackupCode('deadbeef00')] }),
      );

      const out: any = await svc.verify2fa('tok', 'deadbeef00');

      expect(out.accessToken).toBe('challenge-tok');
      expect(smsOtp.verify).not.toHaveBeenCalled();
      // The code is consumed ATOMICALLY (jsonb), not via a read-filter-write update.
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(prisma.marketingUser.update).not.toHaveBeenCalled();
    });

    it('backup-code race: a concurrent second use (atomic consume matches 0 rows) is rejected', async () => {
      const { prisma, smsOtp, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(
        baseUser({ twoFactorBackupCodes: [hashBackupCode('deadbeef00')] }),
      );
      prisma.$executeRaw.mockResolvedValue(0); // the racing winner already removed it

      await expect(svc.verify2fa('tok', 'deadbeef00')).rejects.toBeInstanceOf(UnauthorizedException);
      // A losing backup-code claim must NOT fall through to burn an SMS attempt.
      expect(smsOtp.verify).not.toHaveBeenCalled();
    });

    it('TOTP: accepts a fresh step and ATOMICALLY claims it (rejects a step not newer than the last)', async () => {
      const { prisma, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(
        baseUser({ twoFactorSecret: 'sealed', twoFactorBackupCodes: [], twoFactorLastStep: 99 }),
      );
      mockVerifyTotpStep.mockReturnValue(100); // a valid, newer step

      const out: any = await svc.verify2fa('tok', '123456');

      expect(out.accessToken).toBe('challenge-tok');
      // The claim advances the step only if strictly newer (replay-safe under races).
      const call = (prisma.marketingUser.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.data).toEqual({ twoFactorLastStep: 100 });
      expect(call.where.OR).toEqual([{ twoFactorLastStep: null }, { twoFactorLastStep: { lt: 100 } }]);
    });

    it('TOTP replay: a code whose step is already consumed (claim matches 0 rows) is rejected', async () => {
      const { prisma, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(
        baseUser({ twoFactorSecret: 'sealed', twoFactorBackupCodes: [], twoFactorLastStep: 100 }),
      );
      mockVerifyTotpStep.mockReturnValue(100); // same step as last consumed
      prisma.marketingUser.updateMany.mockResolvedValue({ count: 0 }); // conditional claim finds nothing

      await expect(svc.verify2fa('tok', '123456')).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  // Review fix round 1 (Finding 1 — 2FA channel hijack): a phone change on an
  // account with SMS 2FA armed re-points where future login challenges get
  // texted — this must require currentPassword re-verification, mirroring
  // changePassword's existing currentPassword precedent. TOTP-armed and
  // no-2FA accounts, and non-phone edits, are all unaffected.
  describe('updateProfile()', () => {
    it('rejects a phone change on an SMS-2FA-armed account with no currentPassword', async () => {
      const { prisma, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
      await expect(
        svc.updateProfile('u1', { phone: '05559999999' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.marketingUser.update).not.toHaveBeenCalled();
    });

    it('rejects a phone change on an SMS-2FA-armed account with a WRONG currentPassword', async () => {
      const { prisma, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
      await expect(
        svc.updateProfile('u1', { phone: '05559999999', currentPassword: 'not-the-password' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.marketingUser.update).not.toHaveBeenCalled();
    });

    it('allows a phone change on an SMS-2FA-armed account WITH a valid currentPassword', async () => {
      const { prisma, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
      await svc.updateProfile('u1', { phone: '05559999999', currentPassword: PASSWORD });
      // currentPassword must never leak into the actual DB write.
      const data = (prisma.marketingUser.update as jest.Mock).mock.calls[0][0].data;
      expect(data).toEqual({ phone: '05559999999' });
    });

    it('does NOT gate a phone change on a TOTP-armed account (unaffected)', async () => {
      const { prisma, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser({ twoFactorSecret: 'sealed-secret' }));
      await svc.updateProfile('u1', { phone: '05559999999' });
      expect(prisma.marketingUser.update).toHaveBeenCalled();
    });

    it('does NOT gate a phone change on a no-2FA account (unaffected)', async () => {
      const { prisma, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(
        baseUser({ twoFactorEnabled: false, twoFactorSecret: null }),
      );
      await svc.updateProfile('u1', { phone: '05559999999' });
      expect(prisma.marketingUser.update).toHaveBeenCalled();
    });

    it('does NOT gate when the "new" phone is actually unchanged', async () => {
      const { prisma, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser()); // phone: '05551234567'
      await svc.updateProfile('u1', { phone: '05551234567' });
      expect(prisma.marketingUser.update).toHaveBeenCalled();
    });

    it('never runs the SMS-2FA/phone pre-check at all for a non-phone edit', async () => {
      const { prisma, svc } = make();
      await svc.updateProfile('u1', { firstName: 'New' });
      expect(prisma.marketingUser.findUnique).not.toHaveBeenCalled();
      expect(prisma.marketingUser.update).toHaveBeenCalled();
    });
  });
});
