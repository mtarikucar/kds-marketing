import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as QRCode from 'qrcode';
import { PrismaService } from '../../../prisma/prisma.service';
import { SmsOtpService, SmsOtpTarget } from './sms-otp.service';
import {
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  openTotpSecret,
  sealTotpSecret,
  totpUri,
  verifyTotp,
} from '../util/totp';

/** Scopes an SmsOtpService call to "this user's 2FA factor" — one code per
 *  user at a time, regardless of whether it's for enrollment or a disable
 *  reauth challenge. */
function smsFactorTarget(userId: string): SmsOtpTarget {
  return { purpose: 'TWO_FACTOR', targetType: 'USER', targetId: userId };
}

/**
 * Epic F — 2FA/MFA management for marketing users, TWO factors: TOTP
 * (authenticator app) and SMS (NetGSM SMS v2 Task 12). A user has at most one
 * active factor at a time. Which one is active is read off `twoFactorSecret`:
 * set → TOTP, null → SMS — no separate "method" column, since the secret's
 * presence already carries that information unambiguously (SMS needs no
 * persistent secret; each code is issued fresh via SmsOtpService). Enrollment
 * stores/derives the factor; `enable*` only flips the flag after a code
 * verifies and then issues single-use backup codes (shown once). Login
 * enforcement lives in MarketingAuthService (challenge → /auth/2fa/verify),
 * which mirrors this same secret-presence branch to pick TOTP vs SMS.
 */
@Injectable()
export class TwoFactorService {
  constructor(
    private prisma: PrismaService,
    private smsOtp: SmsOtpService,
  ) {}

  private async getUser(userId: string) {
    const u = await this.prisma.marketingUser.findUnique({ where: { id: userId } });
    if (!u) throw new NotFoundException('User not found');
    return u;
  }

  async beginEnroll(userId: string) {
    const u = await this.getUser(userId);
    // Refuse to re-enroll an already-protected account. Otherwise beginEnroll —
    // which takes NO verification code — would set twoFactorEnabled=false,
    // silently disabling a user's working 2FA (and desyncing their authenticator
    // if they abandon setup) AND handing a hijacked session a code-free way to
    // strip 2FA, bypassing the deliberate code requirement on disable(). To
    // rotate, the user must disable() with a valid code first, then re-enroll.
    if (u.twoFactorEnabled) {
      throw new BadRequestException(
        'Two-factor authentication is already enabled. Disable it first to re-enroll.',
      );
    }
    const secret = generateTotpSecret();
    await this.prisma.marketingUser.update({
      where: { id: userId },
      // Store SEALED at rest (the seed mints valid OTPs). The otpauthUri the
      // user scans still carries the plaintext secret — that's by design.
      data: { twoFactorSecret: sealTotpSecret(secret), twoFactorEnabled: false },
    });
    const otpauthUri = totpUri(secret, u.email);
    // Render the QR HERE (the secret already lives on this server) and hand the
    // browser a self-contained data URI. Previously the client built the QR via
    // a third-party service (api.qrserver.com), which meant the otpauth URI —
    // and therefore the user's TOTP secret — was sent to an external party that
    // could log it and mint the user's codes. Keep it in-house.
    const qrDataUri = await QRCode.toDataURL(otpauthUri, { width: 192, margin: 1 });
    return { secret, otpauthUri, qrDataUri };
  }

