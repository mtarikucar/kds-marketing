import {
  Controller,
  Get,
  Post,
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
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingActivitiesService } from '../services/marketing-activities.service';
import { CreateActivityDto } from '../dto/create-activity.dto';
import { MarketingUserPayload } from '../types';

@MarketingRoute()
@Controller('marketing')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingActivitiesController {
  constructor(private readonly activitiesService: MarketingActivitiesService) {}

  @Post('leads/:leadId/activities')
  @RequirePermission('leads.write')
  create(
    @Param('leadId') leadId: string,
    @Body() dto: CreateActivityDto,
    @CurrentMarketingUser() actor: MarketingUserPayload,
  ) {
    return this.activitiesService.create(actor.workspaceId, leadId, dto, actor.id, actor.role);
  }

  @Get('leads/:leadId/activities')
  findByLead(
    @Param('leadId') leadId: string,
    @CurrentMarketingUser() actor: MarketingUserPayload,
  ) {
    return this.activitiesService.findByLead(actor.workspaceId, leadId, actor.id, actor.role);
  }

  @Delete('activities/:id')
  @MarketingRoles('MANAGER')
  @RequirePermission('leads.manage')
  delete(@Param('id') id: string, @CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.activitiesService.delete(actor.workspaceId, id);
  }
}
