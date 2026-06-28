import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as QRCode from 'qrcode';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  openTotpSecret,
  sealTotpSecret,
  totpUri,
  verifyTotp,
} from '../util/totp';

/**
 * Epic F — 2FA/MFA (TOTP) management for marketing users. Enrollment stores a
 * secret; `enable` only flips the flag after a code verifies and then issues
 * single-use backup codes (shown once). Login enforcement lives in
 * MarketingAuthService (challenge → /auth/2fa/verify).
 */
@Injectable()
export class TwoFactorService {
  constructor(private prisma: PrismaService) {}

  private async getUser(userId: string) {
    const u = await this.prisma.marketingUser.findUnique({ where: { id: userId } });
    if (!u) throw new NotFoundException('User not found');
    return u;
  }

  async beginEnroll(userId: string) {
    const u = await this.getUser(userId);
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

  async disable(userId: string, code: string) {
    const u = await this.getUser(userId);
    if (!u.twoFactorEnabled) return { enabled: false };
    const okTotp = !!u.twoFactorSecret && verifyTotp(openTotpSecret(u.twoFactorSecret), code);
    const hashes = (u.twoFactorBackupCodes as string[]) ?? [];
    const okBackup = hashes.includes(hashBackupCode(code));
    if (!okTotp && !okBackup) throw new BadRequestException('Invalid verification code');
    await this.prisma.marketingUser.update({
      where: { id: userId },
      data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: Prisma.DbNull },
    });
    return { enabled: false };
  }

  async status(userId: string) {
    const u = await this.getUser(userId);
    return { enabled: u.twoFactorEnabled };
  }
}
