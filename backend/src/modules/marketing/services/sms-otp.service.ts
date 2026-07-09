import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { SmsV2Client } from '../../netgsm/sms/sms-v2.client';

export type SmsOtpPurpose = 'TWO_FACTOR' | 'LEAD_PHONE_VERIFY';
export type SmsOtpTargetType = 'USER' | 'LEAD';

export interface SmsOtpTarget {
  purpose: SmsOtpPurpose;
  targetType: SmsOtpTargetType;
  targetId: string;
}

export interface SmsOtpIssueResult {
  ok: boolean;
  /** NetGSM provider code when the send itself failed (e.g. '60' = paid OTP
   *  package missing) — lets callers special-case it (settings card hint). */
  code?: string;
  message?: string;
}

export interface SmsOtpVerifyResult {
  ok: boolean;
  message?: string;
}

/** 6-digit code, 3-minute TTL, max 5 verify attempts (brief-pinned). */
const CODE_TTL_MS = 3 * 60_000;
const MAX_ATTEMPTS = 5;
/** Per-target resend cooldown — mirrors the brute-force-lock idiom in
 *  MarketingAuthService (a counted window before another action is allowed)
 *  applied to the ISSUE side instead of the verify side: a target can't be
 *  bombarded with fresh codes faster than one per minute. */
const RESEND_COOLDOWN_MS = 60_000;

/** ASCII-only template — SmsV2Client.otp rejects Turkish characters
 *  (çÇğĞıİöÖşŞüÜ), so this is deliberately "dogrulama", not "doğrulama". */
function renderOtpMessage(code: string): string {
  return `Jeeta dogrulama kodunuz: ${code}`;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Zero-pads to exactly 6 digits without leading-zero bias (uniform over 0..999999). */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Last-4-masked, for logs — never the full number, never the code. */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length > 4 ? `***${digits.slice(-4)}` : '***';
}

/**
 * NetGSM SMS v2 Task 12 — SMS one-time-code issue/verify, shared by the 2FA
 * "SMS" factor (enroll + login challenge) and lead phone verification.
 * Codes are SHA-256 hashed at rest (mirrors ApiKeysService's "never store the
 * raw secret" convention) with a 3-minute TTL and a 5-attempt brute-force cap
 * (mirrors MarketingAuthService's failedLogins counter). Sends via the
 * workspace's ACTIVE NetGSM SMS channel (the same credentials + msgheader
 * regular SMS campaigns use) through the hub's SmsV2Client.otp — a paid,
 * single-recipient, single-segment, domestic-mobile-only NetGSM surface
 * (error 60 without the OTP package).
 */
@Injectable()
export class SmsOtpService {
  private readonly logger = new Logger(SmsOtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channelRegistry: ChannelAdapterRegistry,
    private readonly smsV2: SmsV2Client,
  ) {}

  /** Resolves the workspace's ACTIVE NetGSM SMS channel into the creds +
   *  msgheader an OTP send needs — the exact same source regular SMS sends
   *  read (NetgsmSmsAdapter), so an OTP fails only when SMS itself would. */
  private async resolveSendConfig(
    workspaceId: string,
  ): Promise<{ usercode: string; password: string; msgheader: string } | null> {
    const channel = await this.prisma.channel.findFirst({
      where: { workspaceId, type: 'SMS', status: 'ACTIVE' },
    });
    if (!channel) return null;
    const resolved = this.channelRegistry.resolveConfig(channel);
    const { usercode, password, msgheader } = resolved.secrets;
    if (!usercode || !password || !msgheader) return null;
    return { usercode, password, msgheader };
  }

