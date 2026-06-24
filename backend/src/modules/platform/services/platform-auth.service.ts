import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlatformLoginDto } from '../dto/platform.dto';

const MAX_FAILED_LOGINS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
// Constant-time login: an unknown operator email must cost roughly one bcrypt
// compare, so response timing can't be used to enumerate which emails exist.
// (Mirrors the marketing-auth defence; this is the highest-privilege realm.)
const DUMMY_BCRYPT_HASH = bcrypt.hashSync('not-a-real-password', 12);

/**
 * Auth for the platform (superadmin) realm. Deliberately minimal: a 12h
 * access token and no refresh flow — operators are few and re-login is
 * cheap; one less long-lived credential class to steal.
 */
@Injectable()
export class PlatformAuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  private secret(): string {
    const secret = this.configService.get<string>('PLATFORM_JWT_SECRET');
    if (!secret) throw new Error('PLATFORM_JWT_SECRET is not configured');
    return secret;
  }

  async login(dto: PlatformLoginDto, ip?: string) {
    const operator = await this.prisma.platformOperator.findUnique({
      where: { email: dto.email },
    });

    if (!operator) {
      // Burn ~one bcrypt compare so a missing email costs the same as a wrong
      // password — no timing oracle distinguishing valid operator emails.
      await bcrypt.compare(dto.password, DUMMY_BCRYPT_HASH);
      throw new UnauthorizedException('Invalid credentials');
    }
    if (operator.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is inactive');
    }
    if (operator.lockedUntil && operator.lockedUntil > new Date()) {
      throw new UnauthorizedException('Account is temporarily locked');
    }

    const ok = await bcrypt.compare(dto.password, operator.password);
    if (!ok) {
      // Atomic increment: two concurrent bad-password attempts must each count.
      // The prior read-modify-write computed nextCount from a stale in-memory
      // value, so parallel guesses could collide and undercount toward the
      // lock. `increment` pushes the +1 into the UPDATE so the DB serialises
      // them. failedLogins is reset to 0 only on a SUCCESSFUL login (below) —
      // never here — so the counter survives across attempts until the lock
      // trips or a correct password clears it.
      const { failedLogins } = await this.prisma.platformOperator.update({
        where: { id: operator.id },
        data: { failedLogins: { increment: 1 } },
        select: { failedLogins: true },
      });
      if (failedLogins >= MAX_FAILED_LOGINS) {
        await this.prisma.platformOperator.update({
          where: { id: operator.id },
          data: { lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) },
        });
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.platformOperator.update({
      where: { id: operator.id },
      data: { failedLogins: 0, lockedUntil: null, lastLogin: new Date() },
    });

    const accessToken = this.jwtService.sign(
      {
        sub: operator.id,
        email: operator.email,
        ver: operator.tokenVersion,
        type: 'platform' as const,
      },
      { secret: this.secret(), expiresIn: '12h', algorithm: 'HS256' },
    );

    return {
      accessToken,
      operator: {
        id: operator.id,
        email: operator.email,
        name: operator.name,
      },
    };
  }

  async logout(operatorId: string) {
    await this.prisma.platformOperator.update({
      where: { id: operatorId },
      data: { tokenVersion: { increment: 1 } },
    });
    return { message: 'Logged out' };
  }
}
