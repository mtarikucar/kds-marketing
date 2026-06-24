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
import { ExperimentsService } from './experiments.service';
import { CreateExperimentDto, UpdateExperimentDto } from './funnels.dto';

// Admin surface only (create/update/start/stop/delete) — MANAGER+; closes the
// no-op MarketingRolesGuard gap (a REP could otherwise start/stop experiments).
@MarketingRoute()
@Controller('marketing/experiments')
@UseGuards(MarketingGuard, MarketingRolesGuard)
@MarketingRoles('MANAGER')
export class ExperimentsController {
  constructor(private readonly svc: ExperimentsService) {}

  @Get()
  list(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.list(u.workspaceId);
  }

  @Post()
  @Audit({ action: 'experiment.create', resourceType: 'experiment' })
  create(@Body() dto: CreateExperimentDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.create(u.workspaceId, dto);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.get(u.workspaceId, id);
  }

  @Get(':id/results')
  results(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.results(u.workspaceId, id);
  }

  @Patch(':id')
  @Audit({ action: 'experiment.update', resourceType: 'experiment', resourceIdParam: 'id' })
  update(@Param('id') id: string, @Body() dto: UpdateExperimentDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.update(u.workspaceId, id, dto);
  }

  @Post(':id/start')
  @Audit({ action: 'experiment.start', resourceType: 'experiment', resourceIdParam: 'id' })
  start(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.setStatus(u.workspaceId, id, 'RUNNING');
  }

  @Post(':id/stop')
  @Audit({ action: 'experiment.stop', resourceType: 'experiment', resourceIdParam: 'id' })
  stop(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.setStatus(u.workspaceId, id, 'STOPPED');
  }

  @Delete(':id')
  @Audit({ action: 'experiment.delete', resourceType: 'experiment', resourceIdParam: 'id' })
  remove(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.remove(u.workspaceId, id);
  }
}
