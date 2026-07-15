import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MarketingLoginDto } from '../dto';
import { RegisterWorkspaceDto } from '../dto/register-workspace.dto';
import { DEFAULT_BUSINESS_TYPES } from '../dto/create-lead.dto';
import { DEFAULT_ACTIVATED_MODULES } from '../../billing/entitlements.service';
import { hashBackupCode, openTotpSecret, verifyTotpStep } from '../util/totp';
import { SmsOtpService } from './sms-otp.service';
import { MembershipService } from './membership.service';

const MAX_FAILED_LOGINS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

// Constant-time login: an unknown email must cost roughly one bcrypt compare,
// same as a wrong password, so response timing can't be used to enumerate
// which emails exist. Computed once at module load (a real hash, not a literal,
// so the compare exercises the genuine cost factor) — never used as a credential.
const DUMMY_BCRYPT_HASH = bcrypt.hashSync('not-a-real-password', 12);

/** Subdomain-safe slug from a workspace name ("Acme Görmez A.Ş." → "acme-gormez-a-s"). */
function slugify(name: string): string {
  const turkishMap: Record<string, string> = {
    ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u',
  };
  const base = name
    .toLowerCase()
    .replace(/[çğıöşü]/g, (ch) => turkishMap[ch] ?? ch)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'workspace';
}

@Injectable()
export class MarketingAuthService {
  private readonly logger = new Logger(MarketingAuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private smsOtp: SmsOtpService,
    private membership: MembershipService,
  ) {}

  private bcryptCost(): number {
    const raw = this.configService.get<string>('BCRYPT_COST');
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 10 && parsed <= 15 ? parsed : 12;
  }

  private accessSecret(): string {
    const secret = this.configService.get<string>('MARKETING_JWT_SECRET');
    if (!secret) throw new Error('MARKETING_JWT_SECRET is not configured');
    return secret;
  }

  private refreshSecret(): string {
    // No `|| accessSecret()` fallback: refresh must live in a distinct
    // realm, otherwise a stolen access token could be replayed as a
    // refresh and vice versa.
    const secret = this.configService.get<string>('MARKETING_JWT_REFRESH_SECRET');
    if (!secret) throw new Error('MARKETING_JWT_REFRESH_SECRET is not configured');
    return secret;
  }

  async login(dto: MarketingLoginDto, ip?: string) {
    const user = await this.prisma.marketingUser.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      // Burn ~one bcrypt compare so a missing email costs the same as a wrong
      // password — closes the timing side-channel that would otherwise let an
      // attacker enumerate registered emails.
      await bcrypt.compare(dto.password, DUMMY_BCRYPT_HASH);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is inactive');
    }

    // The research sentinel owns rows, never sessions.
    if (user.role === 'SYSTEM') {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('Account is temporarily locked');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);

