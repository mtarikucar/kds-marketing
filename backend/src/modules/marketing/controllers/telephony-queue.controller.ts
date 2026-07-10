import { Controller, Get, Post, Query, Body, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { TelephonyQueueService } from '../services/telephony-queue.service';
import { AgentPresenceDto } from '../dto/telephony-queue.dto';
import { MarketingUserPayload } from '../types';

/**
 * Queue wallboard + agent presence (NetGSM Phase 4 Task 4). Same guard chain
 * and permission tiers as TelephonyControlController's in-call actions:
 * `leads.read` for the read-only stats poll, `leads.write` for the
 * presence toggle (it mutates PBX agent state, even though it's self-scoped).
 * Lives at `marketing/telephony/queues` + `marketing/telephony/agent`,
 * alongside the rest of the telephony surface.
 */
@MarketingRoute()
@RequiresFeature('telephony')
@Controller('marketing/telephony')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
export class TelephonyQueueController {
  constructor(private readonly queues: TelephonyQueueService) {}

  @Get('queues/stats')
  @RequirePermission('leads.read')
  stats(@CurrentMarketingUser() user: MarketingUserPayload, @Query('queue') queue?: string) {
    return this.queues.stats(user.workspaceId, queue);
  }

  @Post('agent/presence')
  @RequirePermission('leads.write')
  presence(@Body() dto: AgentPresenceDto, @CurrentMarketingUser() user: MarketingUserPayload) {
    return this.queues.setPresence(user.workspaceId, user.id, dto);
  }
}
