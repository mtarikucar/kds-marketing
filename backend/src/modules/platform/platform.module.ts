import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { BillingModule } from '../billing/billing.module';
import { RoutinesModule } from '../routines/routines.module';
import { PlatformAuthController } from './controllers/platform-auth.controller';
import { WorkspacesAdminController } from './controllers/workspaces-admin.controller';
import { PaymentsAdminController } from './controllers/payments-admin.controller';
import { PackagesAdminController } from './controllers/packages-admin.controller';
import { RoutineAdminController } from './controllers/routine-admin.controller';
import { AiCostsAdminController } from './controllers/ai-costs-admin.controller';
import { PlatformAuthService } from './services/platform-auth.service';
import { WorkspacesAdminService } from './services/workspaces-admin.service';
import { PlatformGuard } from './guards/platform.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { AiUsageStatsService } from '../marketing/ai/ai-usage-stats.service';
import { PlatformAiSpendService } from '../marketing/ai/platform-ai-spend.service';

/**
 * Platform (superadmin) realm: operator auth + cross-workspace
 * administration. Token realm is PLATFORM_JWT_SECRET — distinct from the
 * marketing-user realm and the internal service token. Payments admin
 * (manual bank-transfer approval) joins this module in Phase F.
 *
 * RoutinesModule imported here to inject RoutineConfigService +
 * RoutineTriggerService into RoutineAdminController.
 */
@Module({
  imports: [JwtModule.register({}), BillingModule, RoutinesModule],
  controllers: [
    PlatformAuthController,
    WorkspacesAdminController,
    PaymentsAdminController,
    PackagesAdminController,
    RoutineAdminController,
    AiCostsAdminController,
  ],
  providers: [
    PlatformAuthService,
    WorkspacesAdminService,
    PlatformGuard,
    // Cost reporting reads AiUsageLog directly and holds no marketing state,
    // so it is provided here rather than importing the whole MarketingModule
    // (which would pull the entire tenant surface into the operator realm).
    PrismaService,
    AiUsageStatsService,
    PlatformAiSpendService,
  ],
})
export class PlatformModule {}
