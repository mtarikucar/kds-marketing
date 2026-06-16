# GoHighLevel Parity Program — Charter & Roadmap

**Date:** 2026-06-16
**Status:** active autonomous program (controller-decided; `/goal` = "add everything GHL has, end-to-end, frontends + tests, including account/setup-requiring things").
**Integration branch:** `feat/ghl-parity` (off `origin/main` @ 878ae47, which includes the Console frontend redesign). Work in the isolated worktree `~/.config/superpowers/worktrees/kds-marketing-ghl-parity`. Keep it green; merge to main in vetted slices.

## Strategy
- **Single integration line** (`feat/ghl-parity`) assembles everything end-to-end. The 9 in-flight epic PRs (#28–#36) are folded in here (superseding their individual stacked PRs), fixed, and greened.
- **Backend → frontend → e2e** per capability. Console design system (`@/components/ui`) for all UI.
- **Keep green at every slice:** backend `tsc + migrate-parity + test + e2e + build`; frontend `lint + test + build`. Workspace-isolation fitness test extended for **every** new owned table.
- **Decisions are mine** (autonomous goal). Logged at the bottom.

## Credential boundary (honest)
I cannot create the operator's real third-party accounts. For credential-gated integrations I build the **full framework + sandbox/test path + contract tests**, env-gated, and list exactly which secret flips it live. I will NOT claim a live integration works without its credential. Secrets the operator must supply to go live:
- **Stripe Connect** (agency rebilling / SaaS-mode): `STRIPE_CONNECT_CLIENT_ID` + platform secret (+ Connect webhook secret). Test mode works with Stripe test keys.
- **Google OAuth** (Calendar 2-way, GMB, social): `GOOGLE_OAUTH_CLIENT_ID/SECRET`.
- **SSO/OIDC**: IdP `issuer` + `client_id` + `client_secret`.
- **Social networks** (planner): per-network app creds (Meta/LinkedIn/etc.).
Everything else (data model, internal logic, UI, settlement math, scheduling, tests) is built and tested without them.

## Gap analysis — GHL pillar → our status
- 🟢 have · 🟡 built-not-merged (the 9 epics) · 🔵 build in this program · 🔴 needs operator credential to go live (framework still built)

| Pillar | Status |
|---|---|
| CRM/pipeline + custom fields/tags/segments/dedupe/import | 🟢/🟡 (#28) |
| Omnichannel inbox (SMS/email/WA/FB/IG/GMB/webchat) | 🟢 partial → 🔵 fill missing channels |
| Calendars/booking | 🟢 · GCal 2-way 🔵🔴 |
| Funnels/sites/forms + **A/B + surveys** | 🟢 + 🟡 (#33) |
| Email/SMS campaigns + workflows | 🟢 |
| Memberships: courses/communities | 🟡 (#30) |
| Reviews/reputation | 🟢 |
| Analytics + **attribution** | 🟢 + 🟡 (#31, attribution missing → 🔵) |
| AI (conversation/voice/content) | 🟢 strong |
| Payments/invoicing | 🟢 |
| Telephony + IVR/phone-trees | 🟢 basic → 🔵 advanced |
| Public API + signed webhooks + app marketplace | 🟡 (#29) + 🔵 marketplace |
| Integrations: Slack / Zapier / GCal | 🟡 (#35) + 🔵🔴 |
| Security: 2FA / roles+permissions / SSO | 🟡 (#34/#36) + 🔵🔴 SSO |
| Compliance GDPR/KVKK | 🟡 (#32) |
| **Agency / sub-accounts / SaaS-mode / rebilling / snapshots** | 🔵🔴 (Epic D — biggest gap) |
| White-label (full: domain + mobile) | 🟢 lite → 🔵 |
| Social planner | 🔵🔴 |
| Affiliate manager | 🔵 |

## Phases (build order)

### Phase 1 — Integrate & green the 9 existing epics (foundation)
Fold #28→#36 into `feat/ghl-parity`, fixing the verified blockers:
1. **#28 GIN drift** — align `schema.prisma` `@@index([customFields], type: Gin)` with the migration's `USING GIN (customFields jsonb_path_ops)` (or vice-versa) so `prisma migrate diff` is clean. (Unblocks #29 too.)
2. **#34** — fix the 2FA `login()` union-return that broke `marketing-auth.workspace.spec.ts` (TS2339); add a real 2FA-aware assertion.
3. **#36** — actually wire `PermissionsGuard` + `@RequirePermission` onto the mutating endpoints (currently dead code).
4. **Fitness coverage** — add every new owned delegate (customFieldDef, tag, leadTag, segment, importJob/Row, apiKey, webhookEndpoint, webhookDelivery, consentRecord, dataRequest, experiment*, survey*, slackIntegration, customRole, course/enrollment/community*) to `OWNED_DELEGATES` and make the fitness test pass for real.
5. Green the full backend gate on the integration branch.

### Phase 2 — Missing backend capabilities for full parity
- **Epic D — Agency/sub-accounts/SaaS-mode**: agency→location hierarchy, snapshots (clone a workspace config), **rebilling** (per-location usage → agency invoice; env-gated Stripe Connect; internal settlement + test mode).
- **Attribution** (multi-touch + conversion value) — complete #31's deferred piece.
- **SSO/OIDC** (env-gated) · **Google Calendar 2-way** (env-gated) · **Social planner** (env-gated) · **Affiliate manager** · **Advanced IVR/phone-trees** · **App marketplace / OAuth apps** (extend public API) · enforce `@RequirePermission` across all modules.

### Phase 3 — Frontends (Console design system) for every epic
Custom-fields/tags/segments/import UI · API-keys/webhooks UI · memberships (courses/communities) UI · analytics dashboards · compliance console · A/B + survey builder · 2FA settings · Slack settings · roles/permissions editor · **agency/sub-account console** · social planner · affiliate UI · settings for each integration.

### Phase 4 — End-to-end, hardening, deploy readiness
Cross-feature e2e, seed/demo data, perf, docs, and a deploy plan (operator supplies credentials → flip integrations live → tag).

## Decision log
- **D1:** Single integration branch over juggling 9 stacked PRs — cleaner end-to-end line for the goal. Individual epic PRs are superseded by this branch.
- **D2:** GIN drift fixed by making `schema.prisma` declare the `jsonb_path_ops` opclass to match the (better) hand-authored migration, rather than dumbing the migration down.
- **D3:** Credential-gated integrations ship as env-gated frameworks with sandbox/contract tests; live activation is an operator step (secrets listed above).
- **D4:** Every new workspace-owned table MUST be added to the fitness test — non-negotiable gate.
