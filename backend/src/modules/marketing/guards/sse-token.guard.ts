import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  CanActivate,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { MarketingJwtPayload } from '../types';

/**
 * SSE auth guard. EventSource can't set an Authorization header, so the Inbox
 * stream passes the marketing access token as `?access_token=`. Verification
 * is otherwise identical to MarketingGuard (type + workspace-claim + token
 * version cross-check), and the Bearer header is still accepted as a fallback.
 */
@Injectable()
export class SseTokenGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token =
      (request.query?.access_token as string | undefined) ||
      this.fromHeader(request);
    if (!token) throw new UnauthorizedException('No token provided');

    try {
      const payload = await this.jwtService.verifyAsync<
        MarketingJwtPayload & { ver?: number }
      >(token, {
        secret: this.configService.get<string>('MARKETING_JWT_SECRET'),
        algorithms: ['HS256'],
      });
      if (payload.type !== 'marketing') throw new UnauthorizedException('Invalid token type');

      const user = await this.prisma.marketingUser.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          workspaceId: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          tokenVersion: true,
          // NetGSM Phase 3 Task 3 — the telephony screen-pop stream filters
          // by the rep's own extension; only this guard needs it.
          dahili: true,
        },
      });
      if (!user || user.status !== 'ACTIVE' || user.role === 'SYSTEM') {
        throw new UnauthorizedException('User not found or inactive');
      }
      if (payload.wsp !== user.workspaceId) throw new UnauthorizedException('Session revoked');
      if (typeof payload.ver === 'number' && payload.ver !== user.tokenVersion) {
        throw new UnauthorizedException('Session revoked');
      }
      const { tokenVersion: _v, ...publicFields } = user;
      request.marketingUser = publicFields;
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid token');
    }
  }

  private fromHeader(request: any): string | undefined {
    const [type, token] = request.headers?.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
