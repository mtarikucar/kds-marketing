import { Module, OnModuleInit } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RoutineConfigService } from './routine-config.service';
import { RoutineTriggerService } from './routine-trigger.service';
import { RoutineScheduleRunner } from './routine-schedule-runner.service';
import { RoutineEventListener } from './routine-event-listener.service';

/**
 * RoutinesModule — backbone for the routine trigger + schedule layer.
 *
 * Provides and exports all four routine services.
 *
 * Circular wiring: RoutineConfigService ↔ RoutineScheduleRunner share a
 * reload() call after every config update. To avoid a DI circular dep,
 * the module itself wires the runner into the config service after both
 * are constructed, via the `setScheduleRunner` setter.
 *
 * PrismaModule is @Global so no explicit import needed.
 * ConfigModule is @Global so no explicit import needed.
 * OutboxModule is @Global so DomainEventBus is injectable without importing.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [
    RoutineConfigService,
    RoutineTriggerService,
    RoutineScheduleRunner,
    RoutineEventListener,
  ],
  exports: [
    RoutineConfigService,
    RoutineTriggerService,
    RoutineScheduleRunner,
    RoutineEventListener,
  ],
})
export class RoutinesModule implements OnModuleInit {
  constructor(
    private readonly routineConfigService: RoutineConfigService,
    private readonly routineScheduleRunner: RoutineScheduleRunner,
  ) {}

  onModuleInit(): void {
    // Break the circular dep by wiring after construction.
    this.routineConfigService.setScheduleRunner(this.routineScheduleRunner);
  }
}
