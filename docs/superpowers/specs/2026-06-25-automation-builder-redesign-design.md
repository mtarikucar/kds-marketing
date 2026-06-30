# Automation section redesign — full-page builder + reworked list

**Date:** 2026-06-25
**Area:** `frontend/src/pages/marketing/automations` (+ `AutomationsPage.tsx`, routing, nav)
**Status:** Approved design — ready for implementation plan

## Problem

The automation (workflow) builder runs entirely inside a `Dialog` modal
(`AutomationsPage.tsx`, `max-w-5xl`). The modal crams the AI-assist box, name,
trigger, trigger-filters, and an `h-[60vh]` React Flow canvas with a 72px-wide
property panel into a cramped space. Advanced step types (`branch`,
`ai_classify`, `update_lead`, `http_webhook_out`, `start_workflow`) cannot be
edited visually — the panel tells the user to "switch to JSON". The result feels
unprofessional and is hard to use.

## Goal

Move the builder out of the modal into a dedicated, professional full-page UX,
make **every** step type editable visually (JSON demoted to a hidden power-user
escape hatch), and refresh the list + create-entry flow so the whole section is
consistent.

Three approved decisions:
1. **Layout:** Pro canvas + right property panel (sticky top bar, left
   settings+palette rail, center React Flow canvas, right contextual panel).
2. **Editor depth:** All step types get visual editors; per-step raw JSON stays
   available under a collapsed "Advanced (JSON)" section, hidden by default.
3. **Scope:** List page and the "new automation" entry flow are redesigned too
   (not just the builder).

## Architecture & routing

Mirror the existing dedicated-page pattern (`/leads/new`, `/leads/:id`,
`/leads/:id/edit`):

| Route | Page | Notes |
|---|---|---|
| `/automations` | `AutomationsListPage` | reworked list |
| `/automations/new` | `AutomationBuilderPage` | blank; optional `?template=<key>` / `?ai=<prompt>` prefill |
| `/automations/:id/edit` | `AutomationBuilderPage` | loads the saved workflow |

`App.tsx` adds the two builder routes (lazy-loaded, manager-gated like the
existing `/automations` route). `navigation.ts` is unchanged (still points at
`/automations`).

### Files (`pages/marketing/automations/`)

The current monolithic `AutomationsPage.tsx` (663 lines) is split:

- **`AutomationsListPage.tsx`** — list + search + status filter + "New" entry
  menu. Becomes the default export wired to `/automations`.
- **`AutomationBuilderPage.tsx`** — full-page builder shell: data load
  (`GET /workflows/:id` on edit), save (`POST`/`PATCH`), sticky bar, unsaved-
  change guard. **Single source of truth for the builder form state.**
- **`BuilderTopBar.tsx`** — back link, inline name edit, status badge, Save,
  Activate/Pause.
- **`BuilderSettingsRail.tsx`** — left rail: trigger select, trigger-filters,
  AI-assist box, categorized step palette.
- **`WorkflowCanvas.tsx`** — existing React Flow canvas, enlarged to fill the
  center column; the add-step palette moves OUT of the canvas overlay into the
  left rail.
- **`StepPropertyPanel.tsx`** — right panel hosting the per-type step editors.
- **`stepEditors/`** — one small component per step type, plus
  `BranchConditionBuilder.tsx` (field/op/value rows) and `AdvancedJsonField.tsx`
  (collapsed raw-JSON editor for the selected step).

Reused unchanged: `workflowGraph.ts` (DSL→graph mapping + remap helpers),
`EnrollByFilterDialog.tsx` (kept as a list-row action).

### State model change

Today `steps` is a **JSON string** in a `react-hook-form` field, with a
`parsedSteps` bridge. In the builder page, `steps` is held as a **typed
`AnyStep[]`** (the canvas already works in this shape). JSON serialization
happens only (a) in the per-step "Advanced (JSON)" editor and (b) when building
the save payload. `name`, `triggerType`, and `filters` remain simple controlled
fields. The `goal` pending/existing threading (set/clear vs leave-as-is on
PATCH) moves into builder state with the same semantics.

## List page (reworked)

