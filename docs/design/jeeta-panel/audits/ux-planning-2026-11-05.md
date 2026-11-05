> Agent review snapshot. Final integrated verification, translation status and limitations are recorded in [the consolidated review](../ux-review-2026-11-05.md). References to temporary files are session artifacts. Earlier cross-family type errors in these notes were resolved before the final build.

# Planning UX review — 2026-11-05

Baseline: 84e85ed8. Scope: StrategyPage + strategy/*; Studio*; materials/*; posts/*. Existing categorized Strategy and URL-selected Studio sections were retained. No shared UI/CSS, locale JSON, API, assets, permissions or live data were changed by this agent.

## Changes

1. **Material editing is one task group at a time:** tags/people, permission/location, usage/deletion. Short group explanations say what the user is deciding. Sections stay mounted; navigation does not save. A server revision refresh adopts untouched values but preserves unfinished local fields. Saving another section cannot silently discard the hidden draft; every mutation still uses the current server revision. Erased materials go straight to the removal explanation and usage evidence. Deletion remains a separate confirmation.
2. **Long selection lists stay within the work area:** upload event lists with more than five entries gain title/place search and a bounded viewport. A filtered-out selection remains explicitly named; no-match copy points to changing the search or creating an event. File upload, suggestions, consent and idempotent request keys are unchanged. The slot editor's candidate list is height-bounded only above six rows; its last checkbox remains keyboard/reach-scroll accessible. The root-provided guide-plan.webp appears only on the empty upload entry, at 96/112px.
3. **Posting policy has three groups:** format timing, daily limits, calendar/time. One Save still writes the complete policy. Switching groups keeps all edits. Local validation reveals the relevant group; an API timezone refusal reveals Calendar/time. Read-only members can browse all groups but cannot edit or save.

## Route/tab inventory

| Screen / branch | Audit result and disposition | Fresh browser evidence |
| --- | --- | --- |
| /strategy — Draft / Brand and audience | Existing category selection and first-gap edit action prevent the whole brief from appearing at once; no extra visual churn | ux-strategy-brand, both widths |
| /strategy — Draft / Goals and plan | Channels, goals, budget, cadence, paid switch remain within one selected group; individual forms retain local edits | ux-strategy-plan, both widths |
| /strategy — Hypotheses | Dedicated group; table/read view and explicit edit/add/retire/restore workflow retained | ux-strategy-hypotheses, both widths; editor mutations covered by Strategy unit suite |
| /strategy — Consultation | Dedicated category, record and paging remain available; no unrelated form beside it | ux-strategy-consultation, both widths |
| /strategy — Approved | Read-only brief uses the same groups; archive remains confirmed by typed version | strategy-approved, both widths; archive test |
| /strategy — Empty / no approved / history / submit / approve / archive | Existing explanation + consultation-start action and refusal/gap recovery retained; version sheet and dialogs not restyled | strategy-empty, both widths; remaining branches source review + Strategy unit suite |
| /studio — Today | Default work area, expandable filters, compact supporting strategy below; approve/hold/cancel/failure/unknown controls retained | studio-loaded, both widths; StudioPage + MaterialHold suites |
| /studio — Slot editor / material picker | Subject selection already narrows candidates; long candidate set now bounded without hiding choices or altering eligibility | ux-slot-long-materials with 18 candidates, last checkbox selected, both widths |
| /studio — TikTok compose/status | Direct/draft privacy/consent controls stay explicit; no folding of required provider choices. Account, fallback preview, unavailable/error/sending/published states preserved | tiktok-direct both widths; 27 TikTok tests cover remaining variants |
| /studio?section=plan | Existing list/calendar views show actual dated work; empty plan already links to material upload | ux-studio-plan both widths; calendar identity test |
| /studio?section=learned | Evidence first; trend, judgment, account binding and budget forms already progressively disclosed | ux-studio-learned both widths; paid-action/evidence unit tests |
| /studio?section=ledger | Operational evidence is collapsed per row; export/paging preserved | ux-studio-ledger both widths; unchanged source reviewed |
| /studio?tab=materials&view=upload — empty | Camera/gallery actions follow short process explanation; small generated guide replaces prior empty SVG | materials-upload both widths; image inspected |
| Upload — files / event / permission / optional tags / completion | Optional tags already closed. Long event selection now searchable and bounded; selection persists across searches, including no matches | ux-upload-events + ux-upload-events-search both widths; 9 upload tests |
| /studio?tab=materials&view=olays — list / empty / create | New-event CTA is visible before the list; proposed/confirmed distinctions and inline creation remain | materials-events, materials-events-empty, materials-event-create both widths |
| &olay=o1 — detail / edit | Upload action remains with event heading; material tiles, shoot requests and provenance have distinct sections; edit appears only on request | materials-event-detail, materials-event-edit both widths |
| &olay=genel / review — material shelves | Existing shelf explanation/back action and status badges retained; no decorative expansion of tiles | materials-general, materials-review both widths |
| &material=m1 — tags/people | New selected task group; agent suggestions and person privacy explanation remain visible | ux-material-review both widths |
| &material=m1 — permission/location / restricted member | Separate decision group; owner/manager gate unchanged and explanation stays available to readers | ux-material-publishing, ux-material-permission both widths |
| &material=m1 — usage / delete / erased | History precedes destructive action; confirmation and published-post evidence remain available; erased state has no editing | ux-material-history, ux-material-delete-dialog, materials-editor-deleted both widths |
| &material=m1 — draft + revision refresh | Hidden dirty tags survive saving permission; later PATCH uses refreshed revision 3 | new unit regression; ux-material-draft-refresh both widths |
| /studio?tab=materials&view=calendar&year=2027 | Year selector narrows calendar; undated occasions have clear enter-dates action, per-row edit and separate policy form | materials-calendar, materials-calendar-add both widths; edit/permission/validation unit tests |
| /studio?tab=materials&view=shoots | This week first; older requests separate; closed requests opt-in, compact add form | materials-shoots both widths; add/resolve/link tests |
| /studio?tab=posts&view=plan | Planned work and incoming requests have different visual weights; empty plan already has upload action | posts-populated, posts-empty both widths |
| /studio?tab=posts&view=week[&week=...] | Week navigation bounds the report; published/planned/not-published/results remain visibly separated | posts-week, posts-week-empty both widths; week navigation tests |
| /studio?tab=posts&view=settings | New three-group form; complete policy save and editable/read-only roles retained | ux-settings-formats/limits/calendar/invalid, posts-settings-permission both widths; 11 Posts tests |

Shared owned helpers were also read: StudioShared (translated fields/retry/action links), MaterialsShared (tags, calendar/event fields, mutation invalidation/role gates), MaterialsUsedIn (post/slot links), MaterialHold (material/shot/caption recovery), PostsShared (channel names/query context), strategy/queries and BriefNavigation. They needed no changes in this pass.

## Verification

- Planning suite: **10 files, 120 tests passed** before the last draft-preservation regression. The final MaterialEditor suite then passed **8/8**, including that new test (aggregate planning coverage: 121 tests). Root runs the final complete suite.
- `npx tsc --noEmit`: passed after final source/test changes. An earlier DistributionPage error was outside this scope and was fixed by its owner.
- Fresh fixture browser manifest: `/tmp/ux-planning-review/results.json`: **82/82** scenario-width cases, 41 each at 1440 and 390; no recorded page errors, unexpected API routes or horizontal document overflow. One initial Studio desktop capture was interrupted by Vite hot reload; its retry passed and replaced the failed entry.
- Harness: `/tmp/ux-planning-review.cjs` loads existing repository fixtures and the existing studio harness; all API calls are intercepted, external requests blocked. Upload/permission calls in the manifest are fixture writes only.
- Personally inspected images: material-review-390; material-publishing-1440; settings-formats-390; settings-calendar-1440; upload-events-search-390; slot-long-materials-390; materials-upload-390; materials-event-detail-390; posts-week-390; strategy-hypotheses-390 (with ux- prefix where the manifest uses it). Categories wrap cleanly, controls remain usable and the guide is small. The upload fixture uses intentionally minimal JPEG bytes, so its selected-file preview is broken in that synthetic screenshot; this is not a claim that the real upload preview was verified.

## Limits

This pass audits every owned route/tab and uses representative fresh screenshots, not a new exhaustive browser replay of every provider/refusal permutation. TikTok provider approval/publication and real camera permissions were not exercised against external services. Long tag collections and multi-row hypothesis editors can still require vertical scrolling within their selected task category; their fields are substantive, not automatically collapsed. No screenshot is evidence of perfect accessibility or production-provider behavior.

Locale map for root integration: `/tmp/ux-planning-locales.json` (14 TR/EN keys). No commit, push, deploy or production mutations performed.
