import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { CampaignsService } from '../../campaigns/campaigns.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface CampaignsToolDeps {
  campaigns: CampaignsService;
}

/**
 * Campaign tools: two ungated reads (list / performance) and one
 * approval-gated status write. `jeeta.set_campaign_status` can start a real
 * send (launch/resume), so it is registered `requiresApproval: true` /
 * `approvalKind: 'PUBLISH'` — the broker enqueues a human approval instead of
 * running the handler inline unless the workspace's writeMode is AUTONOMOUS.
 */
export function registerCampaignsTools(registry: McpToolRegistry, deps: CampaignsToolDeps): void {
  registry.register({
    name: 'jeeta.list_campaigns',
    description: 'List campaigns in this workspace with their channel, status and last-known stats. Read-only.',
    scopes: ['campaigns.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => deps.campaigns.list(ctx.workspaceId),
  });

  registry.register({
    name: 'jeeta.get_campaign_performance',
    description:
      'Get the performance snapshot (recipients, sent/failed/skipped, opened/clicked/unsubscribed, and SMS delivery rollup) for one campaign by id. Read-only.',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      campaignId: z.string().min(1).describe('Campaign id to fetch performance for.'),
    }),
    handler: async (ctx, args) => deps.campaigns.performance(ctx.workspaceId, String(args.campaignId ?? '')),
  });

  registry.register({
    name: 'jeeta.set_campaign_status',
    description:
      'Change a campaign\'s status: SENDING launches a draft/scheduled campaign (or resumes a paused one), PAUSED pauses a sending campaign, CANCELLED cancels a scheduled (not-yet-sending) campaign. This reaches real customers, so in APPROVAL mode it is queued for a human instead of executing immediately.',
    scopes: ['campaigns.send'],
    risk: 'WRITE',
    requiresApproval: true,
    approvalKind: 'PUBLISH',
    inputSchema: z.object({
      campaignId: z.string().min(1).describe('Campaign id to transition.'),
      status: z
        .enum(['SENDING', 'PAUSED', 'CANCELLED'])
        .describe(
          'Target status. SENDING launches (DRAFT/SCHEDULED) or resumes (PAUSED); PAUSED pauses a SENDING campaign; CANCELLED cancels a SCHEDULED campaign.',
        ),
    }),
    handler: async (ctx, args) => {
      const campaignId = String(args.campaignId ?? '');
      const status = String(args.status ?? '');
      // CampaignsService has no generic "set status" write — status
      // transitions are each their own guarded method (launch/pause/resume/
      // cancel), so this tool dispatches to the right one rather than
      // forwarding through `update()` (which does not accept `status` at all).
      switch (status) {
        case 'PAUSED':
          return deps.campaigns.pause(ctx.workspaceId, campaignId);
        case 'CANCELLED':
          return deps.campaigns.cancel(ctx.workspaceId, campaignId);
        case 'SENDING': {
          const campaign = await deps.campaigns.get(ctx.workspaceId, campaignId);
          return campaign.status === 'PAUSED'
            ? deps.campaigns.resume(ctx.workspaceId, campaignId)
            : deps.campaigns.launch(ctx.workspaceId, campaignId);
        }
        default:
          throw new BadRequestException(`Unsupported target status: ${status}`);
      }
    },
  });
}
