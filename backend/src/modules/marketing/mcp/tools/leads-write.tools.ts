import { z } from 'zod';
import { CreateActivityDto } from '../../dto/create-activity.dto';
import { BUSINESS_TYPE_PATTERN, CreateLeadDto, LeadPriority, LeadSource } from '../../dto/create-lead.dto';
import { UpdateLeadDto } from '../../dto/update-lead.dto';
import { LeadDedupeService } from '../../services/lead-dedupe.service';
import { MarketingActivitiesService } from '../../services/marketing-activities.service';
import { MarketingLeadsService } from '../../services/marketing-leads.service';
import { McpPrincipalService } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface LeadsWriteToolDeps {
  leads: MarketingLeadsService;
  activities: MarketingActivitiesService;
  principals: McpPrincipalService;
  /** Duplicate clustering + merge — see `jeeta.list_duplicate_leads`. */
  dedupe: LeadDedupeService;
}

/** The stages `updateStatus` accepts. WON is absent on purpose — see below. */
const SETTABLE_STATUSES = [
  'NEW',
  'CONTACTED',
  'NOT_REACHABLE',
  'MEETING_DONE',
  'DEMO_SCHEDULED',
  'OFFER_SENT',
  'WAITING',
  'LOST',
] as const;

const ACTIVITY_TYPES = ['NOTE', 'CALL', 'VISIT', 'EMAIL', 'WHATSAPP', 'DEMO', 'MEETING'] as const;
const ACTIVITY_OUTCOMES = ['POSITIVE', 'NEGATIVE', 'NEUTRAL', 'NO_ANSWER'] as const;

const LEAD_SOURCES = Object.values(LeadSource) as [string, ...string[]];
const LEAD_PRIORITIES = Object.values(LeadPriority) as [string, ...string[]];

/** The lead columns a caller may set — shared by create (required core) and update. */
const leadBodyShape = {
  phone: z.string().max(20).optional().describe('Primary phone number.'),
  whatsapp: z.string().max(20).optional().describe('WhatsApp number, if different from phone.'),
  email: z.string().email().optional().describe('Contact email. Used for duplicate detection.'),
  address: z.string().max(255).optional().describe('Street address.'),
  city: z.string().max(120).optional().describe('City.'),
  region: z.string().max(120).optional().describe('Region / province.'),
  tableCount: z.number().int().min(0).optional().describe('Number of tables (hospitality qualifier).'),
  branchCount: z.number().int().min(0).optional().describe('Number of branches.'),
  currentSystem: z.string().max(120).optional().describe('Competing/incumbent system in use today.'),
  notes: z.string().max(2000).optional().describe('Free-text notes stored on the lead record itself.'),
  nextFollowUp: z.string().optional().describe('Next follow-up date, ISO 8601.'),
  priority: z.enum(LEAD_PRIORITIES).optional().describe('Lead priority.'),
  companyId: z.string().max(64).optional().describe('Company (B2B account) id to attach this contact to.'),
  customFields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Workspace-defined custom field values; validated against the field definitions.'),
};

