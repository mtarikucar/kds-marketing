import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { ApiKeysService } from '../services/api-keys.service';
import { CreateApiKeyDto } from '../dto/api-key.dto';

/**
 * Epic B1 — workspace-realm management of programmatic API keys. Only OWNER /
 * MANAGER may mint or revoke keys (they grant external access to workspace data).
 */
@MarketingRoute()
@Controller('marketing/api-keys')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class MarketingApiKeysController {
  constructor(private readonly svc: ApiKeysService) {}

  @Get()
  list(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.svc.list(user.workspaceId);
  }

  @Post()
  @Audit({ action: 'api-key.create', resourceType: 'api-key', captureBody: ['name'] })
  @RequirePermission('settings.manage')
  create(
    @Body() dto: CreateApiKeyDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.create(user.workspaceId, dto.name, dto.scopes, user.id);
  }

  @Delete(':id')
  @Audit({ action: 'api-key.revoke', resourceType: 'api-key', resourceIdParam: 'id' })
  @RequirePermission('settings.manage')
  revoke(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.revoke(user.workspaceId, id);
  }
}
