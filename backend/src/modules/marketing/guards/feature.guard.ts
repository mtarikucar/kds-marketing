import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  EntitlementsService,
  FeatureKey,
} from '../../billing/entitlements.service';

export const REQUIRES_FEATURE_KEY = 'requiresFeature';

/** Gate a controller/route on a package feature flag. */
export const RequiresFeature = (feature: FeatureKey) =>
  SetMetadata(REQUIRES_FEATURE_KEY, feature);

/**
 * Entitlement gate — runs AFTER MarketingGuard (needs request.marketingUser
 * for the workspace). 403 carries the feature name so the SPA can route the
 * user to the billing page instead of showing a dead end.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<FeatureKey | undefined>(
      REQUIRES_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!feature) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.marketingUser;
    if (!user?.workspaceId) {
      throw new ForbiddenException('No workspace context');
    }

    const effective = await this.entitlements.getEffective(user.workspaceId);
    if (!effective.features[feature]) {
      throw new ForbiddenException({
        message: `This feature requires a higher package`,
        feature,
        code: 'FEATURE_NOT_IN_PACKAGE',
      });
    }
    return true;
  }
}