/**
 * Faz 5 D1 — the lead WRITE lane. Closes the report's sharpest asymmetry:
 * an agent could already send a real customer a message but could not add a
 * note to that customer's lead.
 *
 * ## Reuse, not reimplementation
 * Every tool delegates to `MarketingLeadsService` / `MarketingActivitiesService`
 * — the exact services the panel's REST controllers call — so nothing here can
 * drift from, or step around, their rules: email dedup (`ConflictException` on a
 * second OPEN lead for the same normalized address), the assignment priority
 * chain (explicit rep → REP self-ownership → auto-assigner → pool), custom-field
 * validation, list-hygiene email classification, `ALLOWED_TRANSITIONS`, the
 * compound-WHERE claim that closes the status-change TOCTOU window, the
 * cancel-open-tasks-on-LOST hook, the assignee notification, and the
 * `lead.created` / `lead.status_changed` outbox events that drive workflows.
 *
 * ## Daily quota
 * The workspace's DAILY LEAD QUOTA is not enforced here, and that is not an
 * omission of this lane: it is a property of the INGEST lane. Quota lives in
 * `MarketingLeadsIngestService.reserveQuota()` (advisory-locked `usageCounter`
 * against `LeadQuotaResolver.getDailyLeadQuota`) and meters bulk, machine-
 * generated prospecting — every candidate there carries an `externalRef` and is
 * forced to `source: AI_RESEARCH`. Manual, one-at-a-time creation through
 * `POST /marketing/leads` has never consumed it. `jeeta.create_lead` is the
 * manual path, one lead per call through the broker (each call audited in
 * `ToolCallLog`), so it behaves EXACTLY as the panel's "New lead" form does. A
 * future bulk/prospecting tool (D4) must go through the ingest service instead.
 *
 * ## Attribution
 * `MarketingLeadsService.updateStatus()`/`assign()` and
 * `MarketingActivitiesService.create()` all write `LeadActivity.createdById`, a
 * non-null FK. The read-only `MCP_NON_REP_PRINCIPAL` placeholder is a synthetic
 * id that satisfies no FK, so every tool here resolves a REAL actor via
 * `McpPrincipalService.resolve()`: the consenting human on an OAuth session, the
 * workspace's automation principal on an API-key session.
 *
 * ## Risk class
 * All WRITE (spec §4): they mutate CRM rows but reach no audience and move no
 * money, so they run in AUTONOMOUS mode and are never approval-gated. Only
 * SPEND/DESTRUCTIVE are always-approve, and D1 contains neither — deletion is
 * deliberately out of scope.
 */
