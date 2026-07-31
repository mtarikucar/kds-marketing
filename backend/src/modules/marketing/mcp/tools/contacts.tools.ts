import { z } from 'zod';
import { CompaniesService, CreateCompanyInput } from '../../companies/companies.service';
import { BUSINESS_TYPE_PATTERN, CreateLeadDto, LeadPriority, LeadSource } from '../../dto/create-lead.dto';
import { LeadFilterDto } from '../../dto/lead-filter.dto';
import { MarketingLeadsService } from '../../services/marketing-leads.service';
import { McpPrincipalService, visibilityPrincipal } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface ContactsToolDeps {
  leads: MarketingLeadsService;
  companies: CompaniesService;
  principals: McpPrincipalService;
}

const LEAD_SOURCES = Object.values(LeadSource) as [string, ...string[]];
const LEAD_PRIORITIES = Object.values(LeadPriority) as [string, ...string[]];

/**
 * Faz 5 D1 — contacts (people) and companies (B2B accounts).
 *
 * ## A contact IS a lead
 * This product has no separate Contact table: a person is a `Lead` row, and a
 * `Company` groups them through `Lead.companyId`. These tools are therefore a
 * contact-shaped façade over `MarketingLeadsService` + `CompaniesService`, not
 * a second CRM. Two consequences, both deliberate:
 *
 * - They demand BOTH scopes — `contacts.*` for the surface they present and
 *   `leads.*` for the rows they actually touch. `McpBrokerService.assertScopes`
 *   requires ALL declared scopes, so this is strictly narrower than either
 *   alone: no caller gains reach over lead rows it did not already hold.
 * - `create_contact` goes through `MarketingLeadsService.create`, so email
 *   dedup, the assignment priority chain, custom-field validation and the
 *   `lead.created` workflow trigger apply identically to `jeeta.create_lead`.
 *
 * ## Why they exist alongside the lead tools
 * They answer a question the lead tools structurally cannot: `LeadFilterDto`
 * has no company filter, so "who are our contacts at Acme?" was unanswerable.
 * `search_contacts` routes that case through `CompaniesService.listContacts`.
 * `create_contact` requires `companyId` for the same reason — attaching a
 * person to an existing account is its whole job; an unattached prospect is
 * `jeeta.create_lead`. Keeping the two tools non-overlapping is what stops a
 * model from having to guess between them.
 *
 * Company tools mirror the REST gates exactly (`CompaniesController`:
 * `contacts.read` to read, `contacts.write` to write).
 */
export function registerContactsTools(registry: McpToolRegistry, deps: ContactsToolDeps): void {
  registry.register({
    name: 'jeeta.search_contacts',
    description:
      'Find people (contacts) in this workspace by name, phone or email — or list everyone attached to a given company by passing companyId. Read-only.',
    domain: 'contacts',
    scopes: ['contacts.read', 'leads.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      search: z.string().optional().describe('Free-text match against name, phone and email.'),
      companyId: z
        .string()
        .optional()
        .describe('Return the contacts attached to this company instead of running a free-text search.'),
      city: z.string().optional().describe('City filter.'),
      status: z.string().optional().describe('Pipeline status filter.'),
      page: z.number().int().min(1).optional().describe('Page number, 1-based (default 1).'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size, max 100.'),
    }),
    handler: async (ctx, args) => {
      if (typeof args.companyId === 'string' && args.companyId.length > 0) {
        // The company roster is already workspace-scoped and returns the
        // lightweight contact shape the detail view uses.
        return deps.companies.listContacts(ctx.workspaceId, args.companyId);
      }
      const actor = visibilityPrincipal(ctx);
      const { companyId: _ignored, ...filter } = args as Record<string, unknown>;
      return deps.leads.findAll(
        ctx.workspaceId,
        filter as unknown as LeadFilterDto,
        actor.userId,
        actor.role,
      );
    },
  });

  registry.register({
    name: 'jeeta.create_contact',
    description:
      'Add a person to an existing company (B2B account). Refuses with a conflict when an open record already exists for the same email. To create a prospect that is not tied to a company, use jeeta.create_lead instead.',
    domain: 'contacts',
    scopes: ['contacts.write', 'leads.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      companyId: z.string().min(1).max(64).describe('Id of the company this person belongs to.'),
      contactPerson: z.string().min(1).max(255).describe('The person\'s name.'),
      businessName: z.string().min(1).max(255).describe('Business / account name shown on the record.'),
      businessType: z
        .string()
        .regex(BUSINESS_TYPE_PATTERN)
        .describe('Business type code in UPPER_SNAKE_CASE (e.g. "RESTAURANT").'),
      source: z.enum(LEAD_SOURCES).describe('Where this contact came from.'),
      email: z.string().email().optional().describe('Contact email. Used for duplicate detection.'),
      phone: z.string().max(20).optional().describe('Primary phone number.'),
      whatsapp: z.string().max(20).optional().describe('WhatsApp number, if different from phone.'),
      city: z.string().max(120).optional().describe('City.'),
      region: z.string().max(120).optional().describe('Region / province.'),
      notes: z.string().max(2000).optional().describe('Free-text notes stored on the record.'),
      priority: z.enum(LEAD_PRIORITIES).optional().describe('Priority.'),
      assignedToId: z
        .string()
        .optional()
        .describe('Sales rep to own this contact. Must be an active REP in this workspace.'),
    }),
    handler: async (ctx, args) => {
      const actor = await deps.principals.resolve(ctx);
      if (typeof args.assignedToId === 'string' && args.assignedToId.length > 0) {
        await deps.principals.assertActiveMember(ctx.workspaceId, args.assignedToId);
      }
      return deps.leads.create(ctx.workspaceId, args as unknown as CreateLeadDto, actor.id, actor.role);
    },
  });

  registry.register({
    name: 'jeeta.search_companies',
    description:
      'List or search the B2B accounts (companies) in this workspace, each with its contact count. Archived companies are hidden unless includeArchived is set. Read-only.',
    domain: 'contacts',
    // Deferred (spec §3): Companies are the secondary CRM entity; leads/contacts carry the daily traffic.
    defer: true,
    scopes: ['contacts.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      search: z.string().optional().describe('Case-insensitive match against the company name.'),
      includeArchived: z.boolean().optional().describe('Include archived companies (default false).'),
    }),
    handler: async (ctx, args) =>
      deps.companies.list(ctx.workspaceId, {
        search: typeof args.search === 'string' ? args.search : undefined,
        includeArchived: typeof args.includeArchived === 'boolean' ? args.includeArchived : undefined,
      }),
  });

  registry.register({
    name: 'jeeta.create_company',
    description:
      'Create a B2B account (company) in this workspace. Contacts and opportunities can then be attached to it.',
    domain: 'contacts',
    // Deferred (spec §3): Companies are the secondary CRM entity; leads/contacts carry the daily traffic.
    defer: true,
    scopes: ['contacts.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      name: z.string().min(1).max(160).describe('Company name.'),
      domain: z.string().max(160).optional().describe('Primary web domain.'),
      phone: z.string().max(40).optional().describe('Main phone number.'),
      email: z.string().max(160).optional().describe('Main email address.'),
      address: z.string().max(300).optional().describe('Street address.'),
      city: z.string().max(120).optional().describe('City.'),
      notes: z.string().max(4000).optional().describe('Free-text notes.'),
      customFields: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Workspace-defined custom field values.'),
    }),
    handler: async (ctx, args) => deps.companies.create(ctx.workspaceId, args as unknown as CreateCompanyInput),
  });
}
