import { z } from 'zod';
import { MarketingDistributionService } from '../../services/marketing-distribution.service';
import { ApprovalRequestService } from '../../agents/approval-request.service';
import { CustomFieldsService } from '../../services/custom-fields.service';
import { SegmentsService } from '../../services/segments.service';
import { MarketingOffersService } from '../../services/marketing-offers.service';
import { McpPrincipalService } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface OperationsToolDeps {
  distribution: MarketingDistributionService;
  approvals: ApprovalRequestService;
  customFields: CustomFieldsService;
  segments: SegmentsService;
  offers: MarketingOffersService;
  principals: McpPrincipalService;
}

/**
 * Wave 1 of "everything the API can do, the connector can do too".
 *
 * The catalogue grew by following features, so it covers what recent work
 * touched and thins out towards the settings and sales surfaces nobody had a
 * reason to wire yet. Measured against the authenticated REST surface, whole
 * areas had no tool at all — and the cost is not abstract: an operator who
 * connects Claude and asks it to fix something is told, correctly, that there
 * is no way to do it from here, so the work goes back to hunting for a
 * dropdown.
 *
 * These five are the ones that were BLOCKING something measurable rather than
 * merely absent. Each note below says what.
 *
 * ## What deliberately did NOT come with them
 *
 * Approvals are readable here and NOT decidable. The queue exists so a person
 * signs off actions an agent proposed; a tool that let the same agent approve
 * them would not be a convenience, it would delete the gate. The REST route
 * stays the only way, and it takes its actor from the authenticated principal.
 * That asymmetry is the point, so it is stated rather than left to be noticed.
 */
