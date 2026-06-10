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
  BadRequestException,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingTasksService } from '../services/marketing-tasks.service';
import { CreateTaskDto } from '../dto/create-task.dto';
import { UpdateTaskDto } from '../dto/update-task.dto';
import { TaskFilterDto } from '../dto/task-filter.dto';
import { MarketingUserPayload } from '../types';

@MarketingRoute()
@Controller('marketing/tasks')
@UseGuards(MarketingGuard, MarketingRolesGuard)
export class MarketingTasksController {
  constructor(private readonly tasksService: MarketingTasksService) {}

  @Post()
  create(@Body() dto: CreateTaskDto, @CurrentMarketingUser() user: MarketingUserPayload) {
    return this.tasksService.create(user.workspaceId, dto, user.id);
  }

  @Get()
  findAll(@Query() filter: TaskFilterDto, @CurrentMarketingUser() user: MarketingUserPayload) {
    return this.tasksService.findAll(user.workspaceId, filter, user.id, user.role);
  }

  @Get('today')
  findToday(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.tasksService.findToday(user.workspaceId, user.id, user.role);
  }

  @Get('overdue')
  findOverdue(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.tasksService.findOverdue(user.workspaceId, user.id, user.role);
  }

  @Get('calendar')
  findCalendar(
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    if (!dateFrom || !dateTo || isNaN(Date.parse(dateFrom)) || isNaN(Date.parse(dateTo))) {
      throw new BadRequestException('Valid dateFrom and dateTo query parameters are required');
    }
    return this.tasksService.findCalendar(user.workspaceId, dateFrom, dateTo, user.id, user.role);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentMarketingUser() user: MarketingUserPayload) {
    return this.tasksService.findOne(user.workspaceId, id, user.id, user.role);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.tasksService.update(user.workspaceId, id, dto, user.id, user.role);
  }

  @Patch(':id/complete')
  complete(@Param('id') id: string, @CurrentMarketingUser() user: MarketingUserPayload) {
    return this.tasksService.complete(user.workspaceId, id, user.id, user.role);
  }

  @Delete(':id')
  @MarketingRoles('MANAGER')
  delete(@Param('id') id: string, @CurrentMarketingUser() user: MarketingUserPayload) {
    return this.tasksService.delete(user.workspaceId, id, user.id, user.role);
  }
}
