/**
 * Seed/refresh the package catalog. Idempotent (upsert on code) — run on
 * every deploy:  npx ts-node prisma/seed-packages.ts
 *
 * Pricing anchors (2026-06): based on the research routine's measured
 * output of 10–20 qualified leads/day/profile and an estimated COGS of
 * ~$1.5–3/day/profile in research tokens + scraping credits. TRY prices
 * are positioned for the local market, not FX-converted.
 *
 * `features` keys MUST mirror FEATURE_KEYS in entitlements.service.ts —
 * the tripwire spec fails the build when they drift.
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
