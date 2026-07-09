/**
 * Seed/refresh the package catalog. Idempotent (upsert on code) — run on
 * every deploy:  npx ts-node prisma/seed-packages.ts
 *
 * Pricing anchors (2026-06): based on the research routine's measured
 * output of 10–20 qualified leads/day/profile and an estimated COGS of
 * ~$1.5–3/day/profile in research tokens + scraping credits. The Phase-F
 * (GoHighLevel-parity) AI features add a second COGS axis — LLM tokens and
 * outbound messages — metered per workspace via `limits` below.
 *
 * `features` keys MUST mirror FEATURE_KEYS and `limits` keys MUST mirror
 * LIMIT_KEYS in entitlements.service.ts — the tripwire spec fails the build
 * when either drifts. Every package lists EVERY key explicitly (a missing
 * key reads as "forgot", not "off"). -1 = unlimited.
 *
 * Limit philosophy: cost-bearing meters (aiCreditsMonthly, messagesMonthly,
 * maxAgents, maxKnowledgeDocs) stay bounded at every paid tier and only go
 * unlimited on the internal OPERATOR package; pure config counts (workflows,
 * funnels, calendars) open up at SCALE.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PACKAGES = [
  {
    code: 'TRIAL',
    name: 'Trial',
    description: '14 days to see the nightly research agent fill your pipeline.',
    dailyLeadQuota: 3,
    maxUsers: 2,
    maxResearchProfiles: 1,
    features: {
      autoAssign: true,
      telephony: false,
      installations: false,
      commissions: false,
      advancedReports: false,
      apiAccess: false,
      conversationAi: true,
      sms: true,
      // NetGSM SMS v2 Task 12 — paid add-on only (WorkspaceAddOn grants
      // `feature.smsOtp`); false on every plan, no exceptions.
      smsOtp: false,
      workflows: true,
      campaigns: false,
      funnels: true,
      reviews: false,
      askAi: true,
      agentStudio: true,
      voiceAi: false,
      invoicing: false,
      memberships: true,
      research: true,
      mediaGen: false,
      socialCampaigns: false,
    },
    limits: {
      aiCreditsMonthly: 100,
      messagesMonthly: 100,
      maxAgents: 1,
      maxWorkflows: 3,
      maxFunnels: 1,
      maxKnowledgeDocs: 5,
      maxCalendars: 1,
    },
    priceMonthlyTRY: 0,
    priceMonthlyUSD: 0,
    trialDays: 14,
    isPublic: false, // granted at signup, never bought
    sortOrder: 0,
  },
  {
    code: 'STARTER',
    name: 'Starter',
    description: '10 AI-researched leads every day, reports included.',
    dailyLeadQuota: 10,
    maxUsers: 3,
    maxResearchProfiles: 1,
    features: {
      autoAssign: true,
      telephony: false,
      installations: false,
      commissions: false,
      advancedReports: true,
      apiAccess: false,
      conversationAi: true,
      sms: true,
      // NetGSM SMS v2 Task 12 — paid add-on only (WorkspaceAddOn grants
      // `feature.smsOtp`); false on every plan, no exceptions.
      smsOtp: false,
      workflows: true,
      campaigns: true,
      funnels: true,
      reviews: false,
      askAi: true,
      agentStudio: true,
      voiceAi: false,
      invoicing: false,
      memberships: true,
      research: true,
      mediaGen: false,
      socialCampaigns: false,
    },
    limits: {
      aiCreditsMonthly: 500,
      messagesMonthly: 1000,
      maxAgents: 1,
      maxWorkflows: 10,
      maxFunnels: 3,
      maxKnowledgeDocs: 20,
      maxCalendars: 2,
    },
    priceMonthlyTRY: 3490,
    priceMonthlyUSD: 99,
    priceYearlyTRY: 34900,
    priceYearlyUSD: 990,
    trialDays: 0,
    isPublic: true,
    sortOrder: 1,
  },
  {
    code: 'GROWTH',
    name: 'Growth',
    description:
      '25 leads/day across two research focuses, with click-to-call for the team.',
    dailyLeadQuota: 25,
    maxUsers: 10,
    maxResearchProfiles: 2,
    features: {
      autoAssign: true,
      telephony: true,
      installations: false,
      commissions: false,
      advancedReports: true,
      apiAccess: false,
      conversationAi: true,
      sms: true,
      // NetGSM SMS v2 Task 12 — paid add-on only (WorkspaceAddOn grants
      // `feature.smsOtp`); false on every plan, no exceptions.
      smsOtp: false,
      workflows: true,
      campaigns: true,
      funnels: true,
      reviews: true,
      askAi: true,
      agentStudio: true,
      voiceAi: false,
      invoicing: true,
      memberships: true,
      research: true,
      mediaGen: true,
      socialCampaigns: true,
    },
    limits: {
      aiCreditsMonthly: 2000,
      messagesMonthly: 5000,
      maxAgents: 3,
      maxWorkflows: 30,
      maxFunnels: 10,
      maxKnowledgeDocs: 100,
      maxCalendars: 5,
    },
    priceMonthlyTRY: 8490,
    priceMonthlyUSD: 249,
    priceYearlyTRY: 84900,
    priceYearlyUSD: 2490,
    trialDays: 0,
    isPublic: true,
    sortOrder: 2,
  },
  {
    code: 'SCALE',
    name: 'Scale',
    description:
      '50 leads/day, field operations (installations), commissions and API access.',
    dailyLeadQuota: 50,
    maxUsers: 25,
    maxResearchProfiles: 4,
    features: {
      autoAssign: true,
      telephony: true,
      installations: true,
      commissions: true,
      advancedReports: true,
      apiAccess: true,
      conversationAi: true,
      sms: true,
      // NetGSM SMS v2 Task 12 — paid add-on only (WorkspaceAddOn grants
      // `feature.smsOtp`); false on every plan, no exceptions.
      smsOtp: false,
      workflows: true,
      campaigns: true,
      funnels: true,
      reviews: true,
      askAi: true,
      agentStudio: true,
      voiceAi: true,
      invoicing: true,
      memberships: true,
      research: true,
      mediaGen: true,
      socialCampaigns: true,
    },
    limits: {
      aiCreditsMonthly: 6000,
      messagesMonthly: 20000,
      maxAgents: 10,
      maxWorkflows: -1,
      maxFunnels: -1,
      maxKnowledgeDocs: 500,
      maxCalendars: -1,
    },
    priceMonthlyTRY: 16900,
    priceMonthlyUSD: 499,
    priceYearlyTRY: 169000,
    priceYearlyUSD: 4990,
    trialDays: 0,
    isPublic: true,
    sortOrder: 3,
  },
  {
    code: 'OPERATOR',
    name: 'Operator (internal)',
    description: 'Unlimited internal package for the platform-owner workspace.',
    dailyLeadQuota: -1,
    maxUsers: -1,
    maxResearchProfiles: -1,
    features: {
      autoAssign: true,
      telephony: true,
      installations: true,
      commissions: true,
      advancedReports: true,
      apiAccess: true,
      conversationAi: true,
      sms: true,
      // NetGSM SMS v2 Task 12 — paid add-on only (WorkspaceAddOn grants
      // `feature.smsOtp`); false on every plan, no exceptions.
      smsOtp: false,
      workflows: true,
      campaigns: true,
      funnels: true,
      reviews: true,
      askAi: true,
      agentStudio: true,
      voiceAi: true,
      invoicing: true,
      memberships: true,
      research: true,
      mediaGen: true,
      socialCampaigns: true,
    },
    limits: {
      aiCreditsMonthly: -1,
      messagesMonthly: -1,
      maxAgents: -1,
      maxWorkflows: -1,
      maxFunnels: -1,
      maxKnowledgeDocs: -1,
      maxCalendars: -1,
    },
    priceMonthlyTRY: 0,
    priceMonthlyUSD: 0,
    trialDays: 0,
    isPublic: false,
    sortOrder: 99,
  },
];

async function main() {
  for (const pkg of PACKAGES) {
    const { code, ...data } = pkg;
    await prisma.package.upsert({
      where: { code },
      create: { code, ...data },
      update: data,
    });
    console.log(`package ready: ${code}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
