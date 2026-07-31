import { McpToolRegistry, TOOL_DOMAINS } from '../mcp-tool-registry';
import { registerAnalyticsTools } from './analytics.tools';
import { registerBrandTools } from './brand.tools';
import { registerLeadsTools } from './leads.tools';
import { registerLeadsWriteTools } from './leads-write.tools';
import { registerTasksTools } from './tasks.tools';
import { registerContactsTools } from './contacts.tools';
import { registerPipelineTools } from './pipeline.tools';
import { registerCrmReadTools } from './crm-read.tools';
import { registerInboxTools } from './inbox.tools';
import { registerCampaignsTools } from './campaigns.tools';
import { registerSocialTools } from './social.tools';
import { registerAdsTools } from './ads.tools';
import { registerSchedulingTools } from './scheduling.tools';
import { registerWorkspaceTools } from './workspace.tools';
import { registerContentTools } from './content.tools';
import { registerSocialCampaignTools } from './social-campaigns.tools';
import { registerDiscoveryTools } from './discovery.tools';

/**
 * Registers the FULL curated MCP tool catalogue (every register*Tools call
 * `MarketingModule`'s constructor makes — see marketing.module.ts) against a
 * fresh registry with stub deps, so an accidentally-dropped registration
 * fails CI instead of silently shrinking the catalogue. There is no
 * `mcp.module.ts` — tools are wired directly in `marketing.module.ts` — so
 * this lives beside the tool modules it enumerates rather than a module spec.
 */
