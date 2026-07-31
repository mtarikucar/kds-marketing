import { McpToolRegistry } from '../mcp-tool-registry';
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
    social: { listPosts: jest.fn(), createPost: jest.fn(), publishNow: jest.fn() } as any,
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
 * Spec §3 threshold: below 60 tools the whole catalogue is listed directly;
 * past 60, progressive disclosure (domain grouping + `jeeta.find_tools`) has to
 * come online because listing ~140 tools at once measurably degrades accuracy.
 * Pinned as an assertion so the wave that crosses the line cannot land quietly.
 */
const PROGRESSIVE_DISCLOSURE_THRESHOLD = 60;

describe('MCP tool catalogue', () => {
  it('stays under the progressive-disclosure threshold (spec §3)', () => {
    const registry = new McpToolRegistry();
    registerFullCatalogue(registry);
    expect(registry.list(ALL_SCOPES).length).toBeLessThanOrEqual(PROGRESSIVE_DISCLOSURE_THRESHOLD);
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
      ].sort(),
    );
    expect(names).toHaveLength(36);
  });
});
