import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * Liveness + readiness probes. PrismaService is provided by the @Global
 * PrismaModule, so this module only needs to register the controller.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
