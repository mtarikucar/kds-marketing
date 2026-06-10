import { Controller, Get, Patch, Param, Query, UseGuards } from '@nestjs/common';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingNotificationsService } from '../services/marketing-notifications.service';
import { MarketingUserPayload } from '../types';

@MarketingRoute()
@Controller('marketing/notifications')
@UseGuards(MarketingGuard, MarketingRolesGuard)
export class MarketingNotificationsController {
  constructor(private readonly notificationsService: MarketingNotificationsService) {}

  @Get()
  findAll(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Query('isRead') isRead?: string,
  ) {
    const parsed = isRead === 'true' ? true : isRead === 'false' ? false : undefined;
    return this.notificationsService.findAll(actor.workspaceId, actor.id, parsed);
  }

  @Get('unread-count')
  getUnreadCount(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.notificationsService.getUnreadCount(actor.workspaceId, actor.id);
  }

  @Patch(':id/read')
  markRead(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.notificationsService.markRead(actor.workspaceId, id, actor.id);
  }

  @Patch('read-all')
  markAllRead(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.notificationsService.markAllRead(actor.workspaceId, actor.id);
  }
}
