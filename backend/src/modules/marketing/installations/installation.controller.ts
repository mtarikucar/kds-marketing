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

/**
 * Installation ops console (Phase 3). Marketing-authenticated. Crew management
 * + availability is SALES_MANAGER-only; job scheduling/status/tasks are open to
 * any marketing user (the install operators).
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
  listCrews(@Query('activeOnly') activeOnly?: string) {
    return this.crews.list(activeOnly === 'true');
  }

  @Post('crews')
  @MarketingRoles('SALES_MANAGER')
  createCrew(@Body() dto: CreateCrewDto) {
    return this.crews.create(dto);
  }

  @Patch('crews/:id')
  @MarketingRoles('SALES_MANAGER')
  updateCrew(@Param('id') id: string, @Body() dto: UpdateCrewDto) {
    return this.crews.update(id, dto);
  }

  @Get('crews/availability')
  crewAvailability(@Query('date') date: string) {
    // Service normalizes the raw query string to a date-only UTC key.
    return this.crews.availabilityOn(date);
  }

  // --- dashboard ---

  @Get('dashboard')
  dashboard() {
    return this.jobs.dashboard();
  }

  // --- jobs ---

  @Get('jobs')
  listJobs(@Query() filter: JobFilterDto) {
    return this.jobs.list(filter);
  }

  @Post('jobs')
  @MarketingRoles('SALES_MANAGER')
  createJob(@Body() dto: CreateJobDto) {
    return this.jobs.create(dto);
  }

  @Get('jobs/:id')
  getJob(@Param('id') id: string) {
    return this.jobs.get(id);
  }

  @Post('jobs/:id/schedule')
  schedule(@Param('id') id: string, @Body() dto: ScheduleJobDto) {
    return this.jobs.schedule(id, dto);
  }

  @Patch('jobs/:id/status')
  setStatus(@Param('id') id: string, @Body() dto: UpdateJobStatusDto) {
    return this.jobs.setStatus(id, dto.status);
  }

  // --- tasks ---

  @Post('jobs/:id/tasks')
  addTask(@Param('id') id: string, @Body() dto: CreateInstallTaskDto) {
    return this.jobs.addTask(id, dto);
  }

  @Patch('jobs/:id/tasks/:taskId/toggle')
  toggleTask(@Param('id') id: string, @Param('taskId') taskId: string) {
    return this.jobs.toggleTask(id, taskId);
  }

  @Delete('jobs/:id/tasks/:taskId')
  removeTask(@Param('id') id: string, @Param('taskId') taskId: string) {
    return this.jobs.removeTask(id, taskId);
  }
}
