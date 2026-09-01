import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { McpToolRegistry, TOOL_DOMAINS } from '../mcp-tool-registry';
import { registerAnalyticsTools } from './analytics.tools';
import { registerBrandTools } from './brand.tools';
import { registerLeadsTools } from './leads.tools';
import { registerLeadsWriteTools } from './leads-write.tools';
import { registerTasksTools } from './tasks.tools';
import { registerContactsTools } from './contacts.tools';
import { registerPipelineTools } from './pipeline.tools';
import { registerCrmReadTools } from './crm-read.tools';
import { registerInboxTools, registerChannelWriteTools } from './inbox.tools';
import { registerAgentTools } from './agents.tools';
import { registerCampaignsTools } from './campaigns.tools';
import { registerSocialTools } from './social.tools';
import { registerAdsTools } from './ads.tools';
import { registerSchedulingTools } from './scheduling.tools';
import { registerWorkspaceTools } from './workspace.tools';
import { registerContentTools } from './content.tools';
import { registerSocialCampaignTools } from './social-campaigns.tools';
import { registerContentConceptTools } from './content-concepts.tools';
import { registerContentDistributionTools } from './content-distribution.tools';
import { registerEmailTools } from './email.tools';
import { registerVoiceTools } from './voice.tools';
import { registerCampaignWriteTools } from './campaigns-write.tools';
import { registerConversationWriteTools } from './conversations-write.tools';
import { registerDiscoveryTools } from './discovery.tools';
import { registerStrategyTools } from './strategy.tools';
import { registerWorkflowTools } from './workflows.tools';
import { registerResearchTools } from './research.tools';
import { registerCommerceTools } from './commerce.tools';
import { registerCourseTools } from './courses.tools';
import { registerReviewTools } from './reviews.tools';

/**
 * Registers the FULL curated MCP tool catalogue (every register*Tools call
 * `MarketingModule`'s constructor makes — see marketing.module.ts) against a
 * fresh registry with stub deps, so an accidentally-dropped registration
 * fails CI instead of silently shrinking the catalogue. There is no
 * `mcp.module.ts` — tools are wired directly in `marketing.module.ts` — so
 * this lives beside the tool modules it enumerates rather than a module spec.
 */
