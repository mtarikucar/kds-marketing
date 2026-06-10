import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlatformLoginDto } from '../dto/platform.dto';

const MAX_FAILED_LOGINS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

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

    if (!operator) throw new UnauthorizedException('Invalid credentials');
    if (operator.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is inactive');
    }
    if (operator.lockedUntil && operator.lockedUntil > new Date()) {
      throw new UnauthorizedException('Account is temporarily locked');
    }

    const ok = await bcrypt.compare(dto.password, operator.password);
    if (!ok) {
      const nextCount = operator.failedLogins + 1;
      const locking = nextCount >= MAX_FAILED_LOGINS;
      await this.prisma.platformOperator.update({
        where: { id: operator.id },
        data: {
          failedLogins: locking ? 0 : nextCount,
          lockedUntil: locking ? new Date(Date.now() + LOCK_DURATION_MS) : null,
        },
      });
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
