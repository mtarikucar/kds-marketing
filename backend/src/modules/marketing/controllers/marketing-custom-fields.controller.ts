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
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { CustomFieldsService } from '../services/custom-fields.service';
import {
  CreateCustomFieldDefDto,
  ReorderCustomFieldsDto,
  UpdateCustomFieldDefDto,
} from '../dto/custom-field.dto';

@MarketingRoute()
@Controller('marketing/custom-fields')
@UseGuards(MarketingGuard, MarketingRolesGuard)
export class MarketingCustomFieldsController {
  constructor(private readonly svc: CustomFieldsService) {}

  @Get()
  list(
    @Query('includeArchived') includeArchived: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.list(user.workspaceId, includeArchived === 'true');
  }

  @Post()
  @Audit({ action: 'custom-field.create', resourceType: 'custom-field' })
  create(
    @Body() dto: CreateCustomFieldDefDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.create(user.workspaceId, dto);
  }

  @Post('reorder')
  @Audit({ action: 'custom-field.reorder', resourceType: 'custom-field' })
  reorder(
    @Body() dto: ReorderCustomFieldsDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.reorder(user.workspaceId, dto.ids);
  }

  @Patch(':id')
  @Audit({
    action: 'custom-field.update',
    resourceType: 'custom-field',
    resourceIdParam: 'id',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomFieldDefDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.update(user.workspaceId, id, dto);
  }

  @Delete(':id')
  @Audit({
    action: 'custom-field.archive',
    resourceType: 'custom-field',
    resourceIdParam: 'id',
  })
  archive(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.archive(user.workspaceId, id);
  }

  @Post(':id/restore')
  @Audit({
    action: 'custom-field.restore',
    resourceType: 'custom-field',
    resourceIdParam: 'id',
  })
  restore(
    @Param('id') id: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.restore(user.workspaceId, id);
  }
}
