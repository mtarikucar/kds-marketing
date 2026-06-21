import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { CreateSubscriptionDto, UpdateSubscriptionDto } from '../dto/subscription.dto';

/**
 * Recurring customer subscriptions (GoHighLevel parity). A manager capability:
 * reads require leads.read, mutations leads.manage. The hourly sweep then mints
 * a DRAFT invoice per due period (no auto-charge).
 */
@Controller('marketing/subscriptions')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoute()
export class MarketingSubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Get()
  @RequirePermission('leads.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.subs.list(a.workspaceId);
  }

  @Get(':id')
  @RequirePermission('leads.read')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.subs.get(a.workspaceId, id);
  }

  @Post()
  @RequirePermission('leads.manage')
  @Audit({ action: 'subscription.create', resourceType: 'subscription', captureBody: ['name'] })
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateSubscriptionDto) {
    return this.subs.create(a.workspaceId, dto);
  }

  @Patch(':id')
  @RequirePermission('leads.manage')
  update(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateSubscriptionDto,
  ) {
    return this.subs.update(a.workspaceId, id, dto);
  }

  @Post(':id/pause')
  @RequirePermission('leads.manage')
  pause(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.subs.pause(a.workspaceId, id);
  }

  @Post(':id/resume')
  @RequirePermission('leads.manage')
  resume(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.subs.resume(a.workspaceId, id);
  }

  @Post(':id/cancel')
  @RequirePermission('leads.manage')
  @Audit({ action: 'subscription.cancel', resourceType: 'subscription' })
  cancel(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.subs.cancel(a.workspaceId, id);
  }
}
