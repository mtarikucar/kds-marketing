import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  CanActivate,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { IS_MARKETING_PUBLIC_KEY } from '../decorators/marketing-public.decorator';
import { PrismaService } from '../../../prisma/prisma.service';
import { MarketingJwtPayload } from '../types';

@Injectable()
export class MarketingGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwtService: JwtService,
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_MARKETING_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    try {
      const payload = await this.jwtService.verifyAsync<
        MarketingJwtPayload & { ver?: number }
      >(token, {
        secret: this.configService.get<string>('MARKETING_JWT_SECRET'),
        algorithms: ['HS256'],
      });

      if (payload.type !== 'marketing') {
        throw new UnauthorizedException('Invalid token type');
      }

      const marketingUser = await this.prisma.marketingUser.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          workspaceId: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          // Epic F — needed by PermissionsGuard so a user's custom role (when
          // assigned) overrides the legacy OWNER/MANAGER/REP permission mapping.
          customRoleId: true,
          tokenVersion: true,
          // The ACTIVE membership for the token's active workspace — the source
          // of truth for this request's role/customRoleId under multi-workspace.
          memberships: {
            where: { workspaceId: payload.wsp, status: 'ACTIVE' },
            select: { workspaceId: true, role: true, customRoleId: true },
            take: 1,
          },
        },
      });

      if (!marketingUser || marketingUser.status !== 'ACTIVE') {
        throw new UnauthorizedException('User not found or inactive');
      }

      // The research sentinel owns rows, never sessions: a SYSTEM token
      // (which generateTokens refuses to mint anyway) is dead on arrival.
      if (marketingUser.role === 'SYSTEM') {
        throw new UnauthorizedException('System accounts cannot authenticate');
      }

      // COND 5 (multi-workspace): the session is valid only if the user still
      // holds an ACTIVE membership for the token's active workspace. Revocation
      // (SUSPEND / remove) denies the very next request.
      const membership = marketingUser.memberships[0];
      if (!membership) {
        throw new UnauthorizedException('Session revoked');
      }

      if (typeof payload.ver === 'number' && payload.ver !== marketingUser.tokenVersion) {
        throw new UnauthorizedException('Session revoked');
      }

      const { tokenVersion: _v, memberships: _m, workspaceId: _home, role: _homeRole, customRoleId: _homeCr, ...rest } = marketingUser;
      request.marketingUser = {
        ...rest,
        // The active workspace + the role/customRoleId resolved FROM the membership.
        workspaceId: membership.workspaceId,
        role: membership.role,
        customRoleId: membership.customRoleId,
      };
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid token');
    }
  }

  private extractTokenFromHeader(request: any): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
