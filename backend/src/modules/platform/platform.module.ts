import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { BillingModule } from '../billing/billing.module';
import { RoutinesModule } from '../routines/routines.module';
import { PlatformAuthController } from './controllers/platform-auth.controller';
import { WorkspacesAdminController } from './controllers/workspaces-admin.controller';
import { PaymentsAdminController } from './controllers/payments-admin.controller';
import { RoutineAdminController } from './controllers/routine-admin.controller';
import { PlatformAuthService } from './services/platform-auth.service';
import { WorkspacesAdminService } from './services/workspaces-admin.service';
import { PlatformGuard } from './guards/platform.guard';

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
    RoutineAdminController,
  ],
  providers: [PlatformAuthService, WorkspacesAdminService, PlatformGuard],
})
export class PlatformModule {}
