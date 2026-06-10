import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  CanActivate,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';

export interface PlatformOperatorPayload {
  id: string;
  email: string;
  name: string;
}

/**
 * Platform (superadmin) realm guard — third token realm next to the
 * marketing-user and internal-service ones. Same posture as MarketingGuard:
 * verify signature + type, re-read the operator row, honor tokenVersion.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException('No token provided');
    }

    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        type: string;
        ver?: number;
      }>(token, {
        secret: this.configService.get<string>('PLATFORM_JWT_SECRET'),
        algorithms: ['HS256'],
      });

      if (payload.type !== 'platform') {
        throw new UnauthorizedException('Invalid token type');
      }

      const operator = await this.prisma.platformOperator.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          email: true,
          name: true,
          status: true,
          tokenVersion: true,
        },
      });

      if (!operator || operator.status !== 'ACTIVE') {
        throw new UnauthorizedException('Operator not found or inactive');
      }
      if (typeof payload.ver === 'number' && payload.ver !== operator.tokenVersion) {
        throw new UnauthorizedException('Session revoked');
      }

      const { status: _s, tokenVersion: _v, ...publicFields } = operator;
      request.platformOperator = publicFields satisfies PlatformOperatorPayload;
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid token');
    }
  }
}
