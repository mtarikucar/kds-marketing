import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { InstallationJobService } from './installation-job.service';
import { InstallationCrewService } from './installation-crew.service';
import { CreateCrewDto, UpdateCrewDto } from './dto/installation-crew.dto';
import {
  CreateJobDto,
  ScheduleJobDto,
  UpdateJobStatusDto,
  CreateInstallTaskDto,
  JobFilterDto,
} from './dto/installation-job.dto';
import { MarketingUserPayload } from '../types';

/**
 * Installation ops console (Phase 3). Marketing-authenticated. Crew management
 * + availability is MANAGER-only; job scheduling/status/tasks are open to
 * any marketing user (the install operators). Every route is scoped to the
 * actor's workspace.
 */
@MarketingRoute()
@Controller('marketing/installations')
@UseGuards(MarketingGuard, MarketingRolesGuard)
export class InstallationController {
  constructor(
    private readonly jobs: InstallationJobService,
    private readonly crews: InstallationCrewService,
  ) {}

  // --- crews ---

  @Get('crews')
  listCrews(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.crews.list(actor.workspaceId, activeOnly === 'true');
  }

  @Post('crews')
  @MarketingRoles('MANAGER')
  createCrew(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: CreateCrewDto,
  ) {
    return this.crews.create(actor.workspaceId, dto);
  }

  @Patch('crews/:id')
  @MarketingRoles('MANAGER')
  updateCrew(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateCrewDto,
  ) {
    return this.crews.update(actor.workspaceId, id, dto);
  }

  @Get('crews/availability')
  crewAvailability(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Query('date') date: string,
  ) {
    // Service normalizes the raw query string to a date-only UTC key.
    return this.crews.availabilityOn(actor.workspaceId, date);
  }

  // --- dashboard ---

  @Get('dashboard')
  dashboard(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.jobs.dashboard(actor.workspaceId);
  }

  // --- jobs ---

  @Get('jobs')
  listJobs(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Query() filter: JobFilterDto,
  ) {
    return this.jobs.list(actor.workspaceId, filter);
  }

  @Post('jobs')
  @MarketingRoles('MANAGER')
  createJob(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: CreateJobDto,
  ) {
    return this.jobs.create(actor.workspaceId, dto);
  }

  @Get('jobs/:id')
  getJob(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.jobs.get(actor.workspaceId, id);
  }

  @Post('jobs/:id/schedule')
  schedule(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: ScheduleJobDto,
  ) {
    return this.jobs.schedule(actor.workspaceId, id, dto);
  }

  @Patch('jobs/:id/status')
  setStatus(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateJobStatusDto,
  ) {
    return this.jobs.setStatus(actor.workspaceId, id, dto.status);
  }

  // --- tasks ---

  @Post('jobs/:id/tasks')
  addTask(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: CreateInstallTaskDto,
  ) {
    return this.jobs.addTask(actor.workspaceId, id, dto);
  }

  @Patch('jobs/:id/tasks/:taskId/toggle')
  toggleTask(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Param('taskId') taskId: string,
  ) {
    return this.jobs.toggleTask(actor.workspaceId, id, taskId);
  }

  @Delete('jobs/:id/tasks/:taskId')
  removeTask(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Param('taskId') taskId: string,
  ) {
    return this.jobs.removeTask(actor.workspaceId, id, taskId);
  }
}
