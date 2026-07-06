# Growth Autopilot — Content Arm (design spec)

**Goal:** one autonomy switch auto-provisions social content per connected account (no hand-authoring), fulfilling "the engine grows my sales." Fills the `contentCampaign: null` seam in `budget-quickstart.service.ts`.

**Status:** planned, not built. Prereq shipped: Autopilot-first Studio + autonomy LIVE (PR #121, `GROWTH_AUTOPILOT_AUTONOMY=1`).

## The seam & smallest correct build (verified against code)
- `budget-quickstart.service.ts:99` (after the allocation loop), gated on `armed && socialCount > 0`: for each connected `SocialAccount`, call `SocialCampaignsService.create()` with the fully-autonomous tuple **`automationMode: 'FULL_AUTO'` + `planningMode: 'AI_FULL'`**, `targetAccountIds: [account.id]`, a default cadence, `mediaKinds: ['IMAGE']`, `brief` from wallet/goal + BrandKit — then `activate()` (create alone = DRAFT). Replace `contentCampaign: null` (`:22-23`, `:115`) with `{ campaignIds, count }`.
- FULL_AUTO + AI_FULL bypasses every human gate: `planTick:402` (auto-fanout), `generateItem:479` (→SCHEDULED), `confirmItem:536-539` (auto-publish once media READY + dailyPublishCap + brand-safety). No user confirm.

## Blockers to resolve first
1. **createdById** — thread from the controller: `marketing-budget.controller.ts:102-103` has `a` (MarketingUserPayload) but passes only `dto`; add `a.id` → `QuickStartInput.createdById`.
2. **Idempotency marker (needs a migration)** — `SocialCampaign` has NO engine-owned/period field (only `linkedCampaignId`). Add a column (e.g. `engineBudgetId String?` + reuse `periodKey`, or `sourceType 'ENGINE'`) so quickStart re-runs don't create duplicate content campaigns per account per period. This is the one schema change.

## Bundled deletions (do together — else regression)
- **#4 collapse the 3 axes** — `arm` (Budget.autonomyLevel) DERIVES SocialCampaign.automationMode/planningMode at provision time. Remove the per-campaign Modes editor (`SocialCampaignDetailPage.tsx:176-220` + `modes` mutation) and builder steps 3/4. Readers stay (see blast-radius list in the exploration), only their INPUT becomes the one switch.
- **#10 remove the 6-step builder from the user path** — drop `/social-campaigns/new` route (`App.tsx:266` + import `:90`), retire `SocialCampaignBuilder.tsx`, remove the `SocialCampaignsPage.tsx:39` CTA; detail page becomes read-only monitoring (hero + calendar + approval-queue). Backend create/PATCH become engine-internal.

## Out of scope (net-new, not a seam fill)
Email/SMS/WhatsApp: `conversation-spend.service.ts` already settles + draws down the wallet POST-send, but nothing PACES volume (no consumer reads SMS/WHATSAPP allocations to trigger sends). "Auto-grow outreach" via the budget engine would be net-new work — defer.

## Guardrails
- Same `growthAutopilotAutonomyEnabled()` env flag that gates `armed`.
- Idempotency: skip accounts already backing an active engine-owned campaign for the period.
- Brand-safety + dailyPublishCap already enforced in `confirmItem`.
- First-posts safety: consider an OFF-by-default "show before posting" toggle for a workspace's first N autonomous posts (posting is the one Kill-switch-irreversible action).