function registerFullCatalogue(registry: McpToolRegistry): void {
  registerAnalyticsTools(registry, { analytics: { funnel: jest.fn() } as any });
  registerBrandTools(registry, { brand: { search: jest.fn() } as any });
  registerLeadsTools(registry, { leads: { findAll: jest.fn() } as any });
  registerLeadsWriteTools(registry, {
    leads: { create: jest.fn(), update: jest.fn(), updateStatus: jest.fn(), assign: jest.fn() } as any,
    activities: { create: jest.fn() } as any,
    principals: { resolve: jest.fn(), assertActiveMember: jest.fn() } as any,
  });
  registerTasksTools(registry, {
    tasks: { findAll: jest.fn(), create: jest.fn(), complete: jest.fn() } as any,
    principals: { resolve: jest.fn(), assertActiveMember: jest.fn() } as any,
  });
  registerContactsTools(registry, {
    leads: { findAll: jest.fn(), create: jest.fn() } as any,
    companies: { list: jest.fn(), listContacts: jest.fn(), create: jest.fn() } as any,
    principals: { resolve: jest.fn(), assertActiveMember: jest.fn() } as any,
  });
  registerPipelineTools(registry, {
    opportunities: { list: jest.fn(), create: jest.fn(), move: jest.fn(), get: jest.fn() } as any,
    pipelines: { list: jest.fn(), get: jest.fn() } as any,
    principals: { resolve: jest.fn(), assertActiveMember: jest.fn() } as any,
  });
  registerCrmReadTools(registry, {
    segments: { list: jest.fn() } as any,
    tags: { list: jest.fn() } as any,
  });
  registerInboxTools(registry, {
    conversations: { list: jest.fn(), thread: jest.fn(), replyAsAi: jest.fn() } as any,
  });
  registerCampaignsTools(registry, {
    campaigns: {
      list: jest.fn(),
      get: jest.fn(),
      performance: jest.fn(),
      launch: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn(),
      cancel: jest.fn(),
    } as any,
  });
  registerSocialTools(registry, {
    social: {
      listPosts: jest.fn(),
      createPost: jest.fn(),
      publishNow: jest.fn(),
      getPost: jest.fn(),
      updatePost: jest.fn(),
      deletePost: jest.fn(),
      schedulePost: jest.fn(),
      listAccounts: jest.fn(),
    } as any,
  });
  registerAdsTools(registry, {
    accounts: { getMetrics: jest.fn() } as any,
    budgets: { get: jest.fn(), list: jest.fn() } as any,
    ads: { setDailyBudget: jest.fn() } as any,
  });
  registerSchedulingTools(registry, {
    bookings: { listBookings: jest.fn(), availability: jest.fn() } as any,
  });
  registerWorkspaceTools(registry, { entitlements: { getEffective: jest.fn() } as any });
  registerContentTools(registry, {
    calendar: { range: jest.fn() } as any,
    media: { requestGeneration: jest.fn(), listAssets: jest.fn() } as any,
    principals: { resolve: jest.fn(), assertActiveMember: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerSocialCampaignTools(registry, {
    socialCampaigns: { list: jest.fn(), create: jest.fn() } as any,
    principals: { resolve: jest.fn(), assertActiveMember: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerDiscoveryTools(registry, { registry });
}

const ALL_SCOPES = [
  'leads.read',
  'leads.write',
  'leads.manage',
  'tasks.read',
  'tasks.write',
  'contacts.read',
  'contacts.write',
  'campaigns.read',
  'campaigns.write',
  'campaigns.send',
  'reports.read',
  'settings.manage',
];

/**
 * Spec §3 threshold: past 60 tools, listing them all at once measurably
 * degrades accuracy. D3 brought progressive disclosure online BEFORE the
 * catalogue crossed it (48 tools at the time of writing) rather than after,
 * because the mechanism is what makes D4/D5 landable at all.
 *
 * The cap that matters is therefore no longer the TOTAL — that is free to grow
 * — but the ADVERTISED set: what every model actually loads on every session.
 * 45 is the working ceiling; a wave that pushes past it must defer something,
 * not raise the number.
 */
const ADVERTISED_CEILING = 45;

describe('MCP tool catalogue', () => {
  it('keeps the ADVERTISED surface under the ceiling, whatever the total (spec §3)', () => {
    const registry = new McpToolRegistry();
    registerFullCatalogue(registry);
    const advertised = registry.listAdvertised(ALL_SCOPES);
    const total = registry.list(ALL_SCOPES);
    expect(advertised.length).toBeLessThanOrEqual(ADVERTISED_CEILING);
    // The whole point of deferral: the total is allowed to exceed what we are
    // willing to advertise. If these two are ever equal, nothing is deferred
    // and progressive disclosure has silently been turned off.
    expect(advertised.length).toBeLessThan(total.length);
  });

  /**
   * The tripwire the registry's runtime guard cannot provide on its own: it
   * proves the guard is exercised by the REAL catalogue, so a future tool that
   * somehow reaches the registry without a domain (or with a bogus one) fails
   * here too, and that every domain in use is one `jeeta.find_tools` offers.
   */
  it('gives every catalogued tool a domain from the declared vocabulary', () => {
    const registry = new McpToolRegistry();
    registerFullCatalogue(registry);
    for (const tool of registry.list(ALL_SCOPES)) {
      expect(TOOL_DOMAINS).toContain(tool.domain);
    }
  });

  it('never defers the discovery tool itself (it is the only way back to the rest)', () => {
    const registry = new McpToolRegistry();
    registerFullCatalogue(registry);
    expect(registry.listAdvertised(ALL_SCOPES).map((t) => t.name)).toContain('jeeta.find_tools');
  });

  it('can find every deferred tool through jeeta.find_tools by its own name', async () => {
    const registry = new McpToolRegistry();
    registerFullCatalogue(registry);
    const deferred = registry.list(ALL_SCOPES).filter((t) => t.defer);
    expect(deferred.length).toBeGreaterThan(0);
    const find = registry.get('jeeta.find_tools')!;
    for (const tool of deferred) {
      const res = (await find.handler({ workspaceId: 'ws1', grantedScopes: ALL_SCOPES }, {
        query: tool.name,
      })) as { tools: Array<{ name: string; listed: boolean }> };
      expect(res.tools.map((t) => t.name)).toContain(tool.name);
      expect(res.tools.find((t) => t.name === tool.name)!.listed).toBe(false);
    }
  });

  it('registers exactly the catalogued tools (Faz 1-2 + Faz 5 D1)', () => {
    const registry = new McpToolRegistry();
    registerFullCatalogue(registry);
    const names = registry.list(ALL_SCOPES).map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'jeeta.get_funnel',
        'jeeta.search_brand_knowledge',
        'jeeta.search_leads',
        'jeeta.list_conversations',
        'jeeta.read_conversation',
        'jeeta.send_message',
        'jeeta.list_campaigns',
        'jeeta.get_campaign_performance',
        'jeeta.set_campaign_status',
        'jeeta.list_scheduled_posts',
        'jeeta.draft_social_post',
        'jeeta.publish_social_post',
        'jeeta.get_ad_performance',
        'jeeta.get_budget',
        'jeeta.reallocate_budget',
        'jeeta.list_bookings',
        'jeeta.get_booking_availability',
        'jeeta.get_workspace_info',
        // Faz 5 D1 — CRM core (write).
        'jeeta.create_lead',
        'jeeta.update_lead',
        'jeeta.set_lead_status',
        'jeeta.add_lead_note',
        'jeeta.assign_lead',
        'jeeta.list_tasks',
        'jeeta.create_task',
        'jeeta.complete_task',
        'jeeta.search_contacts',
        'jeeta.create_contact',
        'jeeta.search_companies',
        'jeeta.create_company',
        'jeeta.list_pipelines',
        'jeeta.list_opportunities',
        'jeeta.create_opportunity',
        'jeeta.move_opportunity_stage',
        'jeeta.list_segments',
        'jeeta.list_tags',
        // Faz 5 D2 — content & social automation.
        'jeeta.list_social_accounts',
        'jeeta.get_social_post',
        'jeeta.update_social_post',
        'jeeta.schedule_social_post',
        'jeeta.delete_social_post',
        'jeeta.get_content_calendar',
        'jeeta.generate_image',
        'jeeta.generate_video',
        'jeeta.list_generated_media',
        'jeeta.list_social_campaigns',
        'jeeta.create_social_campaign',
        // Faz 5 D3 — progressive disclosure.
        'jeeta.find_tools',
      ].sort(),
    );
    expect(names).toHaveLength(48);
  });
});
