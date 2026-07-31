import { ForbiddenException } from '@nestjs/common';
import { EntitlementsService, FeatureKey } from '../../billing/entitlements.service';

/**
 * The MCP equivalent of `@RequiresFeature` (guards/feature.guard.ts).
 *
 * MCP tools do not pass through Nest's guard pipeline — the transport is one
 * `POST /api/mcp` handler and the per-tool policy lives in the broker — so a
 * tool wrapping a package-gated service has to make the same entitlement check
 * itself. It is deliberately the SAME check (`EntitlementsService.getEffective`
 * + `features[key]`) and the SAME 403 shape (`FEATURE_NOT_IN_PACKAGE` + the
 * feature name) the REST gate produces, so a workspace cannot reach through MCP
 * something its package denies over REST, and the refusal is a sentence an
 * agent can relay ("your plan does not include mediaGen") rather than a 500
 * from a service that assumed the module was provisioned.
 *
 * Deny-by-default: a key absent from the effective map is NOT entitled.
 *
 * This is a plain function, not an injectable, because tool modules are wired
 * as `register*Tools(registry, deps)` closures rather than Nest providers — the
 * `EntitlementsService` instance is already in `deps`.
 */
export async function assertFeature(
  entitlements: EntitlementsService,
  workspaceId: string,
  feature: FeatureKey,
): Promise<void> {
  const effective = await entitlements.getEffective(workspaceId);
  if (!effective?.features?.[feature]) {
    throw new ForbiddenException({
      message: `This workspace's package does not include the "${feature}" feature. Upgrade the plan (or enable the module) before using this tool.`,
      feature,
      code: 'FEATURE_NOT_IN_PACKAGE',
    });
  }
}
