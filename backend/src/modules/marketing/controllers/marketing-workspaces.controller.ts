import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { Audit } from '../../audit/audit.decorator';
import { MarketingAuthService } from '../services/marketing-auth.service';
import { CreateWorkspaceDto } from '../dto/create-workspace.dto';
import { MarketingUserPayload } from '../types';

/**
 * Multi-workspace membership — F1: self-serve second-workspace creation.
 * `@MarketingGuard` only (no `MarketingRolesGuard`/`PermissionsGuard`,
 * no `@RequirePermission`): ANY authenticated identity, in ANY role, on ANY
 * workspace, may spin up a brand-new STANDALONE workspace and become its
 * OWNER there. This mints an entirely NEW workspace + membership — it never
 * touches the caller's CURRENT workspace and never consumes a seat in it, so
 * none of MarketingUsersController's OWNER/MANAGER seat-gated invite/create
 * posture applies here.
 */
@MarketingRoute()
@Controller('marketing/workspaces')
@UseGuards(MarketingGuard)
export class MarketingWorkspacesController {
  constructor(private readonly authService: MarketingAuthService) {}

  @Post()
  @Audit({ action: 'workspace.create', resourceType: 'workspace' })
  create(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Body() dto: CreateWorkspaceDto,
  ) {
    return this.authService.createOwnedWorkspace(user.id, dto);
  }
}