export function registerOperationsTools(registry: McpToolRegistry, deps: OperationsToolDeps): void {
  /**
   * The setting that decided 453 leads had no owner.
   *
   * `LeadAutoAssignerService` returns null on its first line when the strategy
   * is DISABLED, which is the default. Everything downstream treats that as
   * "nobody to assign to" and carries on: the research agent ingests leads all
   * night, the automation's `assign_lead` step is a silent no-op, and the
   * workflow reports `completed` with no error. Nothing anywhere says the
   * reason is one word in one row.
   */
  registry.register({
    name: 'jeeta.set_distribution_config',
    description:
      'Choose how a new lead gets an owner. DISABLED (the default) means nothing is ever assigned — ' +
      'every lead the research agent ingests lands unowned and stays there, and an automation step ' +
      'that assigns a lead silently does nothing. ROUND_ROBIN takes reps in turn; LEAST_LOADED gives ' +
      'the lead to whoever holds the fewest open ones. This applies to leads created AFTER the change ' +
      'only — a backlog that is already unowned stays unowned, so hand those out separately with ' +
      'jeeta.assign_lead. Read the current setting with jeeta.get_distribution_config.',
    domain: 'leads',
    defer: true,
    scopes: ['settings.manage'],
    risk: 'WRITE',
    // Same authority the panel gives a MANAGER, reversible by setting it back,
    // and it sends nothing to anyone.
    requiresApproval: false,
    inputSchema: z.object({
      strategy: z
        .enum(['DISABLED', 'ROUND_ROBIN', 'LEAST_LOADED'])
        .describe(
          'DISABLED turns automatic assignment off; ROUND_ROBIN cycles through active reps; ' +
            'LEAST_LOADED picks the rep with the fewest open leads.',
        ),
    }),
    handler: async (ctx, args) => {
      const actorId = ctx.userId ?? (await deps.principals.resolve(ctx)).id;
      return deps.distribution.update(ctx.workspaceId, String(args.strategy), actorId);
    },
  });

  /**
   * What is waiting on a human, readable by the agent that is waiting for it.
   *
   * An agent whose call came back PENDING_APPROVAL had no way to see the queue
   * afterwards: not whether the person had decided, not whether the card had
   * expired, not whether five more were stacked behind it. So it either
   * re-queued the same action or told the operator to go and look, which is
   * the opposite of what the connector is for.
   */
  registry.register({
    name: 'jeeta.list_pending_approvals',
    description:
      'The actions waiting on a human decision in this workspace — what was requested, by whom, when ' +
      'it expires. Read this after a call comes back PENDING_APPROVAL rather than re-issuing it: the ' +
      'request is already queued, and sending it again just puts a second card in front of the same ' +
      'person. READ-ONLY BY DESIGN: there is no tool that approves. The queue exists so a person signs ' +
      'off what an agent proposed, and an agent that could approve its own request would remove the ' +
      'only thing the queue is for. Approving happens in the panel.',
    domain: 'workspace',
    defer: true,
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => deps.approvals.listPending(ctx.workspaceId),
  });

  /**
   * `jeeta.update_lead` has always accepted `customFields`, validated against
   * definitions the caller had no way to read. So the only way to write one
   * was to already know its key — and getting it wrong is rejected by a
   * validator whose vocabulary was invisible.
   */
  registry.register({
    name: 'jeeta.list_custom_fields',
    description:
      'The workspace-defined fields on a lead or contact: key, label, type and, for a SELECT, its ' +
      'allowed options. Read this BEFORE writing `customFields` through jeeta.create_lead or ' +
      'jeeta.update_lead — those are validated against these definitions, and a key that does not ' +
      'exist is refused. Read-only.',
    domain: 'contacts',
    defer: true,
    scopes: ['contacts.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      entity: z
        .enum(['LEAD', 'CONTACT', 'COMPANY'])
        .optional()
        .describe('Which record type the fields belong to. Defaults to LEAD.'),
      includeArchived: z
        .boolean()
        .optional()
        .describe('Include fields that have been archived. Defaults to false.'),
    }),
    handler: async (ctx, args) =>
      deps.customFields.list(
        ctx.workspaceId,
        args.includeArchived === true,
        (args.entity as string) ?? 'LEAD',
      ),
  });

  registry.register({
    name: 'jeeta.create_custom_field',
    description:
      'Add a workspace-defined field to leads or contacts — the way to record something this CRM has ' +
      'no column for (a franchise code, a POS brand, a contract end date). The key is immutable once ' +
      'created and is what jeeta.update_lead writes against, so choose it deliberately: pass one in ' +
      'lower_snake_case, or let it be derived from the label. SELECT and MULTISELECT need their ' +
      'options up front; every other type ignores them.',
    domain: 'contacts',
    defer: true,
    scopes: ['contacts.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      label: z.string().min(1).max(80).describe('What a person sees on the record.'),
      type: z
        .enum([
          'TEXT',
          'TEXTAREA',
          'NUMBER',
          'DATE',
          'DATETIME',
          'BOOL',
          'SELECT',
          'MULTISELECT',
          'URL',
          'PHONE',
          'EMAIL',
        ])
        .describe('Field type. SELECT/MULTISELECT require options.'),
      key: z
        .string()
        .max(64)
        .regex(/^[a-z][a-z0-9_]*$/, 'key must be lower_snake_case')
        .optional()
        .describe('Immutable machine key. Derived from the label when omitted.'),
      options: z
        .array(z.object({ value: z.string().min(1), label: z.string().min(1).optional() }))
        .optional()
        .describe('Allowed values, for SELECT and MULTISELECT only.'),
      entity: z
        .enum(['LEAD', 'CONTACT', 'COMPANY'])
        .optional()
        .describe('Which record type to add it to. Defaults to LEAD.'),
    }),
    handler: async (ctx, args) =>
      deps.customFields.create(
        ctx.workspaceId,
        {
          label: args.label as string,
          type: args.type as never,
          ...(args.key ? { key: args.key as string } : {}),
          ...(args.options ? { options: args.options as never } : {}),
        } as never,
        (args.entity as string) ?? 'LEAD',
      ),
  });

  /**
   * Counting BEFORE creating, because a segment that matches everybody is a
   * campaign audience that mails everybody. `SegmentCompilerService.validate`
   * runs on both paths, so a definition this accepts is one `create_segment`
   * will accept too.
   */
  registry.register({
    name: 'jeeta.preview_segment',
    description:
      'How many leads a segment definition would match, without saving anything. Run this before ' +
      'jeeta.create_segment: a segment becomes a campaign audience, and one built on a filter that is ' +
      'looser than intended is how a message reaches people it was never meant for. The definition is ' +
      'validated here exactly as it is on save, so anything this accepts will also save.',
    domain: 'contacts',
    defer: true,
    scopes: ['contacts.write'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      definition: SEGMENT_DEFINITION,
    }),
    handler: async (ctx, args) => deps.segments.preview(ctx.workspaceId, args.definition),
  });

  registry.register({
    name: 'jeeta.create_segment',
    description:
      'Save a reusable audience — a named filter over leads that campaigns and automations target by ' +
      'id. Check the size with jeeta.preview_segment first; the definition is validated identically on ' +
      'both. Read existing ones with jeeta.list_segments.',
    domain: 'contacts',
    defer: true,
    scopes: ['contacts.write'],
    risk: 'WRITE',
    // Writes an inert row. Nothing is sent until a campaign points at it, and
    // that campaign has its own gate.
    requiresApproval: false,
    inputSchema: z.object({
      name: z.string().min(1).max(120).describe('What the segment is called in the panel.'),
      description: z.string().max(500).optional().describe('What it is for.'),
      definition: SEGMENT_DEFINITION,
    }),
    handler: async (ctx, args) =>
      deps.segments.create(ctx.workspaceId, {
        name: args.name as string,
        ...(args.description ? { description: args.description as string } : {}),
        definition: args.definition,
      }),
  });

  /**
   * Offers are the sales artifact this CRM actually closes on — the thing that
   * gets sent, accepted and turned into an installation. The catalogue could
   * create an ESTIMATE and read invoices, and could not see an offer at all.
   */
  registry.register({
    name: 'jeeta.list_offers',
    description:
      'The offers (teklifler) in this workspace — their lead, status, total and dates. This is the ' +
      'artifact the pipeline closes on, so read it before answering "where are we with this customer" ' +
      'or "what is outstanding". Row visibility follows the caller: a rep sees their own. Read-only.',
    domain: 'leads',
    defer: true,
    scopes: ['leads.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      status: z.string().max(40).optional().describe('Offer status filter.'),
      dateFrom: z.string().max(40).optional().describe('Inclusive start date, ISO 8601.'),
      dateTo: z.string().max(40).optional().describe('Inclusive end date, ISO 8601.'),
      page: z.number().int().min(1).optional().describe('Page number, 1-based.'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size, max 100.'),
    }),
    handler: async (ctx, args) => {
      // Row-level visibility is the caller's, falling back to the declared
      // service principal on an API-key session — the same rule the context
      // documents for every tool that filters by actor.
      const principal = ctx.userId ? null : await deps.principals.resolve(ctx);
      const actorId = ctx.userId ?? principal!.id;
      const actorRole = ctx.userRole ?? principal!.role;
      return deps.offers.findAll(
        ctx.workspaceId,
        actorId,
        actorRole as never,
        args.page as number | undefined,
        args.limit as number | undefined,
        {
          status: args.status as string | undefined,
          dateFrom: args.dateFrom as string | undefined,
          dateTo: args.dateTo as string | undefined,
        },
      );
    },
  });
}

/**
 * A segment filter tree, exactly as `SegmentCompilerService` reads it.
 *
 * Described rather than typed all the way down because it is recursive, and a
 * zod schema deep enough to express that would be harder to read in a tool
 * listing than the sentence explaining it. The compiler validates every node
 * anyway — field names against its own whitelist, comparators against the type
 * of the field — and refuses the whole definition otherwise, so a wrong shape
 * fails loudly at the call rather than quietly at send time.
 */
const SEGMENT_DEFINITION = z
  .record(z.string(), z.unknown())
  .describe(
    'The filter tree. A GROUP is {op: "and"|"or", children: [...]}; a LEAF is ' +
      '{field, cmp, value}. Comparators: eq, ne, in, nin, gt, gte, lt, lte, between, contains, ' +
      'startsWith, isSet, isNotSet — plus has/hasNot for tags. Fields are native lead columns ' +
      '(status, city, region, source, businessType, priority, businessName, currentSystem, email, ' +
      'phone, aiScore, tableCount, branchCount, createdAt, updatedAt, nextFollowUp, convertedAt, ' +
      'emailOptOut, smsOptOut) or a workspace custom field — see jeeta.list_custom_fields. Anything ' +
      'outside that whitelist is refused.',
  );
