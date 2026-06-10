import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { MarketingModule } from './modules/marketing/marketing.module';
import { PlatformModule } from './modules/platform/platform.module';
import { ProvisioningClientModule } from './core-client/provisioning-client.module';
import { InternalApiModule } from './modules/internal/internal.module';

/**
 * Standalone marketing service composition root (Phase-5 physical split).
 *
 *   - PrismaModule        → the marketing database (marketing-owned tables only)
 *   - OutboxModule        → durable eventing (outbox_events + in-process bus)
 *   - MarketingModule     → the bounded context, copied unchanged from the monorepo
 *   - ProvisioningClientModule → binds CORE_PROVISIONING_PORT to the HTTP client
 *     (core at CORE_SERVICE_URL) and REFERRAL_DIRECTORY_PORT to the local impl
 *   - InternalApiModule   → /api/internal/* surface core calls into
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    // Single root-level scheduler (MarketingSchedulerService crons).
    ScheduleModule.forRoot(),
    // Same global rate-limit envelope as the source app; @Throttle overrides
    // on the auth + ingest controllers keep their tighter limits.
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 300,
      },
    ]),
    PrismaModule,
    // @Global: EmailService (marketing tenant-welcome email).
    CommonModule,
    OutboxModule,
    ProvisioningClientModule,
    MarketingModule,
    // Platform (superadmin) realm: operator auth + workspace administration.
    PlatformModule,
    InternalApiModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