function registerFullCatalogue(registry: McpToolRegistry): void {
  registerAnalyticsTools(registry, {
    analytics: { funnel: jest.fn() } as any,
    aiUsage: { breakdown: jest.fn(), daily: jest.fn() } as any,
  });
  registerBrandTools(registry, {
    brand: { search: jest.fn() } as any,
    profiles: { get: jest.fn(), upsert: jest.fn() } as any,
  });
  registerLeadsTools(registry, { leads: { findAll: jest.fn() } as any });
  registerLeadsWriteTools(registry, {
    leads: {
      create: jest.fn(),
      update: jest.fn(),
      updateStatus: jest.fn(),
      reopen: jest.fn(),
      assign: jest.fn(),
    } as any,
    activities: { create: jest.fn() } as any,
    principals: { resolve: jest.fn(), assertActiveMember: jest.fn() } as any,
    dedupe: { findDuplicates: jest.fn(), merge: jest.fn() } as any,
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
    opportunities: {
      list: jest.fn(),
      create: jest.fn(),
      move: jest.fn(),
      get: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    } as any,
    pipelines: { list: jest.fn(), get: jest.fn() } as any,
    principals: { resolve: jest.fn(), assertActiveMember: jest.fn() } as any,
  });
  registerCrmReadTools(registry, {
    segments: { list: jest.fn() } as any,
    tags: { list: jest.fn() } as any,
  });
  registerInboxTools(registry, {
    conversations: { list: jest.fn(), thread: jest.fn(), replyAsAi: jest.fn() } as any,
    outbound: { start: jest.fn() } as any,
    channels: { create: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerChannelWriteTools(registry, {
    conversations: { list: jest.fn(), thread: jest.fn(), replyAsAi: jest.fn() } as any,
    outbound: { start: jest.fn() } as any,
    channels: { create: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerAgentTools(registry, {
    agents: { list: jest.fn(), update: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
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
      unschedulePost: jest.fn(),
      listAccounts: jest.fn(),
    } as any,
  });
  registerAdsTools(registry, {
    accounts: { getMetrics: jest.fn() } as any,
    budgets: { get: jest.fn(), list: jest.fn() } as any,
    ads: { setDailyBudget: jest.fn() } as any,
  });
  registerSchedulingTools(registry, {
    bookings: { listBookings: jest.fn(), availability: jest.fn(), book: jest.fn(), list: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerWorkspaceTools(registry, { entitlements: { getEffective: jest.fn() } as any });
  registerContentTools(registry, {
    calendar: { range: jest.fn() } as any,
    media: { requestGeneration: jest.fn(), listAssets: jest.fn() } as any,
    principals: { resolve: jest.fn(), assertActiveMember: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerContentConceptTools(registry, {
    concepts: { planConcepts: jest.fn(), list: jest.fn(), review: jest.fn() } as any,
    principals: { resolve: jest.fn(), assertActiveMember: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerContentDistributionTools(registry, {
    distribution: { plan: jest.fn(), listDrafts: jest.fn() } as any,
    principals: { resolve: jest.fn(), assertActiveMember: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerSocialCampaignTools(registry, {
    socialCampaigns: { list: jest.fn(), create: jest.fn() } as any,
    principals: { resolve: jest.fn(), assertActiveMember: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerEmailTools(registry, {
    templates: { list: jest.fn() } as any,
    campaigns: { create: jest.fn(), launch: jest.fn(), remove: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerVoiceTools(registry, {
    calls: { startCall: jest.fn(), list: jest.fn() } as any,
    leads: { findOne: jest.fn() } as any,
    campaigns: { create: jest.fn() } as any,
    principals: { resolve: jest.fn(), assertActiveMember: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerCampaignWriteTools(registry, {
    campaigns: { create: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerConversationWriteTools(registry, {
    conversations: { assign: jest.fn(), close: jest.fn(), addNote: jest.fn() } as any,
    principals: { resolve: jest.fn(), assertActiveMember: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  // Faz 5 D4 — brain & automation.
  registerStrategyTools(registry, {
    strategy: {
      getStrategy: jest.fn(),
      listActions: jest.fn(),
      approveAction: jest.fn(),
      dismissAction: jest.fn(),
      setAutonomy: jest.fn(),
    } as any,
    feedback: { refresh: jest.fn() } as any,
  });
  registerWorkflowTools(registry, {
    workflows: { list: jest.fn(), get: jest.fn(), create: jest.fn(), setStatus: jest.fn() } as any,
    leadBulk: { bulkEnroll: jest.fn() } as any,
    principals: { resolve: jest.fn(), assertActiveMember: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerResearchTools(registry, {
    research: { list: jest.fn(), create: jest.fn(), usage: jest.fn() } as any,
    runner: { enqueueNow: jest.fn() } as any,
    candidates: { list: jest.fn(), accept: jest.fn(), reject: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  // Faz 5 D5 — commerce & reputation.
  registerCommerceTools(registry, {
    products: { list: jest.fn(), create: jest.fn() } as any,
    invoices: { list: jest.fn() } as any,
    invoiceText: { sendByText: jest.fn() } as any,
    estimates: { create: jest.fn() } as any,
    orderForms: { list: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerCourseTools(registry, {
    courses: { list: jest.fn() } as any,
    enrollments: { enroll: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerReviewTools(registry, {
    reviews: { list: jest.fn(), saveReply: jest.fn() } as any,
    entitlements: { getEffective: jest.fn() } as any,
  });
  registerDiscoveryTools(registry, {
    registry,
    // The catalogue tests never dispatch; they only assert the surface.
    dispatch: async () => ({ status: 'OK' as const, result: null }),
  });
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
  'automations.manage',
  'courses.manage',
  'settings.manage',
];

/**
 * Spec §3 threshold: past 60 tools, listing them all at once measurably
 * degrades accuracy. D3 brought progressive disclosure online BEFORE the
 * catalogue crossed it (57 tools at the time of writing) rather than after,
 * because the mechanism is what makes D4/D5 landable at all.
 *
 * The cap that matters is therefore no longer the TOTAL — that is free to grow
 * — but the ADVERTISED set: what every model actually loads on every session.
 * 45 is the working ceiling; a wave that pushes past it must defer something,
 * not raise the number.
 *
 * The ceiling governs the DOMAIN surface — the tools that do workspace work.
 * The two discovery tools are not part of it: they are the mechanism the
 * ceiling is enforced BY. `find_tools` is how a deferred tool is found and
 * `call_tool` is how it is then run (an MCP client can only call names it saw
 * in `tools/list`, so without the latter every deferred tool is unreachable in
 * practice, whatever the catalogue claims). Charging them against the budget
 * they create would mean deferring a real tool to pay for the ability to reach
 * deferred tools — which is why they are listed here by name and exempted.
 */
const ADVERTISED_CEILING = 45;
const DISCOVERY_TOOLS = ['jeeta.find_tools', 'jeeta.call_tool'];

describe('MCP tool catalogue', () => {
  it('keeps the ADVERTISED surface under the ceiling, whatever the total (spec §3)', () => {
    const registry = new McpToolRegistry();
    registerFullCatalogue(registry);
    const advertised = registry
      .listAdvertised(ALL_SCOPES)
      .filter((t) => !DISCOVERY_TOOLS.includes(t.name));
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

  it('registers exactly the catalogued tools (Faz 1-2 + Faz 5 D1-D5)', () => {
    const registry = new McpToolRegistry();
    registerFullCatalogue(registry);
    const names = registry.list(ALL_SCOPES).map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'jeeta.call_tool',
        'jeeta.list_team',
        'jeeta.list_background_jobs',
        'jeeta.verify_channel',
        'jeeta.list_scheduled_runs',
        'jeeta.get_agent',
        'jeeta.verify_email_transport',
        'jeeta.create_webchat_channel',
        'jeeta.list_channels',
        'jeeta.get_distribution_config',
        'jeeta.set_channel_status',
        'jeeta.list_calendars',
        'jeeta.list_companies',
        'jeeta.list_ad_accounts',
        'jeeta.list_agents',
        'jeeta.update_agent',
        'jeeta.get_funnel',
        'jeeta.get_ai_usage',
        'jeeta.get_vendor_spend',
        'jeeta.search_brand_knowledge',
        'jeeta.search_leads',
        'jeeta.list_conversations',
        'jeeta.read_conversation',
        'jeeta.send_message',
        'jeeta.message_lead',
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
        'jeeta.reopen_lead',
        'jeeta.add_lead_note',
        'jeeta.assign_lead',
        'jeeta.list_duplicate_leads',
        'jeeta.merge_leads',
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
        'jeeta.update_opportunity',
        'jeeta.delete_opportunity',
        'jeeta.list_segments',
        'jeeta.list_tags',
        // Faz 5 D2 — content & social automation.
        'jeeta.list_social_accounts',
        'jeeta.get_social_post',
        'jeeta.update_social_post',
        'jeeta.schedule_social_post',
        'jeeta.unschedule_social_post',
        'jeeta.delete_social_post',
        'jeeta.get_content_calendar',
        'jeeta.generate_image',
        'jeeta.generate_video',
        'jeeta.list_generated_media',
        'jeeta.list_social_campaigns',
        'jeeta.create_social_campaign',
        'jeeta.pause_social_campaign',
        // Faz 5 D3 — communications + progressive disclosure.
        'jeeta.find_tools',
        'jeeta.list_email_templates',
        'jeeta.send_email',
        'jeeta.create_campaign',
        'jeeta.create_voice_campaign',
        'jeeta.click_to_dial',
        'jeeta.list_calls',
        'jeeta.assign_conversation',
        'jeeta.close_conversation',
        'jeeta.add_conversation_note',
        // Faz 5 D4 — brain & automation.
        'jeeta.get_strategy',
        'jeeta.list_strategy_actions',
        'jeeta.approve_strategy_action',
        'jeeta.dismiss_strategy_action',
        'jeeta.synthesize_strategy',
        'jeeta.set_strategy_autonomy',
        'jeeta.list_workflows',
        'jeeta.get_workflow',
        'jeeta.create_workflow',
        'jeeta.set_workflow_enabled',
        'jeeta.trigger_workflow',
        'jeeta.list_research_profiles',
        'jeeta.create_research_profile',
        'jeeta.pause_research_profile',
        'jeeta.run_research',
        'jeeta.list_research_candidates',
        'jeeta.accept_research_candidates',
        'jeeta.reject_research_candidates',
        // The MCP research lane — all six deferred, so the advertised ceiling
        // below is unchanged. A drainer learns these names from the
        // instruction jeeta.claim_research_job hands it.
        'jeeta.claim_research_job',
        'jeeta.submit_research_candidates',
        'jeeta.complete_research_job',
        'jeeta.research_search_places',
        'jeeta.research_lookup_instagram',
        'jeeta.research_scrape_page',
        'jeeta.get_brand_profile',
        'jeeta.update_brand_profile',
        // Faz 5 D5 — commerce & reputation (the final wave).
        'jeeta.list_products',
        'jeeta.create_product',
        'jeeta.list_invoices',
        'jeeta.create_estimate',
        'jeeta.send_invoice',
        'jeeta.list_order_forms',
        'jeeta.create_booking',
        'jeeta.list_courses',
        'jeeta.enrol_lead',
        'jeeta.list_reviews',
        'jeeta.reply_to_review',
        // İçerik üretim hattı, aşama 1. All three DEFERRED: the advertised
        // surface is exactly at its ceiling and the rule is that a wave which
        // wants room defers rather than raises the number. The chat reaches
        // them through find_tools -> call_tool, which is what the ceiling funds.
        'jeeta.plan_content_concepts',
        'jeeta.list_content_concepts',
        'jeeta.review_content_concept',
        // Promotion's SECOND caller. Without it, any failure between the verdict
        // write and the item left a concept APPROVED with promotedItemId null
        // and review() answering "already approved" forever — a paid-for
        // decision with no way to act on it.
        'jeeta.produce_content_concept',
        // İçerik üretim hattı, aşama 4. Two tools, both deferred, and note
        // which verb is NOT among them: there is no send. Sending a prepared
        // message is a REST route behind an authenticated human, because
        // `requiresApproval` gates at the WORKSPACE level and one AUTONOMOUS
        // toggle would turn an approval-gated send tool into an unattended one.
        // The owner's decision was per-message. See
        // distribution-send.boundary.spec.ts.
        'jeeta.plan_content_distribution',
        'jeeta.list_distribution_drafts',
      ].sort(),
    );
    // 105 -> 107: jeeta.list_channels + jeeta.set_channel_status. Both DEFERRED,
    // so the advertised ceiling below is untouched — the agent could create a
    // webchat channel but could not see what channels existed or take one out
    // of service, which is a blind spot rather than a missing convenience.
    // 108 -> 109: jeeta.list_background_jobs, also deferred. Same shape of gap —
    // the retry queue behind every deferred action had no reader at all, so a
    // job's lastError was recorded and then unreachable from anywhere.
    // 120 -> 123: the three content-concept tools, every one of them deferred.
    // 123 -> 124: jeeta.produce_content_concept, also deferred.
    // 124 -> 126: the two distribution tools, also deferred. There is no third
    // one that sends, on purpose — see the comment beside them above.
    //
    // MEASURED, not counted by grep. `grep -c 'registry.register('` over the
    // non-spec tool files is a legitimate cross-check and currently agrees:
    // 123 calls for 123 names before that tool, 124/124 after, 126/126 with
    // stage 4's two distribution tools. An earlier note
    // recorded "125 register calls but 123 registered names" and claimed grep
    // over-counts; re-measured, grep did not — the counts have always matched,
    // and the figure to trust is the one this assertion takes from a built
    // registry.
    expect(names).toHaveLength(126);
  });

  /**
   * D4 added 16 tools to a catalogue that was already 44/45 of the way to the
   * advertised ceiling. The way that was paid for is the mechanism spec §3
   * mandates — "a wave that pushes past it must defer something, not raise the
   * number" — so five previously-advertised tools were deferred rather than the
   * ceiling being nudged. Pinned by NAME so a future wave that wants the room
   * back has to make the same trade explicitly instead of quietly re-listing
   * them and pushing the surface over the edge.
   */
  it('paid for D4 by deferring five previously-advertised tools, not by raising the ceiling', () => {
    const registry = new McpToolRegistry();
    registerFullCatalogue(registry);
    const advertised = new Set(registry.listAdvertised(ALL_SCOPES).map((t) => t.name));
    for (const name of [
      'jeeta.get_booking_availability',
      'jeeta.list_calls',
      'jeeta.update_social_post',
      'jeeta.list_social_campaigns',
      'jeeta.assign_conversation',
    ]) {
      expect(registry.get(name)!.defer).toBe(true);
      expect(advertised.has(name)).toBe(false);
    }
  });

  /**
   * Progressive disclosure only works if a model that has NOT loaded the whole
   * catalogue can still reach every domain. Each domain must therefore keep at
   * least one advertised tool — including D4's three new ones, whose primary
   * reads are the only advertised members of their group.
   */
  it('keeps at least one advertised tool in every domain in use', () => {
    const registry = new McpToolRegistry();
    registerFullCatalogue(registry);
    const advertisedDomains = new Set(registry.listAdvertised(ALL_SCOPES).map((t) => t.domain));
    for (const tool of registry.list(ALL_SCOPES)) {
      expect(advertisedDomains).toContain(tool.domain);
    }
    for (const d of ['strategy', 'workflows', 'research']) expect(advertisedDomains).toContain(d);
    for (const d of ['commerce', 'courses', 'reviews']) expect(advertisedDomains).toContain(d);
  });

  /**
   * D5 is the final wave and it lands the surface EXACTLY on the ceiling: 84
   * tools, 45 advertised. It added three domains, each of which needs one
   * advertised member for the invariant above to hold, and paid for two of
   * those three by deferring two previously-advertised tools — the mechanism
   * spec §3 mandates and D4 established, not a nudge of the number. Net effect
   * on what every model loads: +1.
   *
   * Pinned by name, like D4's trade, so a future wave that wants the room back
   * has to make the swap explicitly.
   */
  it('paid for D5 by deferring two more previously-advertised tools', () => {
    const registry = new McpToolRegistry();
    registerFullCatalogue(registry);
    const advertised = new Set(registry.listAdvertised(ALL_SCOPES).map((t) => t.name));
    for (const name of [
      // The last of the inbox-triage trio; assign/note went in D4. The inbox
      // keeps list/read/send — the verbs that matter per turn.
      'jeeta.close_conversation',
      // Only meaningful to a workspace that has provisioned a Growth Autopilot
      // budget; for everyone else it is an empty list in every session's
      // context. `jeeta.get_ad_performance` stays the ads domain's listed read.
      'jeeta.get_budget',
    ]) {
      expect(registry.get(name)!.defer).toBe(true);
      expect(advertised.has(name)).toBe(false);
    }
    // 45 DOMAIN tools advertised. `jeeta.call_tool` joins `jeeta.find_tools`
    // outside that budget: they are the discovery MECHANISM, and charging them
    // against it would mean deferring a real tool to pay for the ability to
    // reach deferred tools; adding the dispatcher costs no domain tool its slot.
    //
    // The number below is the ceiling, and the rule it carries is that a wave
    // which wants more must DEFER something rather than raise it. This prose
    // said 44 while the assertion said 45 — the drift is worth naming, because
    // a comment that disagrees with its own assertion is how the rule quietly
    // stops being one.
    expect(
      registry.listAdvertised(ALL_SCOPES).filter((t) => !DISCOVERY_TOOLS.includes(t.name)),
    ).toHaveLength(45);
    expect(registry.listAdvertised(ALL_SCOPES)).toHaveLength(45 + DISCOVERY_TOOLS.length);
    // 126 total, 45 advertised (+2 discovery) and 79 deferred: everything a
    // wave adds beyond the ceiling is deferred — which is exactly why the
    // advertised count above stayed fixed while the catalogue grew past a
    // hundred. Stage 4's two distribution tools are the newest pair, and both
    // are deferred for that reason. The number in this comment said 120 while
    // the assertion below said 123; a comment that disagrees with its own
    // assertion is how a measured figure quietly becomes a remembered one.
    expect(registry.list(ALL_SCOPES)).toHaveLength(126);
  });
});

/**
 * The undiscoverable-prerequisite tripwire.
 *
 * Three separate bugs this session had one shape: a tool REQUIRED an id and
 * nothing in the catalogue returned that id, so the operation was impossible —
 * not awkward, impossible. create_task needed an assignedToId with no way to
 * list users (v2.173.0); the inbox could read conversations but nothing could
 * create the channel they arrive on (v2.174.0); create_booking needed a
 * calendarId with no way to list calendars (v2.176.0). Each was found only by
 * running the flow for real.
 *
 * So the rule is now enforced instead of remembered: every REQUIRED `*Id`
 * parameter must name the tool a caller gets it from. Adding a tool with a new
 * required id fails here until its source is declared — which is the moment to
 * ask whether that source exists at all.
 */
/** Declares an id that legitimately has NO in-product source — it comes from
 *  outside Jeeta — so the gap is a recorded decision, not an oversight. */
const EXTERNAL = 'EXTERNAL';

const ID_SOURCES: Record<string, string> = {
  // leads / crm
  leadId: 'jeeta.search_leads',
  leadIds: 'jeeta.search_leads',
  canonicalId: 'jeeta.list_duplicate_leads',
  duplicateIds: 'jeeta.list_duplicate_leads',
  companyId: 'jeeta.list_companies',
  adAccountId: 'jeeta.list_ad_accounts',
  // A Meta/TikTok campaign or ad-set id. It lives in the ad provider's own
  // console, never in Jeeta's tables, so no read tool here can supply it —
  // the operator pastes it. Declared rather than left blank so the next
  // reader knows this was decided, not missed.
  entityId: EXTERNAL,
  opportunityId: 'jeeta.list_opportunities',
  taskId: 'jeeta.list_tasks',
  assignedToId: 'jeeta.list_team',
  // inbox
  conversationId: 'jeeta.list_conversations',
  agentId: 'jeeta.list_agents',
  agentProfileId: 'jeeta.list_agents',
  channelId: 'jeeta.list_conversations',
  // scheduling
  calendarId: 'jeeta.list_calendars',
  // campaigns / content / social
  campaignId: 'jeeta.list_campaigns',
  postId: 'jeeta.list_scheduled_posts',
  // The calendar slot. It had NO source until 2026-09-01: list_social_campaigns
  // returned campaigns and stopped there, so an agent could see that a campaign
  // existed and never learn the id of a single thing in it. That tool now
  // includes each campaign's recent items, which is what makes this line true
  // rather than aspirational — the tripwire working exactly as intended.
  campaignItemId: 'jeeta.list_social_campaigns',
  targetAccountIds: 'jeeta.list_social_accounts',
  assetId: 'jeeta.list_generated_media',
  emailTemplateId: 'jeeta.list_email_templates',
  // strategy / research / workflows
  actionId: 'jeeta.list_strategy_actions',
  profileId: 'jeeta.list_research_profiles',
  candidateIds: 'jeeta.list_research_candidates',
  // The MCP research lane leases a job and every subsequent call names it.
  jobId: 'jeeta.claim_research_job',
  workflowId: 'jeeta.list_workflows',
  // commerce / reviews / courses
  invoiceId: 'jeeta.list_invoices',
  productId: 'jeeta.list_products',
  reviewId: 'jeeta.list_reviews',
  courseId: 'jeeta.list_courses',
  budgetId: 'jeeta.get_budget',
  conceptId: 'jeeta.list_content_concepts',
};

describe('MCP catalogue — every required id must be discoverable', () => {
  it('names a source tool for each required *Id parameter, and that tool exists', () => {
    const registry = new McpToolRegistry();
    registerFullCatalogue(registry);
    const names = new Set(registry.list(ALL_SCOPES).map((t) => t.name));

    const undiscoverable: string[] = [];
    for (const tool of registry.list(ALL_SCOPES)) {
      // No try/catch: a schema this test cannot read is a FINDING, not
      // something to skip. Swallowing the failure is exactly what made the
      // first version of this tripwire pass vacuously — it scanned 90 tools
      // and saw zero id parameters because `z` was not imported and every
      // conversion threw into the catch.
      const json = z.toJSONSchema(tool.inputSchema as never) as { required?: string[] };
      for (const key of json.required ?? []) {
        // `Ids?`, not `Id` — a bulk tool requiring `candidateIds: string[]` is
        // exactly as impossible to call as one requiring `candidateId`, and the
        // singular-only regex let the entire plural family through unchecked.
        if (!/Ids?$/.test(key)) continue;
        const source = ID_SOURCES[key];
        if (!source) {
          undiscoverable.push(`${tool.name} requires "${key}" — no source declared in ID_SOURCES`);
        } else if (source !== EXTERNAL && !names.has(source)) {
          undiscoverable.push(`${tool.name} requires "${key}" — declared source ${source} is not in the catalogue`);
        }
      }
    }

    expect(undiscoverable).toEqual([]);
  });
});

/**
 * The connector-doc tripwire.
 *
 * `docs/marketing/mcp-connector.md` is what an integrator reads instead of the
 * registry, and it had drifted THIRTY tools behind: a third of the deferred
 * surface did not exist as far as that reader was concerned, and the only
 * mechanism for calling a deferred tool (`jeeta.call_tool`) was not mentioned in
 * it anywhere — so the doc described a catalogue two thirds of which it also
 * made unreachable.
 *
 * Nothing caught that, because a document cannot fail CI on its own. The
 * assertions above pin the catalogue's SIZE; this pins its DESCRIPTION. Cost is
 * one table row per new tool, which is the trade: the drift was silent, and the
 * whole failure class on this codebase is silence.
 */
describe('mcp-connector.md keeps up with the registry', () => {
  const docPath = join(process.cwd(), '..', 'docs', 'marketing', 'mcp-connector.md');

  it('documents every registered tool', () => {
    const registry = new McpToolRegistry();
    registerFullCatalogue(registry);
    const doc = readFileSync(docPath, 'utf8');

    const missing = registry
      .list(ALL_SCOPES)
      .map((t) => t.name)
      .filter((name) => !doc.includes(`\`${name}\``));

    expect(missing).toEqual([]);
  });

  it('explains how a deferred tool is actually called', () => {
    // find_tools only FINDS. Without call_tool an integrator can see the other
    // two thirds of the catalogue and reach none of it.
    expect(readFileSync(docPath, 'utf8')).toContain('jeeta.call_tool');
  });
});
