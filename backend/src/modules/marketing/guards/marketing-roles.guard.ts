import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MARKETING_ROLES_KEY } from '../decorators/marketing-roles.decorator';

/**
 * Role rank for the hierarchical check: a requirement is satisfied by the
 * required role OR anything above it, so @MarketingRoles('MANAGER') admits
 * OWNER without every call site spelling both out. SYSTEM ranks below
 * everything — the sentinel can never pass a role gate.
 */
const ROLE_RANK: Record<string, number> = {
  OWNER: 3,
  MANAGER: 2,
  REP: 1,
  SYSTEM: 0,
};

@Injectable()
export class MarketingRolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      MARKETING_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.marketingUser;

    if (!user) {
      throw new ForbiddenException('No marketing user found');
    }

    const userRank = ROLE_RANK[user.role] ?? 0;
    const minRequired = Math.min(
      ...requiredRoles.map((r) => ROLE_RANK[r] ?? Number.POSITIVE_INFINITY),
    );

    if (userRank < minRequired || userRank === 0) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