  async enable(userId: string, code: string) {
    const u = await this.getUser(userId);
    if (!u.twoFactorSecret) throw new BadRequestException('Start enrollment first');
    if (!verifyTotp(openTotpSecret(u.twoFactorSecret), code)) {
      throw new BadRequestException('Invalid verification code');
    }
    const backupCodes = generateBackupCodes();
    await this.prisma.marketingUser.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: true,
        twoFactorBackupCodes: backupCodes.map(hashBackupCode) as Prisma.InputJsonValue,
      },
    });
    return { enabled: true, backupCodes };
  }

  /**
   * SMS factor enrollment step 1 / disable-reauth: send a fresh code to the
   * rep's phone via SmsOtpService (which resolves the workspace's NetGSM SMS
   * channel). Used both to start SMS enrollment (twoFactorEnabled=false) and
   * to obtain the fresh code `disable()` requires when the active factor is
   * already SMS — an authenticator app can mint a code offline at any
   * instant, but SMS has no equivalent, so the client calls this first.
   */
  async sendSmsCode(userId: string) {
    const u = await this.getUser(userId);
    if (u.twoFactorEnabled && u.twoFactorSecret) {
      throw new BadRequestException(
        'Disable your authenticator-app 2FA before switching to SMS.',
      );
    }
    if (!u.phone) {
      throw new BadRequestException('Add a phone number to your profile first.');
    }
    const result = await this.smsOtp.issue(u.workspaceId, smsFactorTarget(userId), u.phone);
    if (!result.ok) {
      throw new BadRequestException(result.message ?? 'Could not send the verification code.');
    }
    return { sent: true };
  }

  /**
   * SMS factor enrollment step 2: verify the code `sendSmsCode` texted, flip
   * `twoFactorEnabled`, issue backup codes. `twoFactorSecret` stays null —
   * its absence IS the "this account's active factor is SMS" marker (see the
   * class doc, `disable()`, and `status()`).
   */
  async enableSms(userId: string, code: string) {
    const u = await this.getUser(userId);
    // Same re-enroll guard as beginEnroll(): a code-free path back into an
    // already-armed factor must not exist.
    if (u.twoFactorEnabled) {
      throw new BadRequestException(
        'Two-factor authentication is already enabled. Disable it first to re-enroll.',
      );
    }
    const result = await this.smsOtp.verify(u.workspaceId, smsFactorTarget(userId), code);
    if (!result.ok) {
      throw new BadRequestException(result.message ?? 'Invalid verification code');
    }
    const backupCodes = generateBackupCodes();
    await this.prisma.marketingUser.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: true,
        twoFactorSecret: null,
        twoFactorBackupCodes: backupCodes.map(hashBackupCode) as Prisma.InputJsonValue,
      },
    });
    return { enabled: true, backupCodes };
  }

  /** Disables either factor. TOTP-armed accounts verify a TOTP code (as
   *  before); SMS-armed accounts verify a fresh code from `sendSmsCode`
   *  instead (there is no `twoFactorSecret` to check a TOTP code against). A
   *  single-use backup code works for either. */
  async disable(userId: string, code: string) {
    const u = await this.getUser(userId);
    if (!u.twoFactorEnabled) return { enabled: false };
    // Backup-code check first: it's a pure lookup (no side effects), unlike
    // smsOtp.verify() which mutates the pending code's attempt counter on a
    // miss. Checking it first means submitting a valid backup code never
    // burns an attempt against an unrelated pending SMS code.
    const hashes = (u.twoFactorBackupCodes as string[]) ?? [];
    const okBackup = hashes.includes(hashBackupCode(code));
    const okFactor =
      !okBackup &&
      (u.twoFactorSecret
        ? verifyTotp(openTotpSecret(u.twoFactorSecret), code)
        : (await this.smsOtp.verify(u.workspaceId, smsFactorTarget(userId), code)).ok);
    if (!okFactor && !okBackup) throw new BadRequestException('Invalid verification code');
    await this.prisma.marketingUser.update({
      where: { id: userId },
      data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: Prisma.DbNull },
    });
    return { enabled: false };
  }

  async status(userId: string) {
    const u = await this.getUser(userId);
    return {
      enabled: u.twoFactorEnabled,
      // Which factor is active — null when 2FA isn't enabled at all.
      method: u.twoFactorEnabled ? (u.twoFactorSecret ? 'TOTP' : 'SMS') : null,
    };
  }
}
