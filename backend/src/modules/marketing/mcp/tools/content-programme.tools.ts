import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import {
  ContentProgrammeService,
  PER_WEEK_MAX,
  PROGRAMME_GOALS,
  WEEKLY_CREDIT_CAP_MAX,
  type UpdateProgrammeInput,
} from '../../content-programme/content-programme.service';
import { ProgrammeDashboardService } from '../../content-programme/programme-dashboard.service';
import { SlotEditorService } from '../../content-programme/slot-editor.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpPrincipalService } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface ContentProgrammeToolDeps {
  programmes: ContentProgrammeService;
  dashboard: ProgrammeDashboardService;
  editor: SlotEditorService;
  principals: McpPrincipalService;
  entitlements: EntitlementsService;
}

const PROGRAMME_ACTIONS = ['pause', 'resume'] as const;
const SLOT_ACTIONS = ['skip', 'regenerate'] as const;

/** The owner's settings, as the update route accepts them; bounds are the service's. */
const SETTINGS_SCHEMA = z
  .object({
    name: z.string().min(1).max(200).optional().describe('Display name.'),
    brief: z.string().min(1).max(8000).optional().describe('What the programme is about — product, audience, tone. Grounds every idea it plans.'),
    goal: z.enum(PROGRAMME_GOALS).optional().describe('What "working" means: ENGAGEMENT, VIEWS, SAVES_SHARES, LEADS, or the COMPOSITE blend.'),
    perWeek: z.number().int().min(1).max(PER_WEEK_MAX).optional().describe('Posts per week per account, at most one a day. Changes the calendar cadence too. An agent may LOWER it; raising it is done from the hub.'),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(PER_WEEK_MAX).optional().describe('Which weekdays carry the posts (0 = Sunday … 6 = Saturday, Turkey time); must list exactly perWeek days.'),
    weeklyCreditCap: z.number().int().min(50).max(WEEKLY_CREDIT_CAP_MAX).optional().describe('The most credits the programme may spend in one week; a slot that would cross it is deferred, not produced. An agent may LOWER it; raising it is done from the hub.'),
    explorationRate: z.number().min(0.05).max(0.5).optional().describe('Share of slots given to the least-tried types instead of the best-scoring ones (never zero, even when exploiting).'),
    maturityHours: z.number().int().min(24).max(168).optional().describe('How long after publishing a slot is measured.'),
    halfLifeDays: z.number().int().min(7).max(90).optional().describe('How fast old evidence fades from the type weights.'),
    editWindowHours: z.number().int().min(1).max(24).optional().describe('Until how many hours before publish a slot may still be edited.'),
    lookaheadDays: z.number().int().min(7).max(28).optional().describe('How far ahead the calendar is planned.'),
    planLeadHours: z.number().int().min(1).optional().describe('How many hours before publish the concept and storyboard are planned. Must exceed produceLeadHours.'),
    produceLeadHours: z.number().int().min(1).optional().describe('How many hours before publish the clips are bought.'),
    personaId: z.string().max(64).nullable().optional().describe('A VideoPersona to lock one face/product across every slot; null clears it.'),
  })
  .strict();

/**
 * İçerik Programı over MCP — three tools, and the shape of what they may do is
 * the point.
 *
 * The programme is the one thing in this catalogue that SPENDS ON ITS OWN:
 * once created it plans, storyboards, buys clips and publishes on a calendar
 * with no approval gate, inside `weeklyCreditCap`. So the chat is allowed to
 * READ it, to steer it (settings, pause/resume) and to rewrite a single slot
 * — but two doors stay hub-only on purpose:
 *
 *  - **create**: the moment autonomous spend starts is a person's decision at
 *    the panel, where the accounts, the cap and the brief are in front of them.
 *  - **kill**: terminal, sweeps the open calendar; an agent that can pause has
 *    every safety it needs, and a kill it cannot undo is not a safety.
 *
 * `requiresApproval: false` throughout, for the reason content-concepts.tools.ts
 * records at length: the approval executor answers the APPROVER's HTTP
 * response, not the agent's turn, so a gated read/steer tool would be unusable
 * from the one surface these exist for. What each tool costs is said plainly
 * in its description so the model knows even though nothing stops it.
 *
 * All three sit behind the `socialCampaigns` package feature, like the REST
 * controller and the campaign lane the programme publishes through.
 */
