# Epic G — Analytics depth — design

**Date:** 2026-06-16
**Status:** autonomous (user no-ask) — controller-made
**Program:** GoHighLevel feature-parity, Epic G (independent off main)

## Goal
Deeper lead analytics than the existing dashboard/reports: a **conversion-funnel
waterfall**, **source** and **business-type** breakdowns, and **rep performance**
with conversion rates. Purely read-only aggregation over the leads table — no
schema, no writes — so it is safe to add to a live system.

## Decisions
- `AnalyticsService` (`analytics/` folder, registered in the marketing module),
  guarded by `MarketingGuard`/`MarketingRolesGuard`, workspace-scoped.
- Aggregation via Prisma `groupBy` + `_count` (every query pins `workspaceId` —
  arch-fitness green). Optional `from`/`to` date range.
- Endpoints: `GET /marketing/analytics/{funnel,by-source,by-business-type,rep-performance}`.

## Non-goals (this epic)
- Time-series / cohort retention via raw SQL date-bucketing (follow-up).
- Multi-touch revenue attribution (needs the conversion-value model).
- A BI export surface.

## Testing
- Unit: funnel totals + conversion rate + ordered waterfall; date-range pinning;
  source sort; rep roll-up. E2E: funnel + source breakdown. Full suite green.
