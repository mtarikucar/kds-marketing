import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
import { SegmentsService } from '../services/segments.service';
import { AudienceSyncService } from '../ads/audience-sync.service';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import {
  CreateSegmentDto,
  PreviewSegmentDto,
  SyncSegmentAudienceDto,
  UpdateSegmentDto,
} from '../dto/segment.dto';

@MarketingRoute()
@Controller('marketing/segments')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingSegmentsController {
  constructor(
    private readonly svc: SegmentsService,
    private readonly audiences: AudienceSyncService,
  ) {}

  @Get()
  list(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.svc.list(user.workspaceId);
  }

  @Post()
  @Audit({ action: 'segment.create', resourceType: 'segment' })
  @RequirePermission('contacts.write')
  create(
    @Body() dto: CreateSegmentDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.create(user.workspaceId, dto);
  }

  @Post('preview')
  @RequirePermission('contacts.write')
  preview(
    @Body() dto: PreviewSegmentDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.preview(user.workspaceId, dto.definition);
  }

  @Get(':id/members')
  // Returns actual Lead records for the segment — gate it like its data siblings
  // preview/count (which expose less). Without this any authenticated marketing
  // user, even one without contacts access, could page a segment's lead list.
  @RequirePermission('contacts.write')
  members(
    @Param('id') id: string,
    @Query('page') page: string,
    @Query('pageSize') pageSize: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.members(
      user.workspaceId,
      id,
      page ? parseInt(page, 10) : 1,
      pageSize ? Math.min(parseInt(pageSize, 10), 200) : 50,
    );
  }

  @Post(':id/count')
  @RequirePermission('contacts.write')
  count(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.count(user.workspaceId, id);
  }

  // Push this segment to a connected Meta ad account as a Custom Audience (+
  // optional Lookalike). Sends hashed customer PII to an external platform, so
  // it's gated tighter than the segment reads — MANAGER + settings.manage.
  @Post(':id/sync/:accountId')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'segment.audience.sync', resourceType: 'segment', resourceIdParam: 'id' })
  syncAudience(
    @Param('id') id: string,
    @Param('accountId') accountId: string,
    @Body() dto: SyncSegmentAudienceDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.audiences.syncSegment(user.workspaceId, id, accountId, dto);
  }

  @Patch(':id')
  @Audit({ action: 'segment.update', resourceType: 'segment', resourceIdParam: 'id' })
  @RequirePermission('contacts.write')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSegmentDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.update(user.workspaceId, id, dto);
  }

  @Delete(':id')
  @Audit({ action: 'segment.delete', resourceType: 'segment', resourceIdParam: 'id' })
  @RequirePermission('contacts.write')
  remove(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.remove(user.workspaceId, id);
  }
}
