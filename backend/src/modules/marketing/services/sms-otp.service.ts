import { Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { SmsV2Client } from '../../netgsm/sms/sms-v2.client';
import { WhatsAppOtpClient } from '../../netgsm/whatsapp/whatsapp-otp.client';
import { hmacHex, isSecretBoxConfigured } from '../../../common/crypto/secret-box.helper';
import { normalizePhone } from '../utils/lead-normalize';

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
/** Review fix round 1 (Finding 5) — the 60s cooldown alone only bounds the
 *  RATE of re-issues, not the total; a patient attacker could still collect
 *  an unbounded number of codes/SMS sends over hours. Cap it per rolling
 *  hour too — generous for a legitimate user re-requesting a lost code,
 *  cheap to hit for an abuser (and each blocked attempt still costs NetGSM
 *  nothing, since the cap is checked before any send). */
const MAX_ISSUANCES_PER_WINDOW = 10;
const ISSUANCE_WINDOW_MS = 60 * 60_000;

/** ASCII-only template — SmsV2Client.otp rejects Turkish characters
 *  (çÇğĞıİöÖşŞüÜ), so this is deliberately "dogrulama", not "doğrulama". */
function renderOtpMessage(code: string): string {
  return `Jeeta dogrulama kodunuz: ${code}`;
}

/** Review fix round 1 (Finding 4) — HMAC-SHA256 keyed with
 *  MARKETING_SECRET_KEY instead of a plain unkeyed SHA-256: a 6-digit code
 *  has only ~20 bits of entropy, so an unkeyed hash is offline
 *  brute-forceable (all 1e6 candidates) in well under a second straight from
 *  a leaked `sms_otp_codes` row — the master key makes that infeasible
 *  without also compromising MARKETING_SECRET_KEY. The label prefix is
 *  domain separation (mirrors the netgsm callback/webhook HMAC helpers),
 *  so this hash can never collide with an HMAC computed for an unrelated
 *  purpose under the same master key. */
function hashCode(code: string): string {
  return hmacHex(`sms-otp-code:${code}`);
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

/** Review fix round 1 (Finding 3, issue-side) — internal control-flow signals
 *  thrown inside issue()'s transaction and caught immediately outside it;
 *  never escape this file. */
class SmsOtpCooldownActiveError extends Error {}
class SmsOtpRateLimitedError extends Error {}

/**
 * NetGSM SMS v2 Task 12 — SMS one-time-code issue/verify, shared by the 2FA
 * "SMS" factor (enroll + login challenge) and lead phone verification.
 * Codes are HMAC-SHA256 hashed at rest (never the raw code), a 3-minute TTL
 * and a 5-attempt brute-force cap (mirrors MarketingAuthService's
 * failedLogins counter), atomically enforced. Sends via the workspace's
 * ACTIVE NetGSM SMS channel (the same credentials + msgheader regular SMS
 * campaigns use) through the hub's SmsV2Client.otp — a paid,
 * single-recipient, single-segment, domestic-mobile-only NetGSM surface
 * (error 60 without the OTP package).
 *
 * NetGSM Phase 6 Task 3 — WhatsApp OTP is an ALTERNATE DELIVERY TRANSPORT,
 * nothing more: the code generation/hash/verify/attempt-cap/phone-bind
 * security from Phase 1 (above) is completely unchanged, and verify() is
 * untouched — the code is the code, regardless of which channel carried it.
 * A workspace opts in by setting configPublic.otpTransport: 'WHATSAPP' on its
 * SMS channel (default/anything else = plain SMS, unchanged behavior). When
 * opted in, issue() tries WhatsAppOtpClient.sendVerifyCode FIRST (same NetGSM
 * account creds as the SMS channel — one shared usercode across
 * SMS/İYS/voice/fax/balance/OTP, per the hub design) and falls back to the
 * existing SmsV2Client.otp SMS path on ANY WhatsApp failure — a real send
 * error, the paid OTP-WhatsApp package being absent/unapproved, or a
 * transport fault — so a code is never silently undelivered.
 */
@Injectable()
export class SmsOtpService {
  private readonly logger = new Logger(SmsOtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channelRegistry: ChannelAdapterRegistry,
    private readonly smsV2: SmsV2Client,
    private readonly whatsappOtp: WhatsAppOtpClient,
  ) {}

  /** Resolves the workspace's ACTIVE NetGSM SMS channel into the creds +
   *  msgheader an OTP send needs — the exact same source regular SMS sends
   *  read (NetgsmSmsAdapter), so an OTP fails only when SMS itself would.
   *  Also reads the same channel's configPublic.otpTransport preference
   *  (Phase 6 Task 3) — WhatsApp OTP rides the SAME channel row/credentials,
   *  never a separate config store. */
  private async resolveSendConfig(
    workspaceId: string,
  ): Promise<{ usercode: string; password: string; msgheader: string; preferWhatsApp: boolean } | null> {
    const channel = await this.prisma.channel.findFirst({
      where: { workspaceId, type: 'SMS', status: 'ACTIVE' },
    });
    if (!channel) return null;
    const resolved = this.channelRegistry.resolveConfig(channel);
    const { usercode, password, msgheader } = resolved.secrets;
    if (!usercode || !password || !msgheader) return null;
    const pub = resolved.public as Record<string, unknown> | undefined;
    const preferWhatsApp = pub?.otpTransport === 'WHATSAPP';
    return { usercode, password, msgheader, preferWhatsApp };
  }

  /**
   * Deliver a freshly-minted code over the workspace's preferred transport.
   * WhatsApp (when preferred) is tried FIRST; ANY non-ok result — a real
   * NetGSM error, the paid OTP-WhatsApp package missing, or a transport
   * fault — falls back to the existing SMS delivery. The default (preference
   * absent or any value other than 'WHATSAPP') skips WhatsApp entirely and
   * behaves EXACTLY like Phase 1: a single SmsV2Client.otp call. Never
   * throws; the caller (issue()) decides what to do with a total failure
   * (delete the just-persisted row).
   */
  private async deliverCode(
    config: { usercode: string; password: string; msgheader: string; preferWhatsApp: boolean },
    phone: string,
    code: string,
  ): Promise<{ ok: boolean; code?: string; message?: string; via: 'SMS' | 'WHATSAPP' }> {
    if (config.preferWhatsApp) {
      const waResult = await this.whatsappOtp.sendVerifyCode(
        { usercode: config.usercode, password: config.password },
        { to: phone, code },
      );
      if (waResult.ok) {
        return { ok: true, via: 'WHATSAPP' };
      }
      this.logger.warn(
        `sms-otp whatsapp transport failed — falling back to SMS (code=${waResult.code || '?'})`,
      );
    }
    const smsResult = await this.smsV2.otp(
      { usercode: config.usercode, password: config.password },
      { msgheader: config.msgheader, msg: renderOtpMessage(code), no: phone },
    );
    return { ok: smsResult.ok, code: smsResult.code, message: smsResult.message ?? undefined, via: 'SMS' };
  }

  /**
   * Issue a fresh code to `phone` and text it via NetGSM OTP. Invalidates any
   * still-pending code for the same (workspace, purpose, targetType,
   * targetId) — only the newest code a target was issued can ever verify.
   * Refuses (without touching NetGSM) inside the resend cooldown or the
   * rolling-hour issuance cap so a target can't be bombarded, and when the
   * workspace has no usable SMS channel.
   *
   * Review fix round 1 (Finding 3, lower priority): the cooldown/cap
   * check-then-act used to be a plain read-then-write — two concurrent
   * issue() calls for the same target could both read "clear" and both
   * mint+send. The check + consume-prior + create now run inside a
   * SERIALIZABLE transaction, so Postgres detects the overlapping read/write
   * and aborts the loser (caught below as a P2034 conflict) instead of
   * letting both through.
   */
  async issue(
    workspaceId: string,
    target: SmsOtpTarget,
    phone: string,
  ): Promise<SmsOtpIssueResult> {
    if (!phone || !phone.trim()) {
      return { ok: false, message: 'No phone number on file to verify.' };
    }
    // hashCode() below is a hard dependency on the master key (Finding 4) —
    // check it explicitly so a misconfigured environment gets the same clean
    // "not configured" refusal every other MARKETING_SECRET_KEY-dependent
    // service in this codebase returns, not an uncaught 500. Production boot
    // already refuses to start without this key (see main.ts), so this is a
    // dev/staging safety net, not a live prod concern.
    if (!isSecretBoxConfigured()) {
      return { ok: false, message: 'Secret storage is not configured (MARKETING_SECRET_KEY) — cannot issue a code.' };
    }

    const config = await this.resolveSendConfig(workspaceId);
    if (!config) {
      return {
        ok: false,
        message: 'No active NetGSM SMS channel is configured for this workspace.',
      };
    }

    const code = generateCode();
    const now = new Date();

    let row: { id: string };
    try {
      row = await this.prisma.$transaction(
        async (tx) => {
          const windowStart = new Date(now.getTime() - ISSUANCE_WINDOW_MS);
          const [last, recentCount] = await Promise.all([
            tx.smsOtpCode.findFirst({
              where: { workspaceId, ...target },
              orderBy: { createdAt: 'desc' },
            }),
            tx.smsOtpCode.count({
              where: { workspaceId, ...target, createdAt: { gte: windowStart } },
            }),
          ]);
          if (last && now.getTime() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
            throw new SmsOtpCooldownActiveError();
          }
          if (recentCount >= MAX_ISSUANCES_PER_WINDOW) {
            throw new SmsOtpRateLimitedError();
          }

          // Only the newest code may ever verify — consume every still-pending
          // row for this exact target BEFORE minting the new one.
          await tx.smsOtpCode.updateMany({
            where: { workspaceId, ...target, consumedAt: null },
            data: { consumedAt: now },
          });

          return tx.smsOtpCode.create({
            data: {
              workspaceId,
              ...target,
              phone,
              codeHash: hashCode(code),
              maxAttempts: MAX_ATTEMPTS,
              expiresAt: new Date(now.getTime() + CODE_TTL_MS),
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (e) {
      if (e instanceof SmsOtpCooldownActiveError) {
        return {
          ok: false,
          message: 'A code was just sent — wait a moment before requesting another.',
        };
      }
      if (e instanceof SmsOtpRateLimitedError) {
        return {
          ok: false,
          message: 'Too many verification codes requested — try again later.',
        };
      }
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') {
        // Lost the serialization race against a concurrent issue() for the
        // same target — fail exactly like an active cooldown (safe default;
        // whichever request won already sent a code).
        return {
          ok: false,
          message: 'A code was just sent — wait a moment before requesting another.',
        };
      }
      throw e;
    }

    const delivery = await this.deliverCode(config, phone, code);

    if (!delivery.ok) {
      // Neither transport got the code out (or NetGSM rejected both) — don't
      // leave a code on file the target could never have received.
      await this.prisma.smsOtpCode.delete({ where: { id: row.id } }).catch(() => undefined);
      this.logger.warn(
        `sms-otp issue failed ws=${workspaceId} ${target.purpose}/${target.targetType}/${target.targetId} phone=${maskPhone(phone)} code=${delivery.code || '?'}`,
      );
      return { ok: false, code: delivery.code || undefined, message: delivery.message ?? 'NetGSM could not send the code.' };
    }

    this.logger.log(
      `sms-otp issued via ${delivery.via} ws=${workspaceId} ${target.purpose}/${target.targetType}/${target.targetId} phone=${maskPhone(phone)}`,
    );
    return { ok: true };
  }

  /**
   * Verify a code against the newest still-pending row for this target.
   * `phone` must equal the phone the code was actually issued to (review fix
   * round 1, Finding 2) — without this, verify() only scoped by (workspace,
   * purpose, targetType, targetId), so a code texted to number A could
   * confirm a claim about number B if the target's phone changed between
   * issue and confirm (e.g. a lead's number swapped mid-flow: start on A,
   * edit the lead to B, confirm the code sent to A against B). Callers must
   * pass the target's CURRENT phone; a mismatch fails exactly like "no
   * pending code" so the response can't be used to fingerprint whether a
   * code exists for some other number.
   *
   * One-time-use (consumed on success); refuses past `maxAttempts` wrong
   * tries. Review fix round 1 (Finding 3): every mutation below is now a
   * conditional `updateMany` keyed off the exact snapshot this call read,
   * closing a race where the original findFirst→compute→update let
   * concurrent verify() calls share a stale `attempts` value and jointly
   * burn more than `maxAttempts` real guesses.
   */
  async verify(
    workspaceId: string,
    target: SmsOtpTarget,
    code: string,
    phone: string | null,
  ): Promise<SmsOtpVerifyResult> {
    if (!isSecretBoxConfigured()) {
      return { ok: false, message: 'Secret storage is not configured (MARKETING_SECRET_KEY).' };
    }

    const row = await this.prisma.smsOtpCode.findFirst({
      where: { workspaceId, ...target, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      return { ok: false, message: 'No pending code — request a new one.' };
    }

    if (normalizePhone(row.phone) !== normalizePhone(phone)) {
      return { ok: false, message: 'No pending code — request a new one.' };
    }

    if (row.expiresAt.getTime() < Date.now()) {
      await this.prisma.smsOtpCode.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      return { ok: false, message: 'Code expired — request a new one.' };
    }
    if (row.attempts >= row.maxAttempts) {
      await this.prisma.smsOtpCode.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      return { ok: false, message: 'Too many attempts — request a new code.' };
    }

    const matches = hashCode((code ?? '').trim()) === row.codeHash;
    if (!matches) {
      const attempts = row.attempts + 1;
      // Optimistic lock on the READ snapshot's `attempts`: only matches (and
      // only mutates) if attempts is STILL what we just read. A concurrent
      // guess that wrote first flips it out from under us, so our own write
      // matches 0 rows — we fail closed (a plain miss) instead of
      // double-counting or granting a bonus guess beyond maxAttempts.
      // The updateMany's match count is intentionally not branched on here:
      // whether it wins (1) or loses (0) the race, THIS call's guess was
      // wrong either way, so the response is the same — the predicate is
      // what closes the race (see verify()'s class doc), not this return.
      await this.prisma.smsOtpCode.updateMany({
        where: { id: row.id, attempts: row.attempts, consumedAt: null },
        data: {
          attempts,
          // The attempt that trips the cap invalidates the row immediately —
          // no extra guess can slip in between hitting the cap and the next call.
          ...(attempts >= row.maxAttempts ? { consumedAt: new Date() } : {}),
        },
      });
      return { ok: false, message: 'Invalid code.' };
    }

    const consumed = await this.prisma.smsOtpCode.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) {
      // Someone else (a concurrent guess that tripped the cap, or another
      // verify racing on the same row) already invalidated it between our
      // read and this write — don't honor a stale success.
      return { ok: false, message: 'Code expired — request a new one.' };
    }

    this.logger.log(
      `sms-otp verified ws=${workspaceId} ${target.purpose}/${target.targetType}/${target.targetId}`,
    );
    return { ok: true };
  }
}
