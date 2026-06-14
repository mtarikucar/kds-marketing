import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CronJob } from 'cron';
import { PlatformGuard } from '../guards/platform.guard';
import { Audit } from '../../audit/audit.decorator';
import { RoutineConfigService } from '../../routines/routine-config.service';
import { RoutineTriggerService } from '../../routines/routine-trigger.service';
import { UpdateRoutineConfigDto } from '../dto/update-routine-config.dto';

/**
 * Platform (superadmin) API for managing cloud routine configs.
 *
 * GET  /platform/routines           — list all 4 configs (no tokens; hasToken flag).
 * POST /platform/routines/:key/trigger — manually fire a routine.
 * PATCH /platform/routines/:key     — update config (cron / enabled / onEvent / urls / token).
 *
 * Cron validation happens here (before saving) so the DB never holds a string
 * that would crash `RoutineScheduleRunner.registerJob()` at boot.
 */
@Controller('platform/routines')
@UseGuards(PlatformGuard)
export class RoutineAdminController {
  constructor(
    private readonly routineConfigService: RoutineConfigService,
    private readonly routineTriggerService: RoutineTriggerService,
  ) {}

  @Get()
  list() {
    return this.routineConfigService.list();
  }

  @Post(':key/trigger')
  @Audit({
    action: 'routine.trigger.manual',
    resourceType: 'routine',
    resourceIdParam: 'key',
  })
  triggerNow(@Param('key') key: string) {
    return this.routineTriggerService.trigger(key, 'manual');
  }

  @Patch(':key')
  @Audit({
    action: 'routine.config.update',
    resourceType: 'routine',
    resourceIdParam: 'key',
    captureBody: ['enabled', 'cron', 'onEvent'],
  })
  async update(@Param('key') key: string, @Body() dto: UpdateRoutineConfigDto) {
    // Validate cron expression before persisting it.
    if (dto.cron !== undefined && dto.cron !== null) {
      try {
        // CronJob constructor throws on invalid expression.
        new CronJob(dto.cron, () => { /* validation only */ });
      } catch {
        throw new BadRequestException(
          `Invalid cron expression: "${dto.cron}". Use a standard 5-field cron (e.g. "0 * * * *").`,
        );
      }
    }

    return this.routineConfigService.update(key, dto);
  }
}