    if (!isPasswordValid) {
      // Compute the new count locally so the lock fires on the *new*
      // value crossing the threshold, not on the already-stored value.
      const nextCount = user.failedLogins + 1;
      const locking = nextCount >= MAX_FAILED_LOGINS;
      await this.prisma.marketingUser.update({
        where: { id: user.id },
        data: {
          // When we lock, reset the counter so the lock expiry returns
          // the user to a clean slate — the prior code left
          // failedLogins=5 forever, re-locking on every future typo.
          failedLogins: locking ? 0 : nextCount,
          lockedUntil: locking ? new Date(Date.now() + LOCK_DURATION_MS) : null,
        },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.marketingUser.update({
      where: { id: user.id },
      data: {
        failedLogins: 0,
        lockedUntil: null,
        lastLogin: new Date(),
        lastLoginIp: ip,
      },
    });

    // Epic F — 2FA enforcement. Password verified; if 2FA is on, withhold the
    // session and issue a short-lived challenge the client completes at
    // /auth/2fa/verify. Users without 2FA are unaffected.
    if (user.twoFactorEnabled) {
      const challengeToken = this.jwtService.sign(
        { sub: user.id, type: 'marketing', tokenType: '2fa-challenge' },
        { secret: this.accessSecret(), expiresIn: '5m', algorithm: 'HS256' },
      );
      // NetGSM SMS v2 Task 12 — the SMS factor (twoFactorSecret null) has no
      // authenticator app to generate a code offline; the server must push
      // one at challenge time. Best-effort: an SMS/NetGSM outage must not
      // 500 the login endpoint — the user can retry via /auth/2fa/resend,
      // and the challenge itself stays valid either way.
      if (!user.twoFactorSecret && user.phone) {
        try {
          await this.smsOtp.issue(
            user.workspaceId,
            { purpose: 'TWO_FACTOR', targetType: 'USER', targetId: user.id },
            user.phone,
          );
        } catch (e: any) {
          this.logger.warn(`2fa sms challenge send failed: ${e?.message ?? e}`);
        }
      }
      return { twoFactorRequired: true, challengeToken };
    }

    return this.issueForDefaultWorkspace(user);
  }

  /** NetGSM SMS v2 Task 12 — re-send the SMS challenge code for a pending 2FA
   *  login (e.g. the first text was lost/delayed). No-op-safe for a TOTP-armed
   *  account: there is nothing to resend, so it just re-validates the
   *  challenge and returns without contacting NetGSM.
   *
   *  Review fix round 1 (Finding 6): the response used to differ by factor —
   *  `{sent:false}` for TOTP, `{sent:true}`/a thrown exception for SMS (no
   *  phone on file, or a NetGSM failure). A caller who already cleared the
   *  password step (this endpoint only needs a valid challengeToken) could
   *  use that difference to fingerprint which 2FA factor the account uses.
   *  The response is now uniformly `{sent:true}` regardless of factor or
   *  delivery outcome — the SMS send itself stays best-effort (mirrors
   *  login()'s NetGSM-outage handling: the client can't retry any harder
   *  than calling this endpoint again either way). */
  async resendTwoFactorSms(challengeToken: string) {
    const user = await this.loadChallengeUser(challengeToken);
    if (!user.twoFactorSecret && user.phone) {
      try {
        await this.smsOtp.issue(
          user.workspaceId,
          { purpose: 'TWO_FACTOR', targetType: 'USER', targetId: user.id },
          user.phone,
        );
      } catch (e: any) {
        this.logger.warn(`2fa sms resend failed: ${e?.message ?? e}`);
      }
    }
    return { sent: true };
  }

  /** Epic F — complete a 2FA login: verify a TOTP code, a fresh SMS code, or a
   *  single-use backup code. */
  async verify2fa(challengeToken: string, code: string) {
    const user = await this.loadChallengeUser(challengeToken);

    // Backup-code check first: a pure lookup, unlike smsOtp.verify() which
    // mutates the pending code's attempt counter on a miss — so completing
    // login with a backup code never burns an attempt on an unrelated
    // in-flight SMS challenge.
    const hashes = (user.twoFactorBackupCodes as string[]) ?? [];
    const h = hashBackupCode(code);
    let ok = false;
    if (hashes.includes(h)) {
      // ATOMICALLY consume the backup code so a concurrent second use of the
      // SAME code can't also succeed (single-use). `jsonb - text` drops the
      // element, and jsonb_exists() in the WHERE means only the request that
      // still finds the code present wins — a racing duplicate matches 0 rows.
      // (The read-then-filter-then-write it replaced let two concurrent logins
      // both keep the code and both succeed.) jsonb_exists(), not the `?`
      // operator, to sidestep Prisma's placeholder-vs-operator clash.
      const claim = await this.prisma.$executeRaw`
        UPDATE "marketing_users"
           SET "twoFactorBackupCodes" = "twoFactorBackupCodes" - ${h}
         WHERE "id" = ${user.id} AND "workspaceId" = ${user.workspaceId}
           AND jsonb_exists("twoFactorBackupCodes", ${h})`;
      ok = claim === 1;
    } else if (user.twoFactorSecret) {
      // TOTP + RFC 6238 §5.2 replay guard: verify the code, then ATOMICALLY
      // claim its 30s time-step — the conditional updateMany advances
      // twoFactorLastStep only if this step is strictly newer than the one last
      // consumed at login. A replay of the SAME code (even two concurrent
      // requests) matches 0 rows the second time, so a captured code can't be
      // reused within its ~90s validity window.
      const step = verifyTotpStep(openTotpSecret(user.twoFactorSecret), code);
      if (step >= 0) {
        const claim = await this.prisma.marketingUser.updateMany({
          where: {
            id: user.id,
            workspaceId: user.workspaceId,
            OR: [{ twoFactorLastStep: null }, { twoFactorLastStep: { lt: step } }],
          },
          data: { twoFactorLastStep: step },
        });
        ok = claim.count === 1;
      }
    } else {
      ok = (
        await this.smsOtp.verify(
          user.workspaceId,
          { purpose: 'TWO_FACTOR', targetType: 'USER', targetId: user.id },
          code,
          user.phone,
        )
      ).ok;
    }
    if (!ok) throw new UnauthorizedException('Invalid 2FA code');
    return this.issueForDefaultWorkspace(user);
  }

  /** Decodes + validates a 2FA challenge token down to its live, 2FA-armed user. */
  private async loadChallengeUser(challengeToken: string) {
    let payload: { sub?: string; type?: string; tokenType?: string };
    try {
      payload = await this.jwtService.verifyAsync(challengeToken, {
        secret: this.accessSecret(),
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired 2FA challenge');
    }
    if (payload.type !== 'marketing' || payload.tokenType !== '2fa-challenge') {
      throw new UnauthorizedException('Invalid 2FA challenge');
    }
    const user = await this.prisma.marketingUser.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== 'ACTIVE' || !user.twoFactorEnabled) {
      throw new UnauthorizedException('Invalid 2FA challenge');
    }
    return user;
  }

  async refreshToken(token: string) {
    let payload: any;
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: this.refreshSecret(),
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.type !== 'marketing') {
      throw new UnauthorizedException('Invalid token type');
    }
    if (payload.tokenType !== 'refresh') {
      throw new UnauthorizedException('Invalid token: not a refresh token');
    }

    const user = await this.prisma.marketingUser.findUnique({
      where: { id: payload.sub },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('User not found or inactive');
    }
    if (user.role === 'SYSTEM') {
      throw new UnauthorizedException('Session revoked');
    }
    if (typeof payload.ver === 'number' && payload.ver !== user.tokenVersion) {
      throw new UnauthorizedException('Session revoked');
    }

    await this.assertWorkspaceActive(user.workspaceId);

    // Rotate: issue a fresh pair (not just a new access token) so the
    // old refresh ages out even if the client keeps presenting it.
    // TODO(Task 6): preserve the token's active workspace instead of resetting to home
    return this.generateTokens(user, { workspaceId: user.workspaceId, role: user.role });
  }

  /**
   * Multi-workspace membership Phase 1 Task 5 — a user row no longer IS a
   * workspace; it HOLDS memberships. Login must land on the ACTIVE membership
   * MembershipService resolves as "default" (the home pointer if still ACTIVE,
   * else the most-recently-created ACTIVE membership), not blindly on the home
   * `workspaceId` column, which may have been suspended, removed, or never
   * updated after the user's actual default moved elsewhere.
   */
  private async issueForDefaultWorkspace(user: {
    id: string;
    workspaceId: string;
    role: string;
    tokenVersion: number;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    avatar: string | null;
  }) {
    const activeWorkspaceId = await this.membership.resolveDefaultWorkspaceId(
      user.id,
      user.workspaceId,
    );
    if (!activeWorkspaceId) throw new UnauthorizedException('No active workspace');
    const m = await this.membership.getActiveMembership(user.id, activeWorkspaceId);
    if (!m) throw new UnauthorizedException('No active workspace');
    await this.assertWorkspaceActive(activeWorkspaceId);
    // keep the home pointer in sync so next login lands here
    if (user.workspaceId !== activeWorkspaceId) {
      await this.prisma.marketingUser.update({
        where: { id: user.id },
        data: { workspaceId: activeWorkspaceId },
      });
    }
    return this.generateTokens(user, { workspaceId: activeWorkspaceId, role: m.role });
  }

  /** SUSPENDED/CLOSED workspaces stop minting sessions at the door. In-flight
   * access tokens age out within their 8h TTL; feature/quota enforcement
   * (Phase F entitlements) covers the gap. */
  private async assertWorkspaceActive(workspaceId: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { status: true },
    });
    if (!workspace || workspace.status !== 'ACTIVE') {
      throw new UnauthorizedException('Workspace is not active');
    }
  }

  async logout(userId: string) {
    // Bump tokenVersion → existing access/refresh tokens become stale
    // the next time the guard or refresh endpoint reads this row.
    await this.prisma.marketingUser.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    return { message: 'Logged out' };
  }

  /**
   * Public token-issue seam for federated logins (SSO/OIDC). The IdP-side
   * identity check happens in {@link SsoService}; once a MarketingUser is
   * matched/provisioned, this mints the SAME marketing session pair the
   * password path does — there is exactly one place that knows how to sign a
   * marketing JWT, and SSO reuses it rather than re-deriving the payload.
   */
  issueSession(
    user: {
      id: string;
      workspaceId: string;
      email: string;
      firstName: string;
      lastName: string;
      phone: string | null;
      avatar: string | null;
      role: string;
      tokenVersion: number;
    },
    active: { workspaceId: string; role: string },
  ) {
    return this.generateTokens(user, active);
  }

  private generateTokens(
    user: {
      id: string;
      workspaceId: string;
      email: string;
      firstName: string;
      lastName: string;
      phone: string | null;
      avatar: string | null;
      role: string;
      tokenVersion: number;
    },
    active: { workspaceId: string; role: string },
  ) {
    const basePayload = {
      sub: user.id,
      email: user.email,
      role: active.role, // active membership's role, not the user row's home role
      wsp: active.workspaceId, // active membership's workspace, not the user row's home workspace
      ver: user.tokenVersion,
      type: 'marketing' as const,
    };

    const accessToken = this.jwtService.sign(basePayload, {
      secret: this.accessSecret(),
      expiresIn: '8h',
      algorithm: 'HS256',
    });

    const refreshToken = this.jwtService.sign(
      { ...basePayload, tokenType: 'refresh' },
      {
        secret: this.refreshSecret(),
        expiresIn: '7d',
        algorithm: 'HS256',
      },
    );

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        workspaceId: active.workspaceId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: active.role,
        phone: user.phone,
        avatar: user.avatar,
      },
    };
  }

  /**
   * Public self-serve signup: provisions a whole workspace in one tx —
   * the org row (with default taxonomy), its OWNER account, the per-workspace
   * SYSTEM research sentinel and a DISABLED distribution config. Later
   * phases hang the trial subscription (F) and a draft research profile (E)
   * off the same flow. Returns a logged-in token pair for the owner.
   */
  async registerWorkspace(dto: RegisterWorkspaceDto, ip?: string) {
    const existing = await this.prisma.marketingUser.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('Email is already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, this.bcryptCost());

    let owner;
    try {
      owner = await this.provisionWorkspace(dto, passwordHash);
    } catch (e) {
      // The email pre-check above closes the SEQUENTIAL duplicate case, but two
      // simultaneous signups both pass it and race on INSERT — the unique index
      // is the real arbiter. Surface the loser's P2002 as a clean 409 (matching
      // the pre-check's message) instead of leaking a raw 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const target = String((e.meta as { target?: unknown } | undefined)?.target ?? '');
        if (target.includes('email')) throw new ConflictException('Email is already registered');
        if (target.includes('slug')) {
          throw new ConflictException('That workspace name was just taken — try another');
        }
        throw new ConflictException('That account was just created — please sign in');
      }
      throw e;
    }

    await this.prisma.marketingUser.update({
      where: { id: owner.id },
      data: { lastLogin: new Date(), lastLoginIp: ip },
    });

    return this.generateTokens(owner, { workspaceId: owner.workspaceId, role: 'OWNER' });
  }

  private async provisionWorkspace(dto: RegisterWorkspaceDto, passwordHash: string) {
    return this.prisma.$transaction(async (tx) => {
      // Deterministic-but-collision-safe slug: try the plain slug, then
      // suffix -2, -3... (bounded; the unique index is the final arbiter).
      const base = slugify(dto.workspaceName);
      let slug = base;
      for (let i = 2; ; i++) {
        const taken = await tx.workspace.findUnique({
          where: { slug },
          select: { id: true },
        });
        if (!taken) break;
        if (i > 50) throw new ConflictException('Could not allocate a workspace slug');
        slug = `${base}-${i}`;
      }

      const workspace = await tx.workspace.create({
        data: {
          slug,
          name: dto.workspaceName,
          productName: dto.productName,
          productUrl: dto.productUrl ?? null,
          productDescription: dto.productDescription ?? null,
          defaultLanguage: dto.language ?? 'en',
          // Default to TRY: PayTR (the only PSP live in prod) is TRY-only, so a
          // USD-defaulted workspace can neither top-up its wallet nor subscribe.
          defaultCurrency: dto.currency ?? 'TRY',
          settings: { businessTypes: [...DEFAULT_BUSINESS_TYPES] },
          // Leaner first-run: memberships + research start OFF (switch on in
          // Modules). Everything else active.
          activatedModules: [...DEFAULT_ACTIVATED_MODULES],
        },
      });

      const ownerUser = await tx.marketingUser.create({
        data: {
          workspaceId: workspace.id,
          email: dto.email,
          password: passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          role: 'OWNER',
        },
      });

      // Per-workspace research sentinel: ingested leads/activities are
      // attributed to it. Unguessable address + random password; SYSTEM
      // role is refused by login, refresh and the guard regardless.
      await tx.marketingUser.create({
        data: {
          workspaceId: workspace.id,
          email: `research+${workspace.id}@system.internal`,
          password: await bcrypt.hash(
            `${workspace.id}:${Date.now()}:${Math.random()}`,
            this.bcryptCost(),
          ),
          firstName: 'AI',
          lastName: 'Research',
          role: 'SYSTEM',
        },
      });

      await tx.marketingDistributionConfig.create({
        data: { workspaceId: workspace.id, strategy: 'DISABLED' },
      });

      // Start every workspace on the TRIAL package. A catalog that hasn't
      // been seeded yet must not block signup — the workspace just lands on
      // zero entitlements until ops runs seed:packages and assigns a plan.
      const trialPackage = await tx.package.findUnique({
        where: { code: 'TRIAL' },
        select: { id: true, trialDays: true },
      });
      if (trialPackage) {
        const now = new Date();
        const trialEnd = new Date(
          now.getTime() + Math.max(1, trialPackage.trialDays) * 24 * 60 * 60 * 1000,
        );
        await tx.workspaceSubscription.create({
          data: {
            workspaceId: workspace.id,
            packageId: trialPackage.id,
            status: 'TRIALING',
            billingCycle: 'MONTHLY',
            currency: dto.currency ?? 'TRY',
            currentPeriodStart: now,
            currentPeriodEnd: trialEnd,
            trialEndsAt: trialEnd,
          },
        });
      }

      return ownerUser;
    });
  }

  async getProfile(userId: string) {
    const user = await this.prisma.marketingUser.findUnique({
      where: { id: userId },
      select: {
        id: true,
        workspaceId: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatar: true,
        role: true,
        status: true,
        lastLogin: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: user.workspaceId },
      select: {
        id: true,
        slug: true,
        name: true,
        // `kind` distinguishes AGENCY / LOCATION / STANDALONE workspaces; the
        // frontend gates the agency console (sub-accounts, snapshots, rebilling)
        // on `workspace.kind === 'AGENCY'`. Additive, non-secret, read-only.
        kind: true,
        productName: true,
        productUrl: true,
        defaultLanguage: true,
        defaultCurrency: true,
        settings: true,
      },
    });

    return { ...user, workspace };
  }

  /**
   * Review fix round 1 (Finding 1 — 2FA channel hijack): an authenticated
   * session used to be able to change `phone` with no re-auth at all. For an
   * account with SMS 2FA armed (`twoFactorEnabled && !twoFactorSecret`), the
   * profile's `phone` IS the address future login challenges get texted to —
   * a hijacked session could silently repoint it to an attacker-controlled
   * number, and the legitimate owner would never see the next 2FA code.
   * Gate exactly that combination (SMS-2FA armed + phone actually changing)
   * behind `currentPassword`, mirroring `changePassword`'s existing
   * currentPassword re-check — the precedent already established in this
   * service for a sensitive account change. TOTP-armed and no-2FA accounts
   * are unaffected; non-phone edits on an SMS-armed account are unaffected.
   */
  async updateProfile(
    userId: string,
    data: { firstName?: string; lastName?: string; phone?: string; currentPassword?: string },
  ) {
    const { currentPassword, ...profileData } = data;

    if (profileData.phone !== undefined) {
      const user = await this.prisma.marketingUser.findUnique({
        where: { id: userId },
        select: { phone: true, password: true, twoFactorEnabled: true, twoFactorSecret: true },
      });
      if (!user) {
        throw new BadRequestException('User not found');
      }

      const phoneChanging = profileData.phone !== user.phone;
      const smsTwoFactorArmed = user.twoFactorEnabled && !user.twoFactorSecret;
      if (phoneChanging && smsTwoFactorArmed) {
        if (!currentPassword) {
          throw new BadRequestException(
            'Confirm your current password to change your phone number while SMS-based 2FA is enabled.',
          );
        }
        const isValid = await bcrypt.compare(currentPassword, user.password);
        if (!isValid) {
          throw new BadRequestException('Current password is incorrect');
        }
      }
    }

    return this.prisma.marketingUser.update({
      where: { id: userId },
      data: profileData,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatar: true,
        role: true,
      },
    });
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.marketingUser.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(newPassword, this.bcryptCost());
    await this.prisma.marketingUser.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        // Force-logout every session that existed before this change.
        tokenVersion: { increment: 1 },
      },
    });

    return { message: 'Password changed successfully' };
  }
}
