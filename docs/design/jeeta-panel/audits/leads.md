# Leads and outreach design audit

Scope: the Rust panel's prospect pool, prospect detail, research tasks, campaigns, templates, outreach settings and team distribution. The fixture records are synthetic and come from `rust/panel/src/test/leads.ts`.

## Screen and state inventory

| Screen | States and interactions reviewed in source |
| --- | --- |
| Prospects | Loading/error/retry, populated table and paging, status/score/task/city/segment filters, no records, no matching results and clear, selection and bulk outcomes, row/bulk promote refusal, reject and do-not-contact dialogs. |
| Prospect detail | Loading/error, profile and evidence links, scores, signals, duplicates and history (including empty sections); qualify, promote, reject, reopen, do-not-contact/lift and erase confirmation, permission-gated actions, mutation errors. |
| Research tasks | Open/all/status filter and filtered empty, populated standing/ad-hoc briefs, claim and close, progress disclosure, one-off task form and validation, create/claim/close errors. |
| Campaign list | Loading/error, status and pause reasons, filtered and unfiltered empties, clear filter, lock/identity notices. |
| Campaign new/detail | Draft editor, steps and audience selectors, preview and skip reasons, schedule and limits, validation and save; approval, launch, blocked and refused launch, pause/resume/cancel, enrollments and stop; pending/error/read-only controls. |
| Templates | Empty/list/archive filter, new and revision editors, variable insertion, rendered preview, links and fixed opt-out footer, client/server validation, save/archive errors, restricted writing. |
| Outreach settings | Sender identity, approval and tracking, warm-up and frequency, read-only manager/rep, platform/identity locks; owner-only B2B basis, acknowledgement and note, saved acknowledgement, validation and save errors. |
| Distribution | Ownerless/stalled counts, backfill, ordered rule builder and validation, member availability and own/manager editing, assignment log filter/paging, empty/error and mutation states. |

## Fixture review

Run from `rust/panel` with the Rust panel Vite server on port 5180 (or set `JEETA_REVIEW_URL`):

```sh
node design-review/leads.cjs
```

The harness uses the sibling frontend's Playwright and esbuild installations, intercepts `/api/` only, writes screenshots to `/tmp/jeeta-leads-review`, and reports document overflow at 1440×900 and 390×844. Pass a URL and output directory as positional arguments to override defaults. Set `CHROMIUM_PATH` if Chromium is not at `/usr/bin/chromium`. API requests not in the fixture receive a structured 404, so missing fixture routes are visible rather than silently appearing populated. The browser and local server may need local network permissions in a sandbox.

The fixture scenarios cover populated pool and detail, rejection and do-not-contact dialogs, research list/create form, campaigns list/new/detail with steps and audience preview; owner and representative approval, running and paused campaigns, active and stopped enrollments, blocked and refused launches, and enrollment stop error, template editor/opt-out preview, owner settings, distribution rules, unfiltered and filtered empty lists, list error, refused campaign launch, locked settings, restricted settings and a representative's own distribution editor. Screenshots cover both viewports. The screenshots are review artifacts, not production data or checked-in assets.

## Findings and changes

- The mobile prospect table clipped row actions; actions now wrap within their card.
- The campaign editor now separates steps, audience and sending window so long forms can be scanned, while preserving field and submission behavior. Enrollment rows reflow into labeled mobile cards so status, basis and stop actions remain visible.
- Settings groups have visible boundaries to distinguish sender identity, sending, warm-up and frequency. The owner-only legal acknowledgement remains in its own section.
- Filtered prospect, research and campaign empty states identify a filter result and offer clearing; unfiltered prospect and campaign states provide the appropriate next action and illustration.
- Distribution's wide member table remains horizontally scrollable at mobile widths, retaining all columns and edit controls; a mobile hint makes the remaining columns discoverable.

## Validation and limits

The fixture review is local and uses stubbed responses; it does not validate actual delivery, opt-out handling, backend permissions or production data. Source review covers branches not individually rendered in the fixture harness, including other rejection variants and mutation failures. Existing focused tests cover representative refusal, retry, permission, validation, filter and form behaviors; they are not a substitute for end-to-end service integration.

On 2026-11-05, 52 fixture captures (26 scenarios at each viewport) were run. The initial running/enrollment captures exposed mobile overflow; after reflowing enrollment rows, a repeat capture reported no document-level overflow. The 390px prospect list was inspected before and after the wrapping fix; the rejection dialog, filtered-empty result, campaign builder, approval and blocked states, running enrollments, template preview, read-only settings and representative editor were also inspected. A document-width check alone does not detect clipped content inside a scroll container.

The focused Vitest run used `--maxWorkers=1 --minWorkers=1` for the eight lead/outreach/distribution page test files: 38 tests passed. Whole-panel TypeScript checking passed after concurrent edits settled.
