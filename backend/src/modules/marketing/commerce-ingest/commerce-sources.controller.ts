import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsIn, Matches } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { COMMERCE_SOURCE_KINDS, CommerceSourceKind, CommerceSourcesService } from './commerce-sources.service';

class CreateCommerceSourceDto {
  @Matches(/^[a-z0-9-]{2,40}$/, { message: 'slug must be 2–40 characters of a-z, 0-9 and "-"' })
  slug!: string;

  @IsIn(COMMERCE_SOURCE_KINDS as unknown as string[])
  kind!: CommerceSourceKind;
}

/**
 * Self-service management of the stores that may report orders (contract
 * §1.7). Same package gate as ingest tokens (`apiAccess`), MANAGER+, and the
 * same permission the token endpoints use. Works while COMMERCE_INGEST_ENABLED
 * is off, so a workspace can be set up before the endpoint opens.
 */
@MarketingRoute()
@Controller('marketing/commerce/sources')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('apiAccess')
export class CommerceSourcesController {
  constructor(private readonly sources: CommerceSourcesService) {}

  @Get()
  list(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.sources.list(actor.workspaceId);
  }

  /** The response carries `signingSecret` — the only time it is ever shown. */
  @Post()
  @RequirePermission('settings.manage')
  create(@CurrentMarketingUser() actor: MarketingUserPayload, @Body() dto: CreateCommerceSourceDto) {
    return this.sources.create(actor.workspaceId, dto);
  }

  /** New secret, shown once; the previous one keeps verifying for 24 hours. */
  @Post(':id/rotate')
  @RequirePermission('settings.manage')
  rotate(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.sources.rotate(actor.workspaceId, id);
  }

  /** Marks the source REVOKED; the row and its orders stay. */
  @Delete(':id')
  @RequirePermission('settings.manage')
  revoke(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.sources.revoke(actor.workspaceId, id);
  }
}
