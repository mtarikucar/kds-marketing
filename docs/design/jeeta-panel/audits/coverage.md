# Rust panel coverage inventory

Audit baseline: `d5b8d296cdb20e8b457134d7a4dc863339098190`, compared with the
modern branch base `627f4fdb095c579bd80a7fb242afa30efd102fb8`. This inventories
the current `rust/panel/src` product, not the legacy `frontend/` application.
Working changes after the baseline need their own evidence before this document
can describe them as verified.

This is a bounded review checklist: every declared page, its currently implemented
controls and conditional surfaces, and representative UI states. It does not
claim that every combination of backend data, timing, permission and provider
response has been exercised. A source change, a passing component test and a
real-browser observation are different evidence.

## Router and ownership

`src/App.tsx` declares 38 page/fallback URL patterns including the home index,
plus the `/platform` index redirect. Dynamic parameters represent families of
pages, not a single fixture. `/outreach/new` and `/outreach/:campaignId` share a
component but represent distinct create/edit states.

`AppRoot` owns notifications above every route. `PublicLayout` wraps the four
public account routes; `Shell` wraps tenant routes; `PlatformShell` wraps the
three platform pages and its index redirect. Those layouts are also review
surfaces: session loading/error, navigation, workspace switching, permission
filtering, locale, theme, logout, mobile overflow and focus order.

Ownership below names this review's implementation groups. It does not change
application authorization. Module paths are relative to `rust/panel/src/pages/`.

