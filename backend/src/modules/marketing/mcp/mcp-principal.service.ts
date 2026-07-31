import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import type { MarketingUserPayload } from '../types';
import type { McpToolContext } from './mcp-tool-registry';

/**
 * The READ-ONLY placeholder principal (Faz 1-3).
 *
 * `MarketingLeadsService.findAll` (and the task/opportunity list equivalents)
 * take a `(userId, userRole)` principal purely to apply row-level visibility:
 * `userRole` is compared only against `'REP'`, and every other value falls
 * through the same branch. An API-key session has no user by construction —
 * the key belongs to a workspace, not a person — so rather than silently
 * borrowing an identity that path passes this explicit, named placeholder,
 * named for exactly what it grants and no more:
 *
 * - `'MANAGER'` here is not an authority grant, it is just "not REP". Using
 *   `'REP'` would pin visibility to `assignedToId === MCP_NON_REP_PRINCIPAL.userId`,
 *   a synthetic id that owns no rows, so the tool would return zero rows.
 * - The synthetic `userId` is read-only for that call path: it only ever
 *   reaches a `where` clause. It must NEVER reach a column that writes,
 *   assigns or attributes a row — see `MCP_ATTRIBUTION_PRINCIPAL_ROLE`.
 * - Tenant isolation does not depend on it: every service scopes by
 *   `workspaceId` unconditionally, and no role value widens that.
 */
export const MCP_NON_REP_PRINCIPAL = { userId: 'mcp-service-principal', role: 'MANAGER' } as const;

/**
 * The WRITE (attribution) principal for a session with no human behind it.
 *
 * D1's writes land in columns that are real, non-null foreign keys with
 * `onDelete: Restrict` — `LeadActivity.createdById` (note/status-change/
 * assignment timeline rows) and `MarketingTask.assignedToId`. Handing those the
 * synthetic `MCP_NON_REP_PRINCIPAL.userId` would not "attribute to a service
 * account", it would fail the FK at write time. So an API-key session resolves
 * the workspace's EXISTING research sentinel — the per-workspace `SYSTEM` user
 * `MarketingAuthService.createResearchSentinel()` mints with every workspace,
 * already used for exactly this purpose by the lead-ingest, public-form,
 * Meta lead-ads and telephony lanes.
 *
 * Reusing it rather than inventing an MCP-specific principal is deliberate:
 * it is a real row (FKs hold), it is workspace-local (no cross-tenant reach),
 * it is refused by login/refresh/the marketing guard so it can never be used
 * to authenticate, and it is not `'REP'` so it does not narrow row-level
 * visibility to rows it does not own. Timeline entries an agent creates are
 * therefore attributable to the workspace's automation identity instead of
 * being falsely stamped with a human's name.
 */
export const MCP_ATTRIBUTION_PRINCIPAL_ROLE = 'SYSTEM' as const;

const PRINCIPAL_SELECT = {
  id: true,
  workspaceId: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  status: true,
  customRoleId: true,
} as const;

/**
 * The read-only visibility principal for a call: the real caller when the
 * session is user-bound (OAuth, Faz 3), the declared placeholder otherwise.
 *
 * The two halves are paired deliberately and must not be mixed: a real user is
 * judged by their REAL role (a REP's list narrows to their own rows), and the
 * placeholder id must keep the placeholder's "not REP" role or it matches
 * nothing at all.
 */
export function visibilityPrincipal(ctx: McpToolContext): { userId: string; role: string } {
  if (ctx.userId) {
    return { userId: ctx.userId, role: ctx.userRole ? ctx.userRole : MCP_NON_REP_PRINCIPAL.role };
  }
  return { userId: MCP_NON_REP_PRINCIPAL.userId, role: MCP_NON_REP_PRINCIPAL.role };
}

/**
 * Resolves the principal a WRITE is attributed to, and validates assignment
 * targets. Every query here pins `workspaceId`, so no tool built on it can
 * attribute a row to, or assign work to, a user from another tenant.
 */
@Injectable()
export class McpPrincipalService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The actor a write is performed as. On an OAuth session this is the human
   * who consented, re-checked against their ACTIVE membership of THIS
   * workspace on every call (a removal since consent is a refusal, matching
   * `McpInvokerService.roleFor`). On an API-key session it is the workspace's
   * automation principal — see `MCP_ATTRIBUTION_PRINCIPAL_ROLE`.
   */
  async resolve(ctx: McpToolContext): Promise<MarketingUserPayload> {
    if (ctx.userId) {
      const user = await this.prisma.marketingUser.findFirst({
        where: { id: ctx.userId, workspaceId: ctx.workspaceId, status: 'ACTIVE' },
        select: PRINCIPAL_SELECT,
      });
      if (!user) {
        throw new ForbiddenException(
          'the authorizing user is no longer an active member of this workspace',
        );
      }
      // The invoker resolved the role from the live membership moments ago;
      // prefer it so a demotion mid-session bites on the very next call.
      return { ...user, role: ctx.userRole ?? user.role };
    }

    const sentinel = await this.prisma.marketingUser.findFirst({
      where: { workspaceId: ctx.workspaceId, role: MCP_ATTRIBUTION_PRINCIPAL_ROLE },
      select: PRINCIPAL_SELECT,
    });
    if (!sentinel) {
      // Refuse rather than invent an id: a fabricated id would either violate
      // the FK or, worse, collide with a real user in some other workspace.
      throw new InternalServerErrorException(
        'automation principal missing for workspace — run the platform seed before using MCP write tools',
      );
    }
    return sentinel;
  }

  /**
   * Assignment guard: the target must be an ACTIVE member of the CALLER's
   * workspace and an identity that can actually act on the work. The
   * automation principal is excluded — it can never authenticate, so work
   * parked on it is work nobody will ever see.
   */
  async assertActiveMember(
    workspaceId: string,
    userId: string,
  ): Promise<{ id: string; role: string; status: string; firstName: string; lastName: string }> {
    const member = await this.prisma.marketingUser.findFirst({
      where: { id: userId, workspaceId, status: 'ACTIVE' },
      select: { id: true, role: true, status: true, firstName: true, lastName: true },
    });
    if (!member) {
      throw new BadRequestException(`user ${userId} is not an active member of this workspace`);
    }
    if (member.role === MCP_ATTRIBUTION_PRINCIPAL_ROLE) {
      throw new BadRequestException(
        `user ${userId} is the workspace automation principal and cannot be assigned work`,
      );
    }
    return member;
  }
}
