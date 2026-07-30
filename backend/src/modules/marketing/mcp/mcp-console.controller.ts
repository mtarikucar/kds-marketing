import { Controller, Delete, Get, Param, Query, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { Audit } from '../../audit/audit.decorator';
import { MarketingUserPayload } from '../types';
import { McpConsoleService } from './mcp-console.service';

/**
 * Faz 4 — the connector management console.
 *
 * Gated at MANAGER for the class, mirroring `MarketingApiKeysController`: this
 * is the same kind of surface (credentials that grant external access to
 * workspace data), so a REP has no business reading it. The one MUTATION —
 * disconnecting a client — additionally demands `settings.manage` and is
 * `@Audit`-logged.
 *
 * Every handler takes its workspace from the authenticated principal
 * (`@CurrentMarketingUser`), never from a body or a path param, so no caller
 * can aim the console at someone else's tenant.
 */
@MarketingRoute()
@Controller('marketing/mcp-console')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class McpConsoleController {
  constructor(private readonly svc: McpConsoleService) {}

  /**
   * MCP session list — one `AgentRun(agent: 'mcp')` per row, newest first.
   *
   * `page`/`pageSize` are forwarded RAW: the cap and the NaN coercion live in
   * the service (`safePage`/`safeLimit`), so the public-API path and any other
   * caller get the same ceiling rather than one enforced only at this edge.
   */
  @Get('sessions')
  sessions(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.listSessions(user.workspaceId, page, pageSize);
  }

  /** One session with its tool-call audit rows (payload blobs summarised only). */
  @Get('sessions/:id')
  session(@Param('id') id: string, @CurrentMarketingUser() user: MarketingUserPayload) {
    return this.svc.getSession(user.workspaceId, id);
  }

  /** Connected Claude.ai/Desktop connectors + the workspace's live MCP API keys. */
  @Get('connections')
  connections(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.svc.listConnections(user.workspaceId);
  }

  /**
   * Disconnect one OAuth client: revoke every live token it holds HERE.
   *
   * `:clientId` is a CIMD `client_id` — an https URL — so the caller must
   * `encodeURIComponent` it (the `%2F`-encoded slashes still match a single
   * path segment, and Express decodes the param back for us).
   */
  @Delete('connections/oauth/:clientId')
  @RequirePermission('settings.manage')
  @Audit({
    action: 'mcp.connection.revoke',
    resourceType: 'mcp-oauth-client',
    resourceIdParam: 'clientId',
  })
  revokeOAuthConnection(
    @Param('clientId') clientId: string,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.svc.revokeOAuthClient(user.workspaceId, clientId);
  }
}
