import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PlatformAuthController } from './controllers/platform-auth.controller';
import { WorkspacesAdminController } from './controllers/workspaces-admin.controller';
import { PlatformAuthService } from './services/platform-auth.service';
import { WorkspacesAdminService } from './services/workspaces-admin.service';
import { PlatformGuard } from './guards/platform.guard';

/**
 * Platform (superadmin) realm: operator auth + cross-workspace
 * administration. Token realm is PLATFORM_JWT_SECRET — distinct from the
 * marketing-user realm and the internal service token. Payments admin
 * (manual bank-transfer approval) joins this module in Phase F.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [PlatformAuthController, WorkspacesAdminController],
  providers: [PlatformAuthService, WorkspacesAdminService, PlatformGuard],
})
export class PlatformModule {}
