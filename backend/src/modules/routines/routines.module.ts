import { Module } from '@nestjs/common';
import { RoutineConfigService } from './routine-config.service';
import { RoutineTriggerService } from './routine-trigger.service';

/**
 * RoutinesModule — backbone for the routine trigger + schedule layer.
 *
 * Provides and exports RoutineConfigService and RoutineTriggerService.
 *
 * Backend-B additions (NOT in this commit):
 *   - RoutineScheduleRunner (dynamic CronJob management)
 *   - RoutineEventListener  (DomainEventBus subscriptions)
 *   - RoutineAdminController (platform endpoints)
 *
 * PrismaModule is @Global so no explicit import needed.
 * ConfigModule is @Global so no explicit import needed.
 */
@Module({
  providers: [RoutineConfigService, RoutineTriggerService],
  exports: [RoutineConfigService, RoutineTriggerService],
})
export class RoutinesModule {}