| Declared URL | Route module | Owner | Implemented controls and conditional surfaces to review |
| --- | --- | --- | --- |
| `/login` | `LoginPage.tsx` | root | Email/password, submit, registration link, return destination, wrong credentials and request errors. |
| `/register` | `RegisterPage.tsx` | root | Identity/workspace fields, password validation, submit, existing-account link, conflict/error. |
| `/invite/:token` | `AcceptInvitePage.tsx` | root | Signed-in acceptance versus new-account form, existing-user sign-in return link, switch workspace, invalid/expired/wrong-user invite, accepted state. |
| `/platform/login` | `platform/PlatformLoginPage.tsx` | ui_system | Operator login, wrong credentials/error, separate operator session. |
| `/platform` (index) | `Navigate` | ui_system | Replace redirect to `/platform/workspaces`; platform session gate. |
| `/platform/workspaces` | `platform/WorkspacesPage.tsx` | ui_system | Workspace table, active/pending/suspended states, resume, suspend/revoke reason dialog and mutation results. |
| `/platform/payments` | `platform/PaymentsPage.tsx` | ui_system | Payment confirmation, activation-code delivery/reissue, revoke dialog, busy/error/empty states and ephemeral secrets. |
| `/platform/health` | `platform/HealthPage.tsx` | ui_system | Health summary, jobs/connectors/webhooks/backup state, unknown/degraded values, operator password-reset form. |
| `/` (index) | `HomePage.tsx` | root | Work queue and task links, strategy consultation/approval actions, agent interval editing, permissions disclosure, setup/empty work states. |
| `/billing` | `BillingPage.tsx` | ui_system | Payment details/copy, report-payment form, activation form, pending/confirmed/active/revoked states, role gates, no retained activation code. |
| `/onboarding` | `OnboardingPage.tsx` | root | Setup checklist, completed/pending steps and destination links; layout without a strategy or connected tools. |
| `/inbox` | `InboxPage.tsx` | inbox_design | Queue switch, paging, pending work, selected person/task via query parameters, no selection and empty queues. |
| `/inbox/:conversationId` | `InboxPage.tsx` + `InboxConversation.tsx` | inbox_design | Conversation, messages, executor control, snooze/close, composer, public items, customer context and journey surfaces listed below. |
| `/inbox/merges` | `InboxMerges.tsx` | inbox_design | Suggested/applied/refused/undone merges, keeper choice, apply/refuse, undo confirmation and person filtering. |
| `/inbox/commissions` | `InboxCommissions.tsx` | inbox_design | State/payee filters, rates, pending/approved/paid rows, approve/pay actions and role restrictions. |
| `/people` | `PeoplePage.tsx` | inbox_design | Name/company search, paging, customer links, initial empty and no-match result. |
| `/prospects` | `ProspectsPage.tsx` | leads_design | Pool filters, research-task query filter, paging, selection, qualify/reject/reopen, do-not-contact, promotion and partial bulk outcomes. |
| `/prospects/tasks` | `ResearchTasksPage.tsx` | leads_design | Create task, settings/playbook, status/progress, claim/release/close and closing reason, results links. |
| `/prospects/:prospectId` | `ProspectDetail.tsx` | leads_design | Evidence/scores/history/duplicates, decision actions, do-not-contact, promotion, erasure dialog, missing/stale records. |
| `/outreach` | `OutreachPage.tsx` | leads_design | Campaign/report summary, state filters, empty/no-match results, create/detail/template/settings navigation. |
| `/outreach/templates` | `OutreachTemplates.tsx` | leads_design | Create/edit/version/template preview, subject/body/variables, archived filter, archive and form feedback. |
| `/outreach/settings` | `OutreachSettings.tsx` | leads_design | Sender identity/address/privacy, approval/tracking, warmup and frequency, business-contact basis/IYS confirmation and role gates. |
| `/outreach/new` | `OutreachCampaign.tsx` | leads_design | New campaign definition, mailbox/audience/steps/schedule settings, validation and saving. |
| `/outreach/:campaignId` | `OutreachCampaign.tsx` | leads_design | Existing definition and audience preview, enrollment, approvals/start/pause/resume/stop/archive, enrollment/report states and unavailable mailbox. |
| `/calls` | `CallsPage.tsx` + `CallsPolicy.tsx` | inbox_design | Direction filters, list/paging, place-call dialog, call policy, disabled/missing capability and active/terminal call states. |
| `/calls/:callId` | `CallDetail.tsx` | inbox_design | Call metadata, status/outcome, notes/summary, transcript/recording/brief, human/agent actions, terminal/missing state. |
| `/strategy` | `StrategyPage.tsx`, `strategy/*.tsx` | design | Approved/draft tabs, all section editors, consultation entries, hypotheses/cadence, gaps, submit/approval/archive dialogs and versions history. |
| `/capabilities` | `CapabilitiesPage.tsx`, `capabilities/*.tsx` | ui_system | Kind/status/group filters, declare/edit/verify/policy/budget/unreachable/retire/probe, groups, phone/bridge/PBX and webhook leaves below. |
| `/connect` | `ConnectPage.tsx` + `ProviderSetup.tsx` | ui_system | Provider choice, OAuth start/reconnect, credentials, secret reveal, advanced/IYS forms, provider setup, selected kind/capability query state. |
| `/oauth/callback/:provider` | `OAuthCallbackPage.tsx` | ui_system | Code/state/error parsing, completion/failure, provider-account selection/confirmation, remembered flow, back navigation and repeat/stale callback. |
| `/budget` | `BudgetPage.tsx` | ui_system | Budget items, create/edit/retire, kind/unit/period/cap validation, spend sheet/history/paging, over-cap and empty states. |
| `/team` | `TeamPage.tsx` | ui_system | Invite, one-time invite link, pending invitations/revoke, membership role changes/remove/confirm, owner restrictions and empty roles. |
| `/team/distribution` | `DistributionPage.tsx` | leads_design | Distribution mode/rules/team eligibility/SLA, edits and saves, report/log rows, read-only role and wide table. |
| `/roles` | `RolesPage.tsx` | ui_system | Create/edit role and permissions picker, role key/name validation, seeded/custom roles and delete confirmation. |
| `/api-keys` | `ApiKeysPage.tsx` | ui_system | Create/scope permissions, one-time plaintext/copy/acknowledgment, revoke confirmation, expired/revoked and role restrictions. |
| `/agents` | `AgentsPage.tsx` | ui_system | Agent connection state and permissions, configuration/copy and applicable connect/disconnect/revoke controls. |
| `/ledger` | `LedgerPage.tsx` | ui_system | Action-prefix search, paging, entry disclosure, actor/subject/payload rendering and empty/no-match results. |
| `/studio` | `StudioPage.tsx` + `Studio*.tsx` | design | Studio/materials/posts tabs, hypothesis/date/lane filters, plan selection, Today detail, learning/evidence/history and manager actions. Query views below are separate surfaces. |
| `*` | `NotFoundPage.tsx` | root | Unmatched route, standalone fallback under `AppRoot`, recovery link to home and focus target. |

