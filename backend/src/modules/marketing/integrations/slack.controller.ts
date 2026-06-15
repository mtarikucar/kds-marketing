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
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { SlackService } from './slack.service';

class CreateSlackDto {
  @IsUrl() @MaxLength(2000)
  webhookUrl: string;

  @IsOptional() @IsString() @MaxLength(80)
  channel?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  events?: string[];
}

class UpdateSlackDto {
  @IsOptional() @IsUrl() @MaxLength(2000)
  webhookUrl?: string;

  @IsOptional() @IsString() @MaxLength(80)
  channel?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  events?: string[];

  @IsOptional() @IsIn(['ACTIVE', 'DISABLED'])
  status?: string;
}

@MarketingRoute()
@Controller('marketing/integrations/slack')
@UseGuards(MarketingGuard, MarketingRolesGuard)
@MarketingRoles('OWNER', 'MANAGER')
export class SlackController {
  constructor(private readonly svc: SlackService) {}

  @Get()
  list(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.list(u.workspaceId);
  }

  @Post()
  @Audit({ action: 'slack.create', resourceType: 'slack-integration' })
  create(@Body() dto: CreateSlackDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.create(u.workspaceId, dto);
  }

  @Post(':id/test')
  @Audit({ action: 'slack.test', resourceType: 'slack-integration', resourceIdParam: 'id' })
  test(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.test(u.workspaceId, id);
  }

  @Patch(':id')
  @Audit({ action: 'slack.update', resourceType: 'slack-integration', resourceIdParam: 'id' })
  update(@Param('id') id: string, @Body() dto: UpdateSlackDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.update(u.workspaceId, id, dto);
  }

  @Delete(':id')
  @Audit({ action: 'slack.delete', resourceType: 'slack-integration', resourceIdParam: 'id' })
  remove(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.remove(u.workspaceId, id);
  }
}
