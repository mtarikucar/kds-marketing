import {
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { siteTrackingEnabled } from './site-tracking.flag';
import { SiteTrackingService } from './site-tracking.service';

/** With SITE_TRACKING_ENABLED off, key management answers like a route that does not exist. */
@Injectable()
export class SiteTrackingEnabledGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (siteTrackingEnabled()) return true;
    const req = context.switchToHttp().getRequest<Request>();
    throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl ?? req.url}`);
  }
}

class CreateSiteKeyDto {
  @IsOptional() @IsString() @MaxLength(80) label?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(253, { each: true }) allowedHosts?: string[];
}

/**
 * Site snippet keys (contract §7.1): the `data-site-key` a store pastes with
 * jeeta.js. Same package gate as ingest tokens (`apiAccess`), MANAGER+.
 */
@MarketingRoute()
@Controller('marketing/site-tracking/keys')
@UseGuards(SiteTrackingEnabledGuard, MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('apiAccess')
export class SiteKeysController {
  constructor(private readonly tracking: SiteTrackingService) {}

  /** Each key with its ready-to-paste `<script>` tag. */
  @Get()
  list(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.tracking.list(actor.workspaceId);
  }

  @Post()
  @RequirePermission('settings.manage')
  create(@CurrentMarketingUser() actor: MarketingUserPayload, @Body() dto: CreateSiteKeyDto) {
    return this.tracking.createKey(actor.workspaceId, dto);
  }

  /** Stops counting for the key; its history stays. */
  @Delete(':id')
  @RequirePermission('settings.manage')
  revoke(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.tracking.revoke(actor.workspaceId, id);
  }
}
