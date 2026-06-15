# Frontend Redesign — Phase 4: Remaining Marketing Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Migrate the remaining ~20 marketing pages + two dashboard feature widgets onto the Console design system, applying the same migration contract as Phase 3.

**Migration contract:** identical to `docs/superpowers/plans/2026-06-15-frontend-redesign-phase3-core-crm-pages.md` → "## Migration contract" (preserve all queries/mutations/routes/i18n/gating; apply `@/components/ui` primitives + tokens + RHF+Zod for forms; dark-mode-safe; lucide icons; split files >~300 lines into a per-page folder, update `App.tsx` import + delete the old file — NO orphans; per-task `npm test && npm run -s build` green then commit).

**Worktree:** `/home/tarik/.config/superpowers/worktrees/kds-marketing-frontend-redesign`; branch `feat/frontend-redesign`.

## Tasks (grouped; simple pages batched, complex pages solo)

### Task 1: Reporting/read pages batch — Reports, Performance, Calls
`src/pages/marketing/{ReportsPage,PerformancePage,CallsPage}.tsx`. Mostly read/display. Apply `PageHeader`, `Card`, `StatCard`, `Table`/`DataTable`, `Badge`, `EmptyState`/`Skeleton`, tokens. Preserve their queries + entitlement gating (`telephony` for Calls, manager-only Performance). One commit: `feat(frontend/pages): Reports, Performance, Calls — Console migration`.

### Task 2: Team & Targets — Users, Targets
`src/pages/marketing/{MarketingUsersPage,TargetsPage}.tsx`. Users (team mgmt, role assignment, invite/delete — manager-only): `DataTable` + `DropdownMenu` row actions + invite/edit `Dialog` (RHF+Zod, reuse `marketingUserSchema`) + `ConfirmDialog` delete. Targets: `Card` + form (RHF+Zod). Preserve all user/target queries+mutations. Commit: `feat(frontend/pages): Team & Targets — Console migration`.

### Task 3: Commissions & Installations — Commissions, Installations
`src/pages/marketing/{CommissionsPage,InstallationsPage}.tsx` (Installations ~594 lines — SPLIT into `installations/`). DataTable + status `Badge` + detail/approve flows in `Dialog` (reuse `CommissionDetailModal` re-skinned). Preserve commission approve/installation mutations + `commissions`/`installations` entitlement gating. Commit: `feat(frontend/pages): Commissions & Installations — Console migration`.

### Task 4: Billing & Invoices — BillingPage, InvoicesPage
`src/pages/marketing/{BillingPage,InvoicesPage}.tsx` (manager-gated; `invoicing` entitlement for Invoices). Billing summary + entitlements + invoice list → `Card`/`StatCard`/`DataTable`/`Badge`; money via existing `formatMoney`. Preserve billing/invoice queries+mutations + the money/entitlement logic EXACTLY (financial — do not alter amounts/rounding). Commit: `feat(frontend/pages): Billing & Invoices — Console migration`.

### Task 5: Growth settings batch A — Channels, Automations, Campaigns
`src/pages/marketing/{ChannelsSettingsPage,AutomationsPage,CampaignsPage}.tsx` (entitlement-gated, manager-only). Settings/list pages → `PageHeader`+`Card`+`DataTable`/`Table`+forms in `Dialog` (RHF+Zod). Preserve queries/mutations + `conversationAi`/`workflows`/`campaigns` gating. Commit: `feat(frontend/pages): Channels, Automations, Campaigns — Console migration`.

### Task 6: Growth settings batch B — Sites, Booking, Reviews, Voice
`src/pages/marketing/{SitesPage,BookingSettingsPage,ReviewsPage,VoicePage}.tsx` (`funnels`/`reviews`/`voiceAi` gating). Same treatment. Commit: `feat(frontend/pages): Sites, Booking, Reviews, Voice — Console migration`.

### Task 7: AI settings — Agent Studio, Knowledge, Research
`src/pages/marketing/{AgentStudioPage,KnowledgeBasePage,ResearchSettingsPage}.tsx` (`agentStudio`/`askAi` gating; Research ~433 lines). Config/settings pages → `Card`/`Tabs`/forms (RHF+Zod). Preserve queries/mutations. Commit: `feat(frontend/pages): Agent Studio, Knowledge, Research — Console migration`.

### Task 8: Branding + Inbox + dashboard widgets
`src/pages/marketing/BrandingSettingsPage.tsx` (branding form), `src/pages/marketing/InboxPage.tsx` (~433 lines, conversation AI — SPLIT if needed; preserve the conversation queries + send/reply + the `conversationAi` gating + mobile drill-down), and re-skin the two deferred dashboard widgets `features/marketing/components/{GettingStarted,NeedsAttention}.tsx` to tokens + lucide. Commit: `feat(frontend/pages): Branding, Inbox + dashboard widgets — Console migration`.

## Phase 4 Done — Definition of Done
- All remaining marketing pages render in Console, dark-mode-aware, behavior/routes/queries preserved; large files split; no orphaned pre-migration files.
- `test` + `build` green. **Next:** Phase 5 (platform realm + auth/widget pages + PlatformLayout).
