import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import {
  CreateOpportunityDto,
  MoveOpportunityDto,
  OpportunityFilterDto,
  UpdateOpportunityDto,
} from '../../dto/opportunity.dto';
import { OpportunitiesService } from '../../opportunities/opportunities.service';
import { PipelinesService } from '../../opportunities/pipelines.service';
import { McpPrincipalService } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface PipelineToolDeps {
  opportunities: OpportunitiesService;
  pipelines: PipelinesService;
  principals: McpPrincipalService;
}

const CURRENCIES = ['TRY', 'USD', 'EUR'] as const;
const OPPORTUNITY_STATUSES = ['OPEN', 'WON', 'LOST', 'ABANDONED'] as const;

/**
 * Faz 5 D1 — the deal pipeline (opportunities + their stages).
 *
 * ## Principal
 * `OpportunitiesService` takes a whole `MarketingUserPayload`, not a
 * `(userId, userRole)` pair, and reads both `.role` (REP row-level narrowing)
 * and `.id`. Synthesising a payload around the read-only placeholder id would
 * work only for as long as the service never reads another field, so every
 * tool here — reads included — resolves a real, workspace-local user through
 * `McpPrincipalService.resolve()` instead.
 *
 * ## Stages are rows, not an enum
 * A stage is a `PipelineStage` uuid belonging to a specific pipeline, and
 * `move()` refuses a stage from a different pipeline. A model has no way to
 * guess those ids, so `jeeta.list_pipelines` exposes the workspace's pipelines
 * with their ordered stages, and `move_opportunity_stage` additionally accepts
 * a case-insensitive stage NAME which it resolves against the opportunity's OWN
 * pipeline. The resolution is a lookup, never a guess: an unmatched name is a
 * hard error listing the valid stages, because silently landing a deal on the
 * wrong stage can flip it to WON/LOST (terminal stages carry `isWon`/`isLost`)
 * and fire the won/lost automations.
 *
 * Won/lost/abandon and deletion are deliberately absent from D1 — `move` to a
 * terminal stage already covers the legitimate case, and delete is DESTRUCTIVE
 * (spec §4), which is out of scope for this wave.
 */
