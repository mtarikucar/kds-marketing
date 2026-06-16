import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../../prisma/prisma.service';
import { MarketingLoginDto } from '../dto';
import { RegisterWorkspaceDto } from '../dto/register-workspace.dto';
import { DEFAULT_BUSINESS_TYPES } from '../dto/create-lead.dto';
import { hashBackupCode, verifyTotp } from '../util/totp';

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
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
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

    await this.assertWorkspaceActive(user.workspaceId);

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
      return { twoFactorRequired: true, challengeToken };
    }

    return this.generateTokens(user);
  }

  /** Epic F — complete a 2FA login: verify a TOTP or single-use backup code. */
  async verify2fa(challengeToken: string, code: string) {
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

    let ok = !!user.twoFactorSecret && verifyTotp(user.twoFactorSecret, code);
    if (!ok) {
      const hashes = (user.twoFactorBackupCodes as string[]) ?? [];
      const h = hashBackupCode(code);
      if (hashes.includes(h)) {
        ok = true;
        await this.prisma.marketingUser.update({
          where: { id: user.id },
          data: { twoFactorBackupCodes: hashes.filter((x) => x !== h) },
        });
      }
    }
    if (!ok) throw new UnauthorizedException('Invalid 2FA code');
    return this.generateTokens(user);
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
    return this.generateTokens(user);
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
  issueSession(user: {
    id: string;
    workspaceId: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    avatar: string | null;
    role: string;
    tokenVersion: number;
  }) {
    return this.generateTokens(user);
  }

  private generateTokens(user: {
    id: string;
    workspaceId: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    avatar: string | null;
    role: string;
    tokenVersion: number;
  }) {
    const basePayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      wsp: user.workspaceId,
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
        workspaceId: user.workspaceId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
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

    const owner = await this.prisma.$transaction(async (tx) => {
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
          defaultCurrency: dto.currency ?? 'USD',
          settings: { businessTypes: [...DEFAULT_BUSINESS_TYPES] },
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
            currency: dto.currency ?? 'USD',
            currentPeriodStart: now,
            currentPeriodEnd: trialEnd,
            trialEndsAt: trialEnd,
          },
        });
      }

      return ownerUser;
    });

    await this.prisma.marketingUser.update({
      where: { id: owner.id },
      data: { lastLogin: new Date(), lastLoginIp: ip },
    });

    return this.generateTokens(owner);
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

  async updateProfile(
    userId: string,
    data: { firstName?: string; lastName?: string; phone?: string },
  ) {
    return this.prisma.marketingUser.update({
      where: { id: userId },
      data,
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
