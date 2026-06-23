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
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { SurveysService } from './surveys.service';
import { CreateSurveyDto, UpdateSurveyDto } from './funnels.dto';

// Authoring surface only (create/update/delete) — MANAGER+, matching the
// campaigns controller. MarketingRolesGuard is a no-op without this decorator,
// so its presence here closes a gap where any REP could mutate survey defs.
@MarketingRoute()
@Controller('marketing/surveys')
@UseGuards(MarketingGuard, MarketingRolesGuard)
@MarketingRoles('MANAGER')
export class SurveysController {
  constructor(private readonly svc: SurveysService) {}

  @Get()
  list(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.list(u.workspaceId);
  }

  @Post()
  @Audit({ action: 'survey.create', resourceType: 'survey' })
  create(@Body() dto: CreateSurveyDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.create(u.workspaceId, dto);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.get(u.workspaceId, id);
  }

  @Get(':id/responses')
  responses(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listResponses(u.workspaceId, id);
  }

  @Patch(':id')
  @Audit({ action: 'survey.update', resourceType: 'survey', resourceIdParam: 'id' })
  update(@Param('id') id: string, @Body() dto: UpdateSurveyDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.update(u.workspaceId, id, dto);
  }

  @Delete(':id')
  @Audit({ action: 'survey.delete', resourceType: 'survey', resourceIdParam: 'id' })
  remove(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.remove(u.workspaceId, id);
  }
}