## Nested surfaces beyond the router

Top-level route navigation does not open these panels, forms or query-addressable
subpages. Each row requires intentional evidence; an empty parent page does not
exercise its populated child controls.

| Surface | Owning modules | Required control/state inventory |
| --- | --- | --- |
| Inbox customer/journey | `InboxJourneyPanel`, `InboxOffers`, `InboxShared` | Owner assignment, event reducer form, terminal/lost/reopen state, tasks/add/complete, notes, quote creation/acceptance, appointment booking/cancel/held, history. |
| Inbox consent/erasure | `InboxCompliance`, `InboxErasure` | Consent records, suppression add/remove, commercial composer, missing basis/permission refusal, destructive confirmation phrase, erased customer. |
| Inbox public channels | `InboxPublic` | Public/private reply, item targeting, held approval/edit/discard, visibility, reply window, hide/unhide/delete/report/handled states and destructive confirmation. |
| Inbox deep links | `InboxPage`, `InboxMerges` | `/inbox?person=<id>`, `/inbox?task=<id>`, conversation detail and merge person query; missing/stale target and browser back. |
| Call interaction/policy | `CallsPolicy`, `CallDetail` | Outbound place-call dialog, extension/target validation, recording and agent policy; connecting/live/ended/failed and permission-disabled controls. |
| Prospect bulk dialogs | `LeadsShared`, `ProspectsPage`, `ProspectDetail` | Reject reason, do-not-contact confirmation, erasure phrase, mixed success/refusal outcomes and cleared/retained selection. |
| Outreach editor | `OutreachShared`, `OutreachCampaign`, `OutreachTemplates`, `OutreachSettings` | New and saved definitions, template/sequence previews, audience counts/skips, approval holds, disabled platform, warmup/frequency limits and stale edits. |
| Capability dialogs | `capabilities/dialogs.tsx` | Declare, edit, verification evidence, policy active-hours/caps/approval/verification age, unreachable reason, link budget and retire confirmation. |
| Capability groups | `capabilities/GroupsPanel.tsx` | Create/rename/delete, membership selection, empty group and linked/forbidden deletion states. |
| Phone/device | `capabilities/PhoneCard.tsx` | Pair dialog and one-time key, connection/heartbeat, permissions, device status, session/logout/revoke and unavailable local bridge. |
| PBX/voice/webhooks | `PbxPolicyPanel`, `VoiceBridgePanel`, `WebhookPanel` | Human/agent mode, recording consent policy, voice bridge facts/control, endpoint display/copy, token restrictions and missing provider configuration. |
| Connect/OAuth | `ConnectPage`, `OAuthCallbackPage`, `ProviderSetup` | Initial provider list versus reconnect; credential visibility/busy state; app absent, provider denied, missing code/state, account picker and confirmation failure. |
| Budget/team/keys/roles | Corresponding route modules | Every modal/sheet open/close, invalid submission, cancel, success/error, destructive confirmation and owner/read-only permissions. One-time values remain outside screenshots and retained caches. |
| Platform console | `platform/*` | Separate signed-in operator; populated/empty workspaces/payments; confirm/reissue/revoke and suspend/resume reason dialogs; health unknown/degraded; password reset. A tenant account cannot establish these states. |
| Studio Today/detail | `StudioToday`, `StudioTiktok`, `materials/MaterialHold` | Selected slot, review/approval/retry/cancel, held material/caption release, publish eligibility, TikTok creator/privacy/disclosure/consent, pending/failed/complete publishing and metrics. |
| Studio plan/learning/history | `StudioPlan`, `StudioLearned`, `StudioLedger`, `StudioStrategyBar` | Hypothesis/lane/date filtering, slot choice, finite limits/pauses, evidence and ledger pagination, manager versus viewer. |
| Materials upload | `?tab=materials&view=upload`, `MaterialsUpload` | File selection/type/size, progress, source/rights/tags, duplicate suggestions, proposed/existing olay association, success and cancellation/failure. |
| Materials olays | `?tab=materials&view=olays`, `MaterialsOlays` | List/create/edit/confirm, general/review shelves, `olay=<id>` detail, empty/populated materials and upload links. |
| Material detail | `?tab=materials&view=olays&material=<id>`, `MaterialEditor`, `MaterialsUsedIn` | Preview/tags/rights/eligibility, optimistic revision conflict, redaction, used-in slot links and missing media. |
| Materials calendar | `?tab=materials&view=calendar&year=<year>`, `MaterialsCalendar` | Year navigation, occasions/window dates, edit/confirm states, selection and missing/empty calendar. |
| Materials shoots | `?tab=materials&view=shoots`, `MaterialsShoots` | Create request, open/completed filters, complete/cancel, olay/calendar links and empty list. |
| Posts plan | `?tab=posts&view=plan`, `PostsPlan` | Planning requests, cancel, slot states and opening the underlying slot. |
| Posts week | `?tab=posts&view=week&week=<week>`, `PostsWeek` | Week navigation, report sections, hypothesis selection and no-report/missing evidence. |
| Posts settings | `?tab=posts&view=settings`, `PostsSettings` | Timezone/schedule/approval policy, manager controls, validation/save/revision conflict and read-only state. |
| Strategy dialogs/documents | `ApproveDialog`, `ConsultationLog`, `GapList`, `HypothesisTable`, `strategy/*` | Consultation history paging, assumptions, section validation, hypothesis editor/cadence, submitted stamp, stale approval, archive confirmation and version history. |

