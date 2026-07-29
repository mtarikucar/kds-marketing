import { McpToolRegistry } from '../mcp-tool-registry';
import { registerAnalyticsTools } from './analytics.tools';
import { registerBrandTools } from './brand.tools';
import { registerLeadsTools } from './leads.tools';
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
  'contacts.read',
  'contacts.write',
  'campaigns.read',
  'campaigns.write',
  'campaigns.send',
  'reports.read',
  'tasks.read',
  'settings.manage',
];

describe('MCP tool catalogue', () => {
  it('registers exactly the 18 catalogued tools (Faz 1-2)', () => {
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
      ].sort(),
    );
    expect(names).toHaveLength(18);
  });
});
