import { Controller, Get, Patch, Post, Body, UseGuards } from '@nestjs/common';
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
import { SetResearchExecutionDto } from '../dto/set-research-execution.dto';
import { SetWorkspaceTimezoneDto } from '../dto/set-workspace-timezone.dto';
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

  /**
   * Which side drains the nightly research queue (SERVER | MCP).
   *
   * Same posture as the two routes above, and for a comparable reason: this
   * decides whether an unattended nightly job spends the PLATFORM's Anthropic
   * key or waits for the owner's own Claude. Flipping it to MCP without a
   * drainer on the other side silently stops research — so it is OWNER-only,
   * `@Audit`-logged, DTO-validated (`@IsIn(['SERVER','MCP'])`), and always the
   * CALLER'S OWN workspace from the authenticated principal, never the body.
   *
   * `@MarketingRoles('OWNER')` is listed alone — see getMcpWriteMode above for
   * why co-listing a lower role would silently widen nothing and read as if it
   * widened something.
   */
  @Get('research-execution')
  @MarketingRoles('OWNER')
  @Audit({ action: 'workspace.research_execution.read', resourceType: 'workspace' })
  getResearchExecution(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.authService.getResearchExecution(user.workspaceId);
  }

  @Patch('research-execution')
  @MarketingRoles('OWNER')
  @RequirePermission('settings.manage')
  @Audit({
    action: 'workspace.research_execution.update',
    resourceType: 'workspace',
    captureBody: ['mode'],
  })
  setResearchExecution(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Body() dto: SetResearchExecutionDto,
  ) {
    return this.authService.setResearchExecution(user.workspaceId, dto.mode);
  }

  /**
   * The workspace's IANA zone — what "today" means for this business.
   *
   * `Workspace.timezone` shipped with the first migration, defaulted to 'UTC',
   * and had exactly one writer in the entire codebase: agency.service's
   * createLocation, a path no self-serve customer ever walks. Meanwhile five
   * consumers read it as though it were a real answer — the dashboard
   * aggregates, the tasks list, sales targets, the daily-digest cron, and now
   * the Growth Studio rail on the client. Every one of them has been running a
   * Turkish workspace's day from 03:00 to 03:00. Signup now captures the
   * browser's zone, which repairs new workspaces; these two routes are how an
   * EXISTING one gets corrected, because until they existed nothing on the
   * platform could change the value at all.
   *
   * MANAGER rather than OWNER, and that difference from the two routes above is
   * deliberate. Those decide security posture — whether an unattended agent may
   * act without a human, and whose Anthropic key pays. This decides how dates
   * are bucketed on reports. It is operational configuration of the same weight
   * as the other things a MANAGER already owns, so it sits on the same
   * MANAGER + settings.manage floor the plan's other operational writes use.
   * (`MarketingRolesGuard` is hierarchical, so listing MANAGER alone admits
   * OWNER too — see getMcpWriteMode above for why co-listing them would say
   * something different from what it looks like it says.)
   *
   * Audited on both sides, for the same reason the mcp-write-mode read is: a
   * changed zone silently moves every historical day boundary the panel draws,
   * and "why did last Tuesday's numbers move?" is answerable only if the change
   * left a row. The workspace is always the CALLER'S OWN, from the
   * authenticated principal — never a body or path param.
   */
  @Get('timezone')
  @MarketingRoles('MANAGER')
  @Audit({ action: 'workspace.timezone.read', resourceType: 'workspace' })
  getWorkspaceTimezone(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.authService.getWorkspaceTimezone(user.workspaceId);
  }

  @Patch('timezone')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({
    action: 'workspace.timezone.update',
    resourceType: 'workspace',
    captureBody: ['timezone'],
  })
  setWorkspaceTimezone(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Body() dto: SetWorkspaceTimezoneDto,
  ) {
    return this.authService.setWorkspaceTimezone(user.workspaceId, dto.timezone);
  }
}
