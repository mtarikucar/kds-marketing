/**
 * Seed/refresh the package catalog. Idempotent (upsert on code) — run on
 * every deploy:  npx ts-node prisma/seed-packages.ts
 *
 * ONE SELLABLE PACKAGE (2026-08). The three-tier ladder (STARTER/GROWTH/SCALE)
 * was collapsed into a single `JEETA` plan: buying it unlocks the product.
 * What remains alongside it:
 *   - TRIAL     — 14 days, every feature on, small meters. Granted at signup.
 *   - JEETA     — the only thing anyone can buy.
 *   - the old tiers — RETIRED and hidden, NEVER deleted (see below).
 *   - OPERATOR  — internal, unlimited.
 *
 * WHY THE OLD TIERS STAY. `WorkspaceSubscription.packageId` is a plain String
 * with no FK (schema.prisma:1435), and `EntitlementsService.compute()` returns
 * zeroEntitlements when the referenced Package row is missing
 * (entitlements.service.ts:218-223). Deleting a tier would therefore not fail
 * loudly — it would silently dark every workspace still pointing at it.
 * `status: 'RETIRED'` + `isPublic: false` already removes them from the
 * pricing table, the checkout guard and the operator picker, which is all the
 * removal that is actually needed. Their features are raised to match JEETA so
 * that a stray legacy subscription gets the full product rather than a
 * frozen-in-time subset.
 *
 * WHY THESE BLOCKS ARE NOT DRY. Every customer-facing package now carries the
 * same feature set, so a shared constant is the obvious refactor — and it
 * would red-build. `entitlements.tripwire.spec.ts:64,82` reads THIS FILE AS
 * TEXT and requires every feature and limit block to list each key literally;
 * a `{...ALL_FEATURES}` spread parses to zero keys. The duplication is the
 * tripwire working as designed: a new FEATURE_KEY must be answered explicitly
 * for every package, not silently inherited.
 *
 * (Note for future editors: the tripwire scans for the literal block openers,
 * so do not write one inside a comment either — an empty pair reads as a
 * package that grants nothing and fails the build.)
 *
 * `features` keys MUST mirror FEATURE_KEYS and `limits` keys MUST mirror
 * LIMIT_KEYS in entitlements.service.ts. -1 = unlimited.
 *
 * Limit philosophy (unchanged, and load-bearing now that one plan fits all):
 * meters that cost Jeeta real vendor money stay BOUNDED — aiCreditsMonthly and
 * messagesMonthly (Anthropic/fal.ai/SMTP), maxResearchProfiles and
 * dailyLeadQuota (they drive the nightly research agent), maxKnowledgeDocs
 * (storage). Meters that cost nothing but configuration go unlimited: seats,
 * workflows, funnels, calendars, agents. `-1` on a cost-bearing meter does not
 * merely raise the ceiling, it takes the fast path in AiCreditsService.reserve
 * and turns the meter OFF entirely — no backstop at all.
 *
 * The three add-on-only capabilities (smsOtp, voiceCampaigns, fax) remain
 * false on every package INCLUDING JEETA. They are not gated for revenue —
 * each requires a separately purchased NetGSM package upstream, so granting
 * them in-plan would surface a capability the account may not actually have.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PACKAGES = [
  {
    code: 'TRIAL',
    name: 'Trial',
    description: '14 gün boyunca Jeeta’nın tamamı — kart gerekmez.',
    dailyLeadQuota: 5,
    maxUsers: 3,
    maxResearchProfiles: 1,
    features: {
      autoAssign: true,
      telephony: true,
      installations: true,
      commissions: true,
      advancedReports: true,
      apiAccess: true,
      conversationAi: true,
      sms: true,
      // Add-on only (WorkspaceAddOn grants `feature.smsOtp`) — needs a paid
      // NetGSM OTP package upstream. False on every plan, no exceptions.
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
      // Add-on only — requires a purchased NetGSM voice-campaign package.
      voiceCampaigns: false,
      // Add-on only — requires a purchased NetGSM fax package.
      fax: false,
    },
    limits: {
      // Sized to complete onboarding and genuinely try the product: the
      // strategy wizard alone costs interview turns + one synthesis.
      aiCreditsMonthly: 300,
      messagesMonthly: 250,
      maxAgents: 2,
      maxWorkflows: 5,
      maxFunnels: 2,
      maxKnowledgeDocs: 10,
      maxCalendars: 2,
    },
    priceMonthlyTRY: 0,
    priceMonthlyUSD: 0,
    trialDays: 14,
    isPublic: false, // granted at signup, never bought
    status: 'ACTIVE',
    sortOrder: 0,
  },
  {
    code: 'JEETA',
    name: 'Jeeta',
    description:
      'Tek paket, tamamı açık — AI stratejisti, otomasyonlar, kampanyalar, çağrı merkezi ve raporlar.',
    // Cost-bearing: the nightly research agent runs per profile, per day.
    dailyLeadQuota: 50,
    // Seats cost Jeeta nothing — a growing team must not hit a wall when
    // there is no higher tier left to sell them.
    maxUsers: -1,
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
      voiceCampaigns: false,
      fax: false,
    },
    limits: {
      // Deliberately modest, with self-serve top-up as the release valve:
      // credits map to real Anthropic/fal.ai spend. Calibrated against the
      // repriced ai-credit-costs table, NOT the old one.
      aiCreditsMonthly: 1500,
      messagesMonthly: 2500,
      maxAgents: -1,
      maxWorkflows: -1,
      maxFunnels: -1,
      maxKnowledgeDocs: 500,
      maxCalendars: -1,
    },
    priceMonthlyTRY: 6900,
    priceMonthlyUSD: 149,
    // Two months free, matching the yearly framing the pricing UI already uses.
    priceYearlyTRY: 69000,
    priceYearlyUSD: 1490,
    trialDays: 0,
    isPublic: true,
    status: 'ACTIVE',
    sortOrder: 1,
  },
  {
    // RETIRED 2026-08 — kept so existing subscriptions keep resolving.
    code: 'STARTER',
    name: 'Starter (retired)',
    description: 'Kapatıldı — Jeeta paketine geçildi.',
    dailyLeadQuota: 50,
    maxUsers: -1,
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
      voiceCampaigns: false,
      fax: false,
    },
    limits: {
      aiCreditsMonthly: 1500,
      messagesMonthly: 2500,
      maxAgents: -1,
      maxWorkflows: -1,
      maxFunnels: -1,
      maxKnowledgeDocs: 500,
      maxCalendars: -1,
    },
    priceMonthlyTRY: 3490,
    priceMonthlyUSD: 99,
    priceYearlyTRY: 34900,
    priceYearlyUSD: 990,
    trialDays: 0,
    isPublic: false,
    status: 'RETIRED',
    sortOrder: 90,
  },
  {
    // RETIRED 2026-08 — kept so existing subscriptions keep resolving.
    code: 'GROWTH',
    name: 'Growth (retired)',
    description: 'Kapatıldı — Jeeta paketine geçildi.',
    dailyLeadQuota: 50,
    maxUsers: -1,
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
      voiceCampaigns: false,
      fax: false,
    },
    limits: {
      aiCreditsMonthly: 1500,
      messagesMonthly: 2500,
      maxAgents: -1,
      maxWorkflows: -1,
      maxFunnels: -1,
      maxKnowledgeDocs: 500,
      maxCalendars: -1,
    },
    priceMonthlyTRY: 8490,
    priceMonthlyUSD: 249,
    priceYearlyTRY: 84900,
    priceYearlyUSD: 2490,
    trialDays: 0,
    isPublic: false,
    status: 'RETIRED',
    sortOrder: 91,
  },
  {
    // RETIRED 2026-08 — kept so existing subscriptions keep resolving.
    code: 'SCALE',
    name: 'Scale (retired)',
    description: 'Kapatıldı — Jeeta paketine geçildi.',
    dailyLeadQuota: 50,
    maxUsers: -1,
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
      voiceCampaigns: false,
      fax: false,
    },
    limits: {
      aiCreditsMonthly: 1500,
      messagesMonthly: 2500,
      maxAgents: -1,
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
    isPublic: false,
    status: 'RETIRED',
    sortOrder: 92,
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
      // Still add-on only, even here: the constraint is NetGSM-side, not
      // commercial, so an internal workspace cannot conjure the capability.
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
      voiceCampaigns: true,
      fax: true,
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
    status: 'ACTIVE',
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
    console.log(`package ready: ${code} (${data.status})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
