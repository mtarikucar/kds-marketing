import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { InboundWebhooksService } from '../inbound-webhooks/inbound-webhooks.service';
import { CreateInboundWebhookDto, UpdateInboundWebhookDto } from '../dto/inbound-webhook.dto';

/**
 * Inbound-webhook management (GHL parity). MANAGER + automations.manage — these
 * mint a public endpoint that fires workflows, so they are automation config and
 * the secret (returned once on create/rotate) is sensitive. CRUD is
 * workspace-scoped via the service.
 */
@MarketingRoute()
@Controller('marketing/inbound-webhooks')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequirePermission('automations.manage')
export class MarketingInboundWebhooksController {
  constructor(private readonly webhooks: InboundWebhooksService) {}

  @Get()
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.webhooks.list(a.workspaceId);
  }

  @Post()
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateInboundWebhookDto) {
    return this.webhooks.create(a.workspaceId, dto);
  }

  @Patch(':id')
  update(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateInboundWebhookDto,
  ) {
    return this.webhooks.update(a.workspaceId, id, dto);
  }

  /** Rotate the secret (the old one stops working immediately). */
  @Post(':id/rotate-secret')
  rotate(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.webhooks.rotateSecret(a.workspaceId, id);
  }

  @Delete(':id')
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.webhooks.remove(a.workspaceId, id);
  }
}
