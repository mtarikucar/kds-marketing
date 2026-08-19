import { Controller, Get, Patch, Post, Body, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { Audit } from '../../audit/audit.decorator';
import { MarketingAuthService } from '../services/marketing-auth.service';
import { CreateWorkspaceDto } from '../dto/create-workspace.dto';
import { SetMcpWriteModeDto } from '../dto/set-mcp-write-mode.dto';
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
 *
 * `MarketingRolesGuard`/`PermissionsGuard` are wired at the class level for
 * the mcp-write-mode routes below (each opts in explicitly with
 * `@MarketingRoles(...)`/`@RequirePermission(...)`); `create()` above declares
 * neither, so it stays open to ANY authenticated role exactly as before —
 * these guards no-op when a handler carries no role/permission metadata.
 */
@MarketingRoute()
@Controller('marketing/workspaces')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingWorkspacesController {
  constructor(private readonly authService: MarketingAuthService) {}

  @Post()
  // Each create provisions a full workspace scaffold and a free trial, so a
  // burst is expensive whether it is abuse or a stuck client retrying.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Audit({ action: 'workspace.create', resourceType: 'workspace' })
  create(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Body() dto: CreateWorkspaceDto,
  ) {
    return this.authService.createOwnedWorkspace(user.id, dto);
  }

  /**
   * MCP write-surface activation — read the current human-approval-gate mode
   * back so an operator can confirm it rather than guessing. OWNER-only: this
   * is workspace-level security posture, not a general settings read.
   *
   * `@MarketingRoles('OWNER')` — a SINGLE role, never co-listed. In this
   * codebase's hierarchical role guard, co-listing does NOT mean "any of
   * these roles" — it takes the HIGHEST-ranked role among the list as the
   * floor, so `@MarketingRoles('OWNER', 'MANAGER')` would ALSO restrict to
   * OWNER-only while reading as if MANAGER were admitted too. Listing just
   * 'OWNER' says exactly what it means.
   *
   * `@Audit`-logged too (fix round 1): a read of this security posture is
   * itself worth a trail — otherwise nobody can later tell who checked
   * whether the approval gate was on before something autonomous happened.
   */
  @Get('mcp-write-mode')
  @MarketingRoles('OWNER')
  @Audit({ action: 'workspace.mcp_write_mode.read', resourceType: 'workspace' })
  getMcpWriteMode(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.authService.getMcpWriteMode(user.workspaceId);
  }

  /**
   * MCP write-surface activation — the switch that lets a workspace opt out
   * of the human approval gate for MCP tool calls (Claude can then send
   * customer messages, publish content, and move ad budget with no human in
   * the loop). The most safety-sensitive endpoint in this plan:
   *  - OWNER-only via `@MarketingRoles('OWNER')` (see getMcpWriteMode above
   *    for why this must never be co-listed with a lower role).
   *  - `@Audit`-logged with an unambiguous action string.
   *  - Validated by `SetMcpWriteModeDto` (`@IsIn(['APPROVAL','AUTONOMOUS'])`)
   *    — anything else 400s via the global ValidationPipe before this runs.
   *  - The workspace is the CALLER'S OWN, taken from the authenticated
   *    principal (`@CurrentMarketingUser`) — never from the body or a path
   *    param, so no OWNER can flip another workspace's gate.
   */
  @Patch('mcp-write-mode')
  @MarketingRoles('OWNER')
  @RequirePermission('settings.manage')
  @Audit({
    action: 'workspace.mcp_write_mode.update',
    resourceType: 'workspace',
    captureBody: ['mode'],
  })
  setMcpWriteMode(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Body() dto: SetMcpWriteModeDto,
  ) {
    return this.authService.setMcpWriteMode(user.workspaceId, dto.mode);
  }
}