export function registerContentProgrammeTools(registry: McpToolRegistry, deps: ContentProgrammeToolDeps): void {
  registry.register({
    name: 'jeeta.get_content_programme',
    description:
      'The workspace\'s content programme — the autonomous typed-content loop — and its dashboard: phase (SEED/LEARN/EXPLOIT), status, kill switch, this week\'s credit spend against weeklyCreditCap, the next two weeks of calendar slots (each with its type, why it was chosen, the idea, the concept, its editable-until time and whether it can still be edited), every content type with its learned weight and planned share, the type×network learning table with the weights history, the region\'s trend signals ranked by brand fit, and the programme\'s last 30 "why" log lines. Returns programme: null when none exists — a programme is started from the Studio panel, not from here, because starting one begins AUTONOMOUS CREDIT SPEND: it plans, storyboards, buys clips and publishes on its own, without approvals, up to weeklyCreditCap per week. Read-only.',
    domain: 'content',
    // Deferred (spec §3): the advertised surface is at its ceiling; the chat
    // reaches this through find_tools -> call_tool.
    defer: true,
    scopes: ['campaigns.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'socialCampaigns');
      const programme = await deps.programmes.get(ctx.workspaceId);
      const dashboard = programme ? await deps.dashboard.dashboard(ctx.workspaceId, programme) : null;
      return { programme, dashboard };
    },
  });

  registry.register({
    name: 'jeeta.update_content_programme',
    description:
      'Steer the content programme: change its settings (brief, goal, posts per week, weeklyCreditCap, exploration rate, lead times, persona) and/or pause or resume it. The programme SPENDS CREDITS AUTONOMOUSLY while ACTIVE — every planned slot is storyboarded, its clips bought and published without an approval — bounded only by weeklyCreditCap. Lowering the cap or the weekly count lowers what it will spend; RAISING either is refused here — that is done from the Studio panel by a person. Pausing is the way to stop spend without losing the calendar (open slots wait; resume re-arms them, and skips only those whose publish time passed while paused). Settings take effect on the next slot the programme plans; a slot already produced is not re-bought. There is no kill here on purpose — the kill switch is terminal and sweeps the calendar, and lives only in the Studio panel. Pass settings, action, or both; an empty call is refused.',
    domain: 'content',
    defer: true,
    scopes: ['campaigns.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      programmeId: z.string().min(1).max(64).describe('The programme to steer (see jeeta.get_content_programme).'),
      action: z.enum(PROGRAMME_ACTIONS).optional().describe('pause stops planning, producing and publishing until resume; resume restarts them. Applied after settings when both are given.'),
      settings: SETTINGS_SCHEMA.optional().describe('The settings to change. Only the fields given are touched.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'socialCampaigns');
      const programmeId = String(args.programmeId);
      const settings = args.settings as UpdateProgrammeInput | undefined;
      const action = args.action as (typeof PROGRAMME_ACTIONS)[number] | undefined;
      const hasSettings = settings !== undefined && Object.keys(settings).length > 0;
      if (!hasSettings && !action) {
        throw new BadRequestException('Nothing to do: pass settings to change, an action (pause/resume), or both.');
      }
      let programme = await deps.programmes.getOrThrow(ctx.workspaceId, programmeId);
      // The two levers that SCALE autonomous spend only move down from here.
      // Create and kill are hub-only because they start and end the spend; a
      // cap an agent could raise would make that fence decorative — one
      // injected instruction in a lead note and the only money bound on the
      // autopilot is gone. Lowering is always safe and stays open.
      if (hasSettings) {
        const raisesCap = settings.weeklyCreditCap !== undefined && settings.weeklyCreditCap > programme.weeklyCreditCap;
        const raisesCadence = settings.perWeek !== undefined && settings.perWeek > programme.perWeek;
        if (raisesCap || raisesCadence) {
          throw new BadRequestException('Raising the weekly cap or the cadence is done from the hub, not by an agent');
        }
        programme = await deps.programmes.update(ctx.workspaceId, programmeId, settings);
      }
      if (action === 'pause') programme = await deps.programmes.pause(ctx.workspaceId, programmeId);
      if (action === 'resume') programme = await deps.programmes.resume(ctx.workspaceId, programmeId);
      return { programme };
    },
  });

  registry.register({
    name: 'jeeta.edit_content_slot',
    description:
      'Rewrite ONE calendar slot of the content programme before it is produced: change its content type, its idea text, or its publish time; or skip it; or regenerate it. Editing (type/idea/time) SPENDS NOTHING now — the slot is re-planned from the new words when its plan time comes, and it is only refused once the slot\'s edit window has closed (editableUntil, two hours before publish by default) or its clips are already being made. Skipping cancels a slot nothing has been bought for; it costs nothing. REGENERATE RE-BUYS: it discards the slot\'s concept and clips and produces it again from scratch, spending the clip credits a second time — use it only when the produced piece is wrong, not to tweak an idea (edit the idea instead). Answers the slot as the panel shows it, including whether it is still editable. Pass action, or one or more of contentTypeKey / idea / scheduledFor; an empty call is refused.',
    domain: 'content',
    defer: true,
    scopes: ['campaigns.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      slotId: z.string().min(1).max(64).describe('The slot to change (see jeeta.get_content_programme → dashboard.slots[].id).'),
      action: z.enum(SLOT_ACTIONS).optional().describe('skip cancels the slot (free); regenerate re-buys its clips (spends). When given, the edit fields are ignored.'),
      contentTypeKey: z.string().min(1).max(40).optional().describe('Switch the slot to this content type (see dashboard.types[].key). Recorded as an owner override, so the learner does not count it as its own choice.'),
      idea: z.string().min(1).max(8000).optional().describe('The idea text the planner is handed for this slot, in place of what the programme composed.'),
      scheduledFor: z.iso.datetime({ offset: true }).optional().describe('New publish time (ISO 8601). Must stay in the future and outside any other slot\'s time.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'socialCampaigns');
      // The signed-in human when there is one; the workspace's service
      // sentinel otherwise — the slot's "owner override" reason records who.
      const actorId = ctx.userId ?? (await deps.principals.resolve(ctx)).id;
      const slotId = String(args.slotId);
      const action = args.action as (typeof SLOT_ACTIONS)[number] | undefined;
      let slot;
      if (action === 'skip') {
        slot = await deps.editor.skipSlot(ctx.workspaceId, slotId, actorId);
      } else if (action === 'regenerate') {
        slot = await deps.editor.regenerateSlot(ctx.workspaceId, slotId, actorId);
      } else {
        const patch = {
          ...(args.contentTypeKey !== undefined ? { contentTypeKey: String(args.contentTypeKey) } : {}),
          ...(args.idea !== undefined ? { idea: String(args.idea) } : {}),
          ...(args.scheduledFor !== undefined ? { scheduledFor: new Date(String(args.scheduledFor)) } : {}),
        };
        if (Object.keys(patch).length === 0) {
          throw new BadRequestException('Nothing to do: pass an action (skip/regenerate) or at least one of contentTypeKey, idea, scheduledFor.');
        }
        slot = await deps.editor.updateSlot(ctx.workspaceId, slotId, patch, actorId);
      }
      return deps.dashboard.slotView(ctx.workspaceId, slot.programmeId, slot.id);
    },
  });
}
