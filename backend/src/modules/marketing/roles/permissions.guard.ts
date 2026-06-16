import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesService } from './roles.service';
import { REQUIRE_PERMISSION_KEY } from './require-permission.decorator';

/**
 * Epic F — opt-in granular permission check. Runs AFTER MarketingGuard (which
 * sets request.marketingUser, including `customRoleId`). Endpoints without
 * @RequirePermission pass through untouched, so this is purely additive.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly roles: RolesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string>(REQUIRE_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const user = context.switchToHttp().getRequest().marketingUser;
    if (!user) throw new ForbiddenException('Not authenticated');
    const ok = await this.roles.hasPermission(
      { role: user.role, customRoleId: user.customRoleId },
      required,
    );
    if (!ok) throw new ForbiddenException(`Missing permission: ${required}`);
    return true;
  }
}
