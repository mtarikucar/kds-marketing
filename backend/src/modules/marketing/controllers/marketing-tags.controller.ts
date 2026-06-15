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
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { TagsService } from '../services/tags.service';
import {
  BulkAssignTagsDto,
  BulkUnassignTagsDto,
  CreateTagDto,
  UpdateTagDto,
} from '../dto/tag.dto';

@MarketingRoute()
@Controller('marketing/tags')
@UseGuards(MarketingGuard, MarketingRolesGuard)
export class MarketingTagsController {
  constructor(private readonly svc: TagsService) {}

  @Get()
  list(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.svc.list(user.workspaceId);
  }

  @Post()
  @Audit({ action: 'tag.create', resourceType: 'tag' })
  create(
    @Body() dto: CreateTagDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.create(user.workspaceId, dto);
  }

  @Post('bulk-assign')
  @Audit({ action: 'tag.bulk-assign', resourceType: 'tag' })
  bulkAssign(
    @Body() dto: BulkAssignTagsDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.bulkAssign(user.workspaceId, dto.leadIds, dto.names, user.id);
  }

  @Post('bulk-unassign')
  @Audit({ action: 'tag.bulk-unassign', resourceType: 'tag' })
  bulkUnassign(
    @Body() dto: BulkUnassignTagsDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.bulkUnassign(user.workspaceId, dto.leadIds, dto.tagIds);
  }

  @Patch(':id')
  @Audit({ action: 'tag.update', resourceType: 'tag', resourceIdParam: 'id' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTagDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.update(user.workspaceId, id, dto);
  }

  @Delete(':id')
  @Audit({ action: 'tag.delete', resourceType: 'tag', resourceIdParam: 'id' })
  remove(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.remove(user.workspaceId, id);
  }
}