  /**
   * Issue a fresh code to `phone` and text it via NetGSM OTP. Invalidates any
   * still-pending code for the same (workspace, purpose, targetType,
   * targetId) — only the newest code a target was issued can ever verify.
   * Refuses (without touching NetGSM) inside the resend cooldown so a target
   * can't be bombarded, and when the workspace has no usable SMS channel.
   */
  async issue(
    workspaceId: string,
    target: SmsOtpTarget,
    phone: string,
  ): Promise<SmsOtpIssueResult> {
    if (!phone || !phone.trim()) {
      return { ok: false, message: 'No phone number on file to verify.' };
    }

    const config = await this.resolveSendConfig(workspaceId);
    if (!config) {
      return {
        ok: false,
        message: 'No active NetGSM SMS channel is configured for this workspace.',
      };
    }

    const last = await this.prisma.smsOtpCode.findFirst({
      where: { workspaceId, ...target },
      orderBy: { createdAt: 'desc' },
    });
    if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      return {
        ok: false,
        message: 'A code was just sent — wait a moment before requesting another.',
      };
    }

    const code = generateCode();
    const now = new Date();

    // Only the newest code may ever verify — consume every still-pending row
    // for this exact target BEFORE minting the new one.
    await this.prisma.smsOtpCode.updateMany({
      where: { workspaceId, ...target, consumedAt: null },
      data: { consumedAt: now },
    });

    const row = await this.prisma.smsOtpCode.create({
      data: {
        workspaceId,
        ...target,
        phone,
        codeHash: hashCode(code),
        maxAttempts: MAX_ATTEMPTS,
        expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      },
    });

    const result = await this.smsV2.otp(
      { usercode: config.usercode, password: config.password },
      { msgheader: config.msgheader, msg: renderOtpMessage(code), no: phone },
    );

    if (!result.ok) {
      // The send never went out (or NetGSM rejected it) — don't leave a code
      // on file the target could never have received.
      await this.prisma.smsOtpCode.delete({ where: { id: row.id } }).catch(() => undefined);
      this.logger.warn(
        `sms-otp issue failed ws=${workspaceId} ${target.purpose}/${target.targetType}/${target.targetId} phone=${maskPhone(phone)} code=${result.code || '?'}`,
      );
      return { ok: false, code: result.code || undefined, message: result.message ?? 'NetGSM could not send the code.' };
    }

    this.logger.log(
      `sms-otp issued ws=${workspaceId} ${target.purpose}/${target.targetType}/${target.targetId} phone=${maskPhone(phone)}`,
    );
    return { ok: true };
  }

  /**
   * Verify a code against the newest still-pending row for this target.
   * One-time-use (consumed on success); refuses past `maxAttempts` wrong
   * tries (the row is invalidated on the attempt that trips the cap, so a
   * subsequent correct guess still can't sneak through).
   */
  async verify(
    workspaceId: string,
    target: SmsOtpTarget,
    code: string,
  ): Promise<SmsOtpVerifyResult> {
    const row = await this.prisma.smsOtpCode.findFirst({
      where: { workspaceId, ...target, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      return { ok: false, message: 'No pending code — request a new one.' };
    }
    if (row.expiresAt.getTime() < Date.now()) {
      await this.prisma.smsOtpCode.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      });
      return { ok: false, message: 'Code expired — request a new one.' };
    }
    if (row.attempts >= row.maxAttempts) {
      await this.prisma.smsOtpCode.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      });
      return { ok: false, message: 'Too many attempts — request a new code.' };
    }

    const matches = hashCode((code ?? '').trim()) === row.codeHash;
    if (!matches) {
      const attempts = row.attempts + 1;
      await this.prisma.smsOtpCode.update({
        where: { id: row.id },
        data: {
          attempts,
          // The attempt that trips the cap invalidates the row immediately —
          // no extra guess can slip in between hitting the cap and the next call.
          ...(attempts >= row.maxAttempts ? { consumedAt: new Date() } : {}),
        },
      });
      return { ok: false, message: 'Invalid code.' };
    }

    await this.prisma.smsOtpCode.update({
      where: { id: row.id },
      data: { consumedAt: new Date() },
    });
    this.logger.log(
      `sms-otp verified ws=${workspaceId} ${target.purpose}/${target.targetType}/${target.targetId}`,
    );
    return { ok: true };
  }
}