- Search input + status filter (All / Active / Paused / Draft).
- Each row: name, status badge, human-readable trigger label, **stats**
  (started → completed from `w.stats`), quick actions (Activate/Pause · Enroll ·
  Edit → navigates to `/automations/:id/edit` · Delete).
- "New automation" → a small popover/dropdown: **Blank** · **From template**
  (opens template picker) · **Describe with AI** (prompt) → routes to
  `/automations/new` with the chosen prefill. Template & AI entry are no longer
  modals on top of a modal — they feed the dedicated builder.
- Empty state keeps the same two CTAs, routing into the new flow.

## Builder (Pro canvas + right panel)

- **Sticky top bar:** ‹ Back · inline-editable name · status badge · `Save` ·
  `Activate`/`Pause`. Leaving with unsaved changes prompts a confirm.
- **Left rail (collapsible):** trigger select, trigger filters, AI-assist
  ("describe it → draft"), and the **step palette** grouped by category
  (Send / Flow / Action / AI).
- **Center:** enlarged React Flow canvas (full height, `fitView`,
  non-draggable/non-connectable as today). Cleaner now that the palette lives in
  the rail.
- **Right panel (`StepPropertyPanel`):** full visual editor for the selected
  step. New visual editors for the types that previously required JSON:
  - `branch` → **condition builder**: rows of (field · operator · value) with
    add/remove, plus an "else → go to step" selector (writes `filters[]` and
    `elseGoto`). Filter row shape matches the DSL: `{ field, op, value }`.
  - `update_lead` → field→value rows writing the `set` object.
  - `ai_classify` → category list + per-category "route to step" map
    (`categories[]` + `routes` object).
  - `http_webhook_out` → URL / method / body.
  - Already-visual types (email/sms/whatsapp/wait/create_task/add_tag/
    remove_tag/assign_lead/notify_user) are preserved and polished.
  - Bottom **"Advanced (JSON)"** collapsible: the selected step's raw JSON
    (power-user escape; collapsed by default; invalid JSON blocks save with an
    inline error).
  - Step actions (move up/down, delete) stay, with the existing jump-target
    remap (`remapJumpTargets` / `remapGoalGoto`) on reorder/delete.

## Data flow & API (unchanged)

Same endpoints: `GET /workflows`, `GET /workflows/:id`, `POST /workflows`,
`PATCH /workflows/:id`, `POST /workflows/:id/status`, `DELETE /workflows/:id`,
`POST /workflows/draft` (AI draft), `GET /workflows/templates`. Save payload
shape is unchanged: `{ name, trigger: { type, filters }, steps, goal? }`, with
`goal` sent only when explicitly set/cleared (undefined = leave as-is on PATCH).
**No backend changes.**

## Error handling

- Malformed step objects render safely (keep the existing coercion in
  `buildWorkflowGraph`); a per-step Advanced-JSON edit that is invalid shows an
  inline error and disables Save.
- Save failure surfaces the API message via toast (current behavior).
- Unsaved-change guard on route navigation away from the builder.

## Testing (TDD)

- Preserve existing `workflowGraph.test.ts`.
- New unit tests:
  - `BranchConditionBuilder`: add/remove/patch rows → correct `filters[]` +
    `elseGoto`.
  - `update_lead` set editor: rows → correct `set` object.
  - List page: search + status filter narrows rows; row actions fire the right
    mutations.
  - Builder serialization: `steps[]` ↔ save payload round-trip; `goal`
    pending/existing semantics on create vs edit.
  - Route render smoke: `/automations/new` and `/automations/:id/edit` mount and
    load.

## Out of scope (YAGNI)

Free-form drag-to-connect node wiring; new step types; backend DSL changes; a
full visual editor for `goal` (keep the current read-only goal node + its JSON).

## Success criteria

- The builder is a full page at `/automations/new` and `/automations/:id/edit`;
  no builder modal remains.
- Every step type is editable from the right panel without opening JSON; JSON is
  reachable but collapsed/hidden by default.
- The list supports search + status filter and shows per-workflow stats.
- Create/edit/activate/pause/delete/enroll all work against the unchanged API.
- All new and existing tests pass; `tsc --noEmit` and `eslint` clean.