## State review criteria and evidence rules

For each applicable surface above, record the actual fixture and viewport rather
than checking a universal claim. Unimplemented states should be marked N/A with
a reason; unobserved implemented states remain open.

- Initial loading and an accessible progress indication; no layout collapse.
- First-use empty state with a useful action; filtered no-results state with
  a recovery action; populated list/detail, long values and multiple rows.
- Request error and retry; stale-data refresh failure where data is retained.
- Missing/invalid dynamic ID, stale revision and expired invite/callback.
- No session, read-only permission and owner/manager action states; pending,
  active and suspended workspace; strategy-required and unavailable-provider gates.
- Each form: empty/invalid/valid, submit busy/disabled, field/server error,
  success, cancellation and relevant repeated submission behavior.
- Each dialog/sheet/menu: keyboard open/close, focus containment/return,
  Escape/back behavior, overflow and destructive confirmation.
- Filters/paging/tabs and URL/query state: changed results, clear/reset,
  browser back, selected item persistence and removed/stale selection.
- Desktop and 390px mobile; horizontal scrolling contained within tables,
  no document overflow; dark/light contrast and visible focus.
- Turkish and English; long text, dates/currency, empty labels and accessible
  button/input names. RTL is not an available locale in this Rust panel baseline.
- Correct mutation result and cache invalidation while preserving field and
  one-time secret handling; no external messages sent during design review.

Common components (`components/ui/*`, `QueryState`, `ErrorCallout`, forms,
status badges, copy fields, permissions pickers and notifications) also need a
shared-system review. Inheriting those components can update an unchanged page's
appearance, but does not prove that page's layouts or conditional controls.

## Gaps in the previous evidence