export function registerLeadsWriteTools(registry: McpToolRegistry, deps: LeadsWriteToolDeps): void {
  registry.register({
    name: 'jeeta.create_lead',
    description:
      'Create a new lead (prospective customer) in this workspace. Refuses with a conflict when an open lead already exists for the same email. Ownership follows the workspace rules: an explicit assignee, otherwise the auto-assignment strategy, otherwise the unassigned pool.',
    domain: 'leads',
    scopes: ['leads.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      businessName: z.string().min(1).max(255).describe('Business / account name.'),
      contactPerson: z.string().min(1).max(255).describe('Name of the person to contact.'),
      businessType: z
        .string()
        .regex(BUSINESS_TYPE_PATTERN)
        .describe('Business type code in UPPER_SNAKE_CASE (e.g. "RESTAURANT", "CAFE").'),
      source: z.enum(LEAD_SOURCES).describe('Where this lead came from.'),
      assignedToId: z
        .string()
        .optional()
        .describe('Sales rep to own this lead. Must be an active REP in this workspace.'),
      ...leadBodyShape,
    }),
    handler: async (ctx, args) => {
      const actor = await deps.principals.resolve(ctx);
      if (typeof args.assignedToId === 'string' && args.assignedToId.length > 0) {
        // The service re-checks (in-workspace + REP + ACTIVE) and is the real
        // gate; this pre-check exists so the agent gets a precise "not a member
        // of this workspace" error before any row is touched.
        await deps.principals.assertActiveMember(ctx.workspaceId, args.assignedToId);
      }
      return deps.leads.create(ctx.workspaceId, args as unknown as CreateLeadDto, actor.id, actor.role);
    },
  });

  registry.register({
    name: 'jeeta.update_lead',
    description:
      'Update the details of an existing lead (contact info, address, notes, priority, follow-up date, custom fields). Use jeeta.set_lead_status to move it through the pipeline and jeeta.assign_lead to change its owner.',
    domain: 'leads',
    scopes: ['leads.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      leadId: z.string().min(1).describe('Id of the lead to update.'),
      businessName: z.string().min(1).max(255).optional().describe('Business / account name.'),
      contactPerson: z.string().min(1).max(255).optional().describe('Name of the person to contact.'),
      businessType: z
        .string()
        .regex(BUSINESS_TYPE_PATTERN)
        .optional()
        .describe('Business type code in UPPER_SNAKE_CASE.'),
      source: z.enum(LEAD_SOURCES).optional().describe('Where this lead came from.'),
      ...leadBodyShape,
    }),
    handler: async (ctx, args) => {
      const actor = await deps.principals.resolve(ctx);
      // `leadId` addresses the row; it is not a column. Strip it so it can
      // never be forwarded into the patch body.
      const { leadId, ...patch } = args as { leadId: string } & Record<string, unknown>;
      return deps.leads.update(
        ctx.workspaceId,
        String(leadId),
        patch as unknown as UpdateLeadDto,
        actor.id,
        actor.role,
      );
    },
  });

  registry.register({
    name: 'jeeta.set_lead_status',
    description:
      'Move a lead to another pipeline stage. Only transitions the workspace allows from the current stage are accepted. WON is not settable here — a lead becomes WON through conversion, which also provisions the customer and the commission.',
    domain: 'leads',
    scopes: ['leads.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      leadId: z.string().min(1).describe('Id of the lead to move.'),
      status: z.enum(SETTABLE_STATUSES).describe('Target pipeline stage.'),
      lostReason: z.string().optional().describe('Why the lead was lost. Only meaningful with status=LOST.'),
    }),
    handler: async (ctx, args) => {
      const actor = await deps.principals.resolve(ctx);
      return deps.leads.updateStatus(
        ctx.workspaceId,
        String(args.leadId),
        String(args.status),
        typeof args.lostReason === 'string' ? args.lostReason : undefined,
        actor.id,
        actor.role,
      );
    },
  });

  registry.register({
    name: 'jeeta.add_lead_note',
    description:
      "Add an entry to a lead's activity timeline — a note, or a logged call/visit/meeting/email with its outcome. This is how an agent records what it learned or did about a customer.",
    domain: 'leads',
    scopes: ['leads.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      leadId: z.string().min(1).describe('Id of the lead to annotate.'),
      title: z.string().min(1).describe('Short headline shown in the timeline.'),
      description: z.string().optional().describe('Full note body.'),
      type: z
        .enum(ACTIVITY_TYPES)
        .optional()
        .describe('Kind of timeline entry. Defaults to NOTE.'),
      outcome: z.enum(ACTIVITY_OUTCOMES).optional().describe('Result of the interaction.'),
      duration: z.number().int().min(0).optional().describe('Duration in minutes, for calls and visits.'),
    }),
    handler: async (ctx, args) => {
      const actor = await deps.principals.resolve(ctx);
      const { leadId, type, ...rest } = args as { leadId: string; type?: string } & Record<string, unknown>;
      return deps.activities.create(
        ctx.workspaceId,
        String(leadId),
        { ...rest, type: type ?? 'NOTE' } as unknown as CreateActivityDto,
        actor.id,
        actor.role,
      );
    },
  });

  registry.register({
    name: 'jeeta.assign_lead',
    description:
      'Assign a lead to a sales rep, or hand it back to the unassigned pool by passing assignedToId: null. The target must be an active rep in this workspace; the change is written to the lead timeline and the new owner is notified.',
    // Manager-tier: mirrors PATCH /marketing/leads/:id/assign, which is gated
    // `@RequirePermission('leads.manage')`. Reassigning another rep's book of
    // business is exactly the authority REP does not hold.
    domain: 'leads',
    // Deferred (spec §3): Manager-tier reassignment — rare next to the everyday lead writes.
    defer: true,
    scopes: ['leads.manage'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      leadId: z.string().min(1).describe('Id of the lead to (re)assign.'),
      assignedToId: z
        .string()
        .nullable()
        .describe('Id of the rep who should own the lead, or null to unassign.'),
    }),
    handler: async (ctx, args) => {
      const actor = await deps.principals.resolve(ctx);
      const target = typeof args.assignedToId === 'string' && args.assignedToId.length > 0 ? args.assignedToId : null;
      if (target) await deps.principals.assertActiveMember(ctx.workspaceId, target);
      return deps.leads.assign(ctx.workspaceId, String(args.leadId), target, actor.id);
    },
  });

  /**
   * Deduplication — the product's answer to the one thing every inbound path
   * can produce.
   *
   * `LeadDedupeService` is implemented, tested, and wired to
   * `GET /marketing/leads/duplicates` + `POST /marketing/leads/merge`. Nothing
   * called either: the panel's only "duplicates" surface is the import wizard's
   * skip/update POLICY, and the catalogue had no dedupe tool at all. So a
   * workspace could accumulate duplicates from seven different creation paths
   * (research, webchat, public form, Meta lead ads, voice, import, manual) with
   * no reachable way to consolidate them.
   *
   * Write-time dedup catches what it can — normalized phone/email — but cannot
   * catch a lead with neither (an anonymous webchat contact), or the same
   * business reached on two different numbers. Those are exactly the clusters
   * this finder is for.
   */
  registry.register({
    name: 'jeeta.list_duplicate_leads',
    description:
      'Find groups of leads that look like the same customer, matched on normalised phone and email across every source. Each group comes with a suggested canonical (a converted lead if there is one, otherwise the oldest) and the full records so you can compare before deciding. Nothing is changed. Read this before jeeta.merge_leads.',
    domain: 'leads',
    defer: true,
    scopes: ['leads.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      const clusters = await deps.dedupe.findDuplicates(ctx.workspaceId);
      // An empty list is a real answer ("no duplicates to consolidate"), not a
      // failure — say so rather than returning a bare [].
      return {
        clusters,
        message: clusters.length
          ? `${clusters.length} possible duplicate group(s).`
          : 'No duplicate groups found — every lead has a distinct phone and email.',
      };
    },
  });

  registry.register({
    name: 'jeeta.merge_leads',
    description:
      "Merge duplicate leads into one canonical record: their notes, tasks, deals, conversations and tags move across, and the duplicates are tombstoned so they stop appearing in lists. Get the ids from jeeta.list_duplicate_leads and check the records really are the same customer first — this rewrites someone's CRM history and is not a one-click undo. Refuses to merge away a converted customer, or a duplicate holding wallet credit.",
    domain: 'leads',
    defer: true,
    scopes: ['leads.write'],
    // DESTRUCTIVE, so the broker requires a human even in AUTONOMOUS mode:
    // consolidating customer records is a judgement about who is who, and the
    // tombstoned rows stop being visible everywhere at once.
    risk: 'DESTRUCTIVE',
    requiresApproval: true,
    resourceType: 'lead',
    resourceIdFrom: (args) => (typeof args.canonicalId === 'string' ? args.canonicalId : undefined),
    inputSchema: z.object({
      canonicalId: z
        .string()
        .min(1)
        .describe('The lead to KEEP. Everything is moved onto this record; from jeeta.list_duplicate_leads.'),
      duplicateIds: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe('The leads to fold into the canonical and tombstone. Must not contain the canonical id.'),
    }),
    handler: async (ctx, args) => {
      const res = await deps.dedupe.merge(
        ctx.workspaceId,
        String(args.canonicalId),
        (args.duplicateIds ?? []) as string[],
      );
      // `merged` counts what was actually folded in: ids already merged, or
      // belonging to another workspace, drop out silently in the service. A
      // bare count would read as "all of them".
      const requested = ((args.duplicateIds ?? []) as string[]).length;
      return {
        ...res,
        requested,
        message:
          res.merged === requested
            ? `${res.merged} duplicate(s) merged into ${res.canonicalId}.`
            : `${res.merged} of ${requested} merged into ${res.canonicalId}. The rest were already merged or are not leads of this workspace.`,
      };
    },
  });
}
