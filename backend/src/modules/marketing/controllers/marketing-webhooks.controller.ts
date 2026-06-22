import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
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
import { WebhookOutboundService } from '../services/webhook-outbound.service';
import { CreateWebhookDto, UpdateWebhookDto } from '../dto/webhook.dto';

/**
 * Epic B2 — workspace-realm management of outbound webhook endpoints. Only
 * OWNER/MANAGER may manage them (they stream workspace data to external URLs).
 */
@MarketingRoute()
@Controller('marketing/webhooks')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class MarketingWebhooksController {
  constructor(private readonly svc: WebhookOutboundService) {}

  @Get()
  list(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.svc.listEndpoints(user.workspaceId);
  }

  @Post()
  @Audit({ action: 'webhook.create', resourceType: 'webhook' })
  @RequirePermission('settings.manage')
  create(
    @Body() dto: CreateWebhookDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.createEndpoint(user.workspaceId, dto, user.id);
  }

  @Get(':id/deliveries')
  deliveries(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.listDeliveries(user.workspaceId, id);
  }

  @Post(':id/test')
  @Audit({ action: 'webhook.test', resourceType: 'webhook', resourceIdParam: 'id' })
  @RequirePermission('settings.manage')
  test(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.sendTest(user.workspaceId, id);
  }

  @Patch(':id')
  @Audit({ action: 'webhook.update', resourceType: 'webhook', resourceIdParam: 'id' })
  @RequirePermission('settings.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.updateEndpoint(user.workspaceId, id, dto);
  }

  @Delete(':id')
  @Audit({ action: 'webhook.delete', resourceType: 'webhook', resourceIdParam: 'id' })
  @RequirePermission('settings.manage')
  remove(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.removeEndpoint(user.workspaceId, id);
  }
}