export function registerPipelineTools(registry: McpToolRegistry, deps: PipelineToolDeps): void {
  registry.register({
    name: 'jeeta.list_pipelines',
    description:
      'List this workspace\'s deal pipelines with their ordered stages (id, name, probability, won/lost flags). Use it to find the stage id jeeta.move_opportunity_stage needs. Read-only.',
    domain: 'pipeline',
    // Deferred (spec §3): Structural lookup — jeeta.list_opportunities is the primary pipeline read.
    defer: true,
    scopes: ['leads.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => deps.pipelines.list(ctx.workspaceId),
  });

  registry.register({
    name: 'jeeta.list_opportunities',
    description:
      'List deals/opportunities in this workspace — filter by pipeline, stage, status, owner, related lead or name. Read-only.',
    domain: 'pipeline',
    scopes: ['leads.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      pipelineId: z.string().optional().describe('Restrict to one pipeline.'),
      stageId: z.string().optional().describe('Restrict to one stage.'),
      status: z.enum(OPPORTUNITY_STATUSES).optional().describe('Deal status filter.'),
      assignedToId: z.string().optional().describe('Only deals owned by this user id.'),
      leadId: z.string().optional().describe('Only deals attached to this lead.'),
      search: z.string().max(120).optional().describe('Case-insensitive match against the deal name.'),
      page: z.number().int().min(1).optional().describe('Page number, 1-based (default 1).'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size, max 100 (default 20).'),
    }),
    handler: async (ctx, args) => {
      const actor = await deps.principals.resolve(ctx);
      return deps.opportunities.list(ctx.workspaceId, args as unknown as OpportunityFilterDto, actor);
    },
  });

  registry.register({
    name: 'jeeta.create_opportunity',
    description:
      'Create a deal/opportunity. Defaults to the workspace default pipeline and its first stage when pipelineId/stageId are omitted. Optionally attach it to a lead.',
    domain: 'pipeline',
    scopes: ['leads.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      name: z.string().min(1).max(160).describe('Deal name.'),
      pipelineId: z.string().optional().describe('Pipeline to create the deal in. Defaults to the workspace default.'),
      stageId: z.string().optional().describe('Starting stage. Defaults to the first stage of the pipeline.'),
      leadId: z.string().optional().describe('Lead this deal belongs to.'),
      assignedToId: z.string().optional().describe('User who should own the deal. Must be an active member.'),
      value: z.number().min(0).optional().describe('Deal value.'),
      currency: z.enum(CURRENCIES).optional().describe('Deal currency. Defaults to TRY.'),
      source: z.string().max(40).optional().describe('Where the deal came from.'),
      notes: z.string().max(4000).optional().describe('Free-text notes.'),
      expectedCloseDate: z.string().optional().describe('Expected close date, ISO 8601.'),
    }),
    handler: async (ctx, args) => {
      const actor = await deps.principals.resolve(ctx);
      if (typeof args.assignedToId === 'string' && args.assignedToId.length > 0) {
        await deps.principals.assertActiveMember(ctx.workspaceId, args.assignedToId);
      }
      return deps.opportunities.create(ctx.workspaceId, args as unknown as CreateOpportunityDto, actor);
    },
  });

  registry.register({
    name: 'jeeta.update_opportunity',
    description:
      "Change a deal's details — name, value, currency, notes, owner, expected close date, or the lead it belongs to. Use jeeta.move_opportunity_stage to change its STAGE; this tool does not move deals.",
    domain: 'pipeline',
    // Deferred: correcting a deal's fields is occasional. The primary pipeline
    // writes (create, move) stay advertised.
    defer: true,
    scopes: ['leads.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      opportunityId: z.string().min(1).describe('Id of the deal to update.'),
      name: z.string().min(1).max(160).optional().describe('Deal name.'),
      value: z.number().min(0).optional().describe('Deal value, in the deal currency.'),
      currency: z.enum(['TRY', 'USD', 'EUR']).optional().describe('Currency code.'),
      source: z.string().max(40).optional().describe('Where the deal came from.'),
      notes: z.string().max(4000).optional().describe('Free-text notes.'),
      assignedToId: z.string().optional().describe('Id of the rep who owns the deal.'),
      leadId: z.string().optional().describe('Id of the lead this deal belongs to.'),
      expectedCloseDate: z
        .string()
        .nullable()
        .optional()
        .describe('Expected close date, ISO 8601. Pass null to clear it.'),
    }),
    handler: async (ctx, args) => {
      const actor = await deps.principals.resolve(ctx);
      if (typeof args.assignedToId === 'string' && args.assignedToId.length > 0) {
        await deps.principals.assertActiveMember(ctx.workspaceId, args.assignedToId);
      }
      const { opportunityId, ...patch } = args as { opportunityId: string } & Record<string, unknown>;
      return deps.opportunities.update(
        ctx.workspaceId,
        String(opportunityId),
        patch as unknown as UpdateOpportunityDto,
        actor,
      );
    },
  });

  registry.register({
    name: 'jeeta.delete_opportunity',
    description:
      'Permanently delete a deal. There is no undo and no archive — prefer moving it to a lost stage with jeeta.move_opportunity_stage, which keeps the history and the reason. Use this only for a deal that should never have existed, such as a duplicate or a test row.',
    domain: 'pipeline',
    defer: true,
    scopes: ['leads.manage'],
    // DESTRUCTIVE is the one risk class the broker gates in EVERY write mode,
    // AUTONOMOUS included: a deleted row has no undo table and no balance to
    // bound it. An agent may propose this; only a human completes it.
    risk: 'DESTRUCTIVE',
    requiresApproval: true,
    approvalKind: 'DESTRUCTIVE',
    resourceType: 'opportunity',
    resourceIdFrom: (args) =>
      typeof args.opportunityId === 'string' ? args.opportunityId : undefined,
    inputSchema: z.object({
      opportunityId: z.string().min(1).describe('Id of the deal to delete permanently.'),
    }),
    handler: async (ctx, args) => {
      const actor = await deps.principals.resolve(ctx);
      return deps.opportunities.remove(ctx.workspaceId, String(args.opportunityId), actor);
    },
  });

  registry.register({
    name: 'jeeta.move_opportunity_stage',
    description:
      "Move a deal to another stage of its own pipeline, by stage id or by stage name. Landing on a won or lost stage closes the deal and fires the matching automations. Call jeeta.list_pipelines first if you do not know the stages.",
    domain: 'pipeline',
    scopes: ['leads.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      opportunityId: z.string().min(1).describe('Id of the deal to move.'),
      stageId: z.string().optional().describe('Target stage id. Must belong to the deal\'s pipeline.'),
      stageName: z
        .string()
        .optional()
        .describe('Target stage name (case-insensitive), resolved against the deal\'s own pipeline. Use instead of stageId.'),
      position: z.number().int().min(0).optional().describe('Position within the target stage column.'),
    }),
    handler: async (ctx, args) => {
      const actor = await deps.principals.resolve(ctx);
      const opportunityId = String(args.opportunityId);
      const byId = typeof args.stageId === 'string' && args.stageId.length > 0 ? args.stageId : undefined;
      const byName = typeof args.stageName === 'string' && args.stageName.length > 0 ? args.stageName : undefined;
      if (!byId === !byName) {
        throw new BadRequestException('provide exactly one of stageId or stageName');
      }

      let stageId = byId;
      if (byName) {
        // Scoped read first: `get` is the workspace+REP-scoped accessor, so an
        // opportunity from another workspace is a 404 before any name lookup.
        const opp = await deps.opportunities.get(ctx.workspaceId, opportunityId, actor);
        const pipeline = await deps.pipelines.get(ctx.workspaceId, opp.pipelineId);
        const match = pipeline.stages.find(
          (s: { name: string }) => s.name.trim().toLowerCase() === byName.trim().toLowerCase(),
        );
        if (!match) {
          // Never fall back to "closest" or "first" — a wrong stage can flip
          // the deal to WON/LOST and fire the won/lost automations.
          throw new BadRequestException(
            `no stage named "${byName}" in this pipeline. Available: ${pipeline.stages
              .map((s: { name: string }) => s.name)
              .join(', ')}`,
          );
        }
        stageId = match.id;
      }

      return deps.opportunities.move(
        ctx.workspaceId,
        opportunityId,
        {
          stageId: String(stageId),
          position: typeof args.position === 'number' ? args.position : undefined,
        } as MoveOpportunityDto,
        actor,
      );
    },
  });
}
