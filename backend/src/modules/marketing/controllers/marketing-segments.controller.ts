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
import {
  CreateSegmentDto,
  PreviewSegmentDto,
  UpdateSegmentDto,
} from '../dto/segment.dto';

@MarketingRoute()
@Controller('marketing/segments')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingSegmentsController {
  constructor(private readonly svc: SegmentsService) {}

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
