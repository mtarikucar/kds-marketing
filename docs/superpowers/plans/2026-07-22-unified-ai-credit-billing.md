# AI-Credit Billing — Social/X Metering (REVISED)

> **Revised 2026-07-22 after codebase discovery:** the unified AI-credit billing engine ALREADY EXISTS + is live (see spec §"correction"). Do NOT build a parallel wallet/ledger/guard/grant/top-up. The ONLY real gap is that **social/X publishing (+ future reading) is not metered** into it. This plan covers just that delta.

**What already exists (reuse, don't rebuild):**
- `marketing/ai/ai-credits.service.ts` `AiCreditsService.reserve/refund/chargeOverage/usage` (advisory-lock, monthly `UsageCounter`, `AI_CREDITS_EXHAUSTED` at cap).
- `marketing/ai/ai-credit-costs.ts` `AI_CREDIT_COSTS`/`creditCost()` (COARSE scale: 1 cr ≈ 1 action; media.image=3, media.video=15) — tripwire-pinned by `ai-credit-costs.tripwire.spec.ts`.
- Plan allowance `Package.limits.aiCreditsMonthly` (`billing/entitlements.service.ts`). Top-up = `ai_credit_boost_500` add-on.
- Wired everywhere (fal, ask-ai, content, workflows, conversation-ai).

**Scope decision:** only **X** publishing has a per-post $ cost (Meta/IG/LinkedIn/TikTok publish are free) → meter X only. Reads/listening = later (X is publish-only today).

---
## Task 1 — add X publish costs to the cost catalog (TDD)
- Modify `marketing/ai/ai-credit-costs.ts`: add
  - `'social.publish.x': { credits: 2, tier: 'light' }`  // X $0.015 → ceil(/$0.01) = 2 cr
  - `'social.publish.x_link': { credits: 20, tier: 'light' }`  // X $0.20 → ceil(/$0.01) = 20 cr
- Update `ai-credit-costs.tripwire.spec.ts` to pin the two new costs (the tripwire FAILS until pinned — intended gate).
- `tier` here is only used for LLM model selection elsewhere; publishing doesn't call an LLM, so `light` is a harmless placeholder — but confirm `tierFor` isn't misused for social actions (it won't be; publish path never calls anthropic).

## Task 2 — meter the X publish path (TDD)
- Modify `social-planner/network-adapters.ts`: the Twitter branch (`publishTwitter`) must charge credits.
  - The adapter needs `workspaceId` + an `AiCreditsService` handle. If `publishToNetwork` doesn't already carry `workspaceId`/DI, thread it from the caller (`publishDuePost`/`SocialPlannerService`), OR do the reserve/refund at the SERVICE layer that owns `workspaceId` + the `AiCreditsService` injection (cleaner — one wrap around the publish call, X-only branch). PREFER the service layer.
  - Before publish: `const action = hasUrl(post.body) ? 'social.publish.x_link' : 'social.publish.x'; await credits.reserve(workspaceId, creditCost(action));`
  - On publish failure/throw: `await credits.refund(workspaceId, creditCost(action));`
  - `hasUrl` = a simple URL detector on the tweet text (reuse any existing util; else a small regex).
- If `reserve` throws `AI_CREDITS_EXHAUSTED`, the post fails with that reason (surface to the user as "out of credits" — the frontend already handles the 403 code elsewhere; verify the social-planner error surface shows it).
- Tests: X text post reserves 1; X link post reserves the link cost; refund on publish failure; non-X networks reserve NOTHING (Meta/IG/LinkedIn/TikTok unchanged); exhausted → post FAILED with AI_CREDITS_EXHAUSTED.

## Task 3 — verify + plan-value tuning (config, no code)
- Confirm the per-plan `Package.limits.aiCreditsMonthly` seed values are sane now that social publishing consumes credits (a heavy poster shouldn't be starved). If needed, bump plan allowances / add a larger boost pack — CONFIG/seed change, discuss values with owner.
- Backend targeted suites (`ai-credit*`, `network-adapters*`, `social-planner*`) + build green. Commit + push.

---
## Later (not now)
- X **reads/listening** metering — when those X features are built (publish-only today). Meter per-read/batch on the same catalog + a per-workspace read budget.
- If a fine-grained $-based credit scale is ever wanted, that's a separate migration of the WHOLE meter (out of scope; the coarse action-based scale is the live reality).

## RESOLVED / SHIPPED (2026-07-22, commit da2ff19)
- **Scale question settled by the codebase's OWN anchor** (`media-models.config.ts`): "~1 credit ≈ $0.01, rounded up to never under-charge". So X costs = ceil(usd/$0.01): **x = 2 cr** ($0.015), **x_link = 20 cr** ($0.20). No coarse-vs-fine dilemma — the system already runs one consistent $/credit scale (image $0.03→3, video-pro $0.15/s→15/s).
- **Task 1 + 2 SHIPPED:** X publish metered into `AiCreditsService` (reserve before publish; refund on BOTH returned-`{ok:false}` AND thrown error, no double-refund; `AI_CREDITS_EXHAUSTED` fails only that target, fan-out survives); non-X untouched. Tripwire-pinned. 167 social-planner/ai-credit tests green.
- **Deferred (feature not built):** X reads/search/thread-reply metering — wire when those X features exist (publish-only today), with a per-workspace read budget.
- **Owner product decision (config, no code):** plan `aiCreditsMonthly` (STARTER 500 / GROWTH 2000 / SCALE 6000) predate social metering — at 20 cr/link-tweet STARTER ≈ 25 link tweets/mo. Keep values + drive overage via `ai_credit_boost` add-ons (matches the included+overage model), or raise plan credits. Either is a seed/config change.
