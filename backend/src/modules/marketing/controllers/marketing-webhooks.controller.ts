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
@UseGuards(MarketingGuard, MarketingRolesGuard)
@MarketingRoles('OWNER', 'MANAGER')
export class MarketingWebhooksController {
  constructor(private readonly svc: WebhookOutboundService) {}

  @Get()
  list(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.svc.listEndpoints(user.workspaceId);
  }

  @Post()
  @Audit({ action: 'webhook.create', resourceType: 'webhook' })
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
  test(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.sendTest(user.workspaceId, id);
  }

  @Patch(':id')
  @Audit({ action: 'webhook.update', resourceType: 'webhook', resourceIdParam: 'id' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.updateEndpoint(user.workspaceId, id, dto);
  }

  @Delete(':id')
  @Audit({ action: 'webhook.delete', resourceType: 'webhook', resourceIdParam: 'id' })
  remove(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.removeEndpoint(user.workspaceId, id);
  }
}