The earlier design README reports 27 browser routes, 62 panel suites / 418 tests,
TypeScript/build and selected desktop/mobile/theme screenshots. That is useful
regression evidence, but does not identify all 38 page/fallback patterns or the
query subviews/dialogs above. A route sweep of an active owner workspace mainly
demonstrates route loading and the fixture it holds.

Compared with the modern base, the baseline did **not** directly edit these route
modules: `AcceptInvitePage`, `OAuthCallbackPage`, `OutreachSettings`, and
`platform/PlatformLoginPage`. They inherited shared controls/layout; this pass adds
intentional page and state review. Other previously unedited leaves include `StudioToday`,
`StudioTiktok`, `MaterialEditor`, `MaterialHold`, `MaterialsUsedIn`, `PostsShared`,
and capability groups/dialogs/phone/PBX/voice/webhook modules. A lack of a direct
diff is a review lead, not proof of a defect or a requirement to make a needless
edit. These leaves are included in the module reviews linked below; a file did not need a cosmetic edit when its existing presentation already met the review criteria.

The synthetic local workspace already contains an active entitlement, approved
strategy, five customer conversations/journeys/tasks, declared mailbox/Instagram
capabilities without credentials, and two budgets with recorded synthetic spend.
It does not, by itself, furnish valid call IDs, prospect/campaign detail records,
platform-operator sessions, material/publishing states, invitations or real
provider callbacks. Those surfaces are exercised with additional isolated fixtures/component
tests in this pass; module reports label mocked responses explicitly.

## Module evidence

- [Account, home, setup and shared controls](foundation.md)
- [Inbox, people, calls, approvals and confirmations](inbox.md)
- [Prospects, research, campaigns, templates and distribution](leads.md)
- [Strategy, Studio, materials and posts](studio.md)
- [Administration, providers, billing and platform](admin.md)

The reusable [browser review scripts](../../../../rust/panel/design-review/README.md)
record exact scenarios and viewports. The coverage unit is a distinct implemented
screen or UI state, not every possible combination of accounts, backend responses
and provider environments. Unit tests verify request/permission contracts; browser
fixtures verify the rendered states. External integration evidence remains separate.

## CI at the baseline

Checked on 2026-11-05 for the full baseline SHA:

- [CI PR run 42017837316](https://github.com/mtarikucar/kds-marketing/actions/runs/42017837316)
  completed successfully.
- [Rust PR run 42017837166](https://github.com/mtarikucar/kds-marketing/actions/runs/42017837166)
  and [Rust push run 42017827723](https://github.com/mtarikucar/kds-marketing/actions/runs/42017827723)
  both passed `release-artifact`, `panel`, `rust-checks`, restore drill and the
  other completed jobs. `rust-test` was still running at this observation; no
  failure was present. Recheck before describing the entire workflow as green.

The previous SHA's release jobs failed because `public/brand/README.md` was copied
into generated browser assets and correctly refused by the packager. Moving
documentation outside `public/` fixed that cause while retaining packaging
restrictions. It is not evidence of a current baseline CI failure.

## External validation boundaries

Local API/browser fixtures can validate presentation, navigation, validation,
permission states and synthetic mutations. Component tests with scripted errors
can exercise otherwise unavailable UI states. Neither establishes live provider
behavior. The following require separate authorized operational validation:

- OAuth provider consent/app approval, account selection and callbacks against
  the registered staging/production authorities.
- Real inbound/outbound email, SMS, WhatsApp/social messages, moderation and
  delivery receipts; commercial-contact eligibility and IYS provider responses.
- Telephone/PBX/phone/voice-bridge connectivity, microphone/audio, recording,
  transcript services and real hardware permissions.
- Social publishing/review/privacy enforcement, external budgets, live analytics,
  vendor quotas and paid media generation.
- Actual payment transfer evidence, operator production activation, production
  secrets, backup recovery and migration compatibility on installed hosts.
- Staging/yeni installed revisions, server-local upgrade scripts and promotion.

No deployment, production data change, external message or paid action is part of
this coverage audit. Release instructions remain in
[jeeta-panel-release.md](../../../operations/jeeta-panel-release.md).
