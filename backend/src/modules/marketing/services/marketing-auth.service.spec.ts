import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { MarketingAuthService } from './marketing-auth.service';
import { hashBackupCode } from '../util/totp';

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
    const svc = new MarketingAuthService(
      prisma as never,
      jwt as never,
      config as never,
      smsOtp as never,
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
      },
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
    const svc = new MarketingAuthService(
      prisma as never,
      jwt as never,
      config as never,
      smsOtp as never,
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

    it('is a safe no-op for a TOTP-armed account', async () => {
      const { prisma, smsOtp, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser({ twoFactorSecret: 'sealed-secret' }));
      const out = await svc.resendTwoFactorSms('tok');
      expect(out).toEqual({ sent: false });
      expect(smsOtp.issue).not.toHaveBeenCalled();
    });

    it('rejects when the SMS-armed account has no phone on file', async () => {
      const { prisma, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser({ phone: null }));
      await expect(svc.resendTwoFactorSms('tok')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('verify2fa()', () => {
    it('completes login when SmsOtpService confirms the code (SMS-armed account)', async () => {
      const { prisma, smsOtp, svc } = make();
      prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
      smsOtp.verify.mockResolvedValue({ ok: true });

      const out: any = await svc.verify2fa('tok', '123456');

      expect(out.accessToken).toBe('challenge-tok');
      expect(smsOtp.verify).toHaveBeenCalledWith(
        'ws1',
        { purpose: 'TWO_FACTOR', targetType: 'USER', targetId: 'u1' },
        '123456',
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
      // The consumed backup code is removed so it can't be reused.
      const data = (prisma.marketingUser.update as jest.Mock).mock.calls[0][0].data;
      expect(data.twoFactorBackupCodes).toEqual([]);
    });
  });
});
