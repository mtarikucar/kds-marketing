# Automation Builder Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the marketing workflow builder out of a modal into dedicated full-page routes (`/automations/new`, `/automations/:id/edit`), give every step type a visual editor (JSON demoted to a hidden per-step escape hatch), and rework the list + create-entry flow.

**Architecture:** A dedicated `AutomationBuilderPage` owns the builder form state as a typed `{ name, triggerType, filters, steps: AnyStep[], goal }` object (no more JSON-string `steps`). Pure helpers (payload (de)serialization, branch-condition rows, update_lead set rows, list filtering) are unit-tested; React components (settings rail, canvas, property panel, top bar) compose them. The list page becomes a thin list with search/filter/stats and a "New" entry dropdown that routes into the builder. Backend/API unchanged.

**Tech Stack:** React + TypeScript, react-router-dom, @tanstack/react-query, react-hook-form (list/simple fields only), @xyflow/react (existing canvas), Vitest + @testing-library/react, i18next.

**Spec:** `docs/superpowers/specs/2026-06-25-automation-builder-redesign-design.md`

---

## File Structure

Under `frontend/src/pages/marketing/automations/`:

- `workflowPayload.ts` (NEW) — pure: `fromWorkflowDto(dto)` → builder state; `toSavePayload(state)` → API body. Unit-tested.
- `builderHelpers.ts` (NEW) — pure row helpers: branch `filters[]` add/remove/patch; `update_lead` `set` object add/remove/rename/patch; `ai_classify` categories/routes. Unit-tested.
- `listFilters.ts` (NEW) — pure: `filterWorkflows(rows, { search, status })`. Unit-tested.
- `AutomationBuilderPage.tsx` (NEW) — full-page shell; owns state, load (`GET /workflows/:id`), save (`POST`/`PATCH`), unsaved guard. Default export, wired to `/automations/new` and `/automations/:id/edit`.
- `BuilderTopBar.tsx` (NEW) — back link, inline name, status badge, Save, Activate/Pause.
- `BuilderSettingsRail.tsx` (NEW) — trigger select, trigger filters, AI-assist, categorized step palette.
- `StepPropertyPanel.tsx` (NEW) — hosts the per-type editor for the selected step + Advanced-JSON.
- `stepEditors/index.tsx` (NEW) — registry mapping step type → editor; reuses existing simple editors, adds `BranchConditionBuilder.tsx`, `UpdateLeadEditor.tsx`, `AiClassifyEditor.tsx`, `WebhookEditor.tsx`, `AdvancedJsonField.tsx`.
- `WorkflowCanvas.tsx` (MODIFY) — accept an `onAddStep` from parent; remove the in-canvas palette overlay (palette moves to the rail); enlarge to fill column; keep selection + StepEditor moved into `StepPropertyPanel`.
- `AutomationsListPage.tsx` (NEW, replaces the body of `AutomationsPage.tsx`) — list + search/filter + stats + New dropdown + delete/enroll dialogs.
- `workflowGraph.ts`, `workflowGraph.test.ts`, `EnrollByFilterDialog.tsx` — reused unchanged.

Top-level:
- `pages/marketing/AutomationsPage.tsx` (MODIFY) — becomes a 1-line re-export of `AutomationsListPage` (keeps the App.tsx import stable) OR is replaced; we re-export to minimize churn.
- `App.tsx` (MODIFY) — add two lazy builder routes.

Shared types: `automationTypes.ts` (NEW) — `BuilderState`, `WorkflowRow`, `WorkflowTemplate`, `WorkflowDto`.

---

## Task 1: Shared types + payload (de)serialization (pure, TDD)

**Files:**
- Create: `frontend/src/pages/marketing/automations/automationTypes.ts`
- Create: `frontend/src/pages/marketing/automations/workflowPayload.ts`
- Test: `frontend/src/pages/marketing/automations/workflowPayload.test.ts`

- [ ] **Step 1: Types**

`automationTypes.ts`:
```ts
import type { AnyStep, DslGoal } from './workflowGraph';

export interface WorkflowRow {
  id: string;
  name: string;
  status: string; // ACTIVE | PAUSED | DRAFT
  trigger?: { type?: string };
  version: number;
  stats?: { started?: number; completed?: number } | null;
}

export interface WorkflowDto extends WorkflowRow {
  trigger?: { type?: string; filters?: unknown[] };
  steps?: AnyStep[];
  goal?: DslGoal | null;
}

export interface WorkflowTemplate {
  key: string; name: string; description: string; category: string;
  trigger: { type: string; filters?: unknown[] };
  steps: AnyStep[]; goal?: DslGoal | null;
}

export interface BuilderState {
  name: string;
  triggerType: string;
  filters: unknown[];
  steps: AnyStep[];
  // goal threading: undefined = leave stored goal as-is on PATCH;
  // null = no goal; object = set it.
  goal: DslGoal | null | undefined;
}

export const DEFAULT_BUILDER_STATE: BuilderState = {
  name: '', triggerType: 'lead.created', filters: [], steps: [], goal: null,
};
```

- [ ] **Step 2: Write failing tests** — `workflowPayload.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { fromWorkflowDto, fromTemplate, toSavePayload } from './workflowPayload';

describe('fromWorkflowDto', () => {
  it('maps a saved workflow to builder state and leaves goal as-is (undefined)', () => {
    const s = fromWorkflowDto({
      id: '1', name: 'W', status: 'ACTIVE', version: 1,
      trigger: { type: 'lead.created', filters: [{ field: 'a' }] },
      steps: [{ type: 'send_sms', body: 'hi' }],
      goal: { onMet: 'exit', filters: [] },
    });
    expect(s).toEqual({
      name: 'W', triggerType: 'lead.created', filters: [{ field: 'a' }],
      steps: [{ type: 'send_sms', body: 'hi' }], goal: undefined,
    });
  });
  it('defaults trigger/filters/steps when missing', () => {
    const s = fromWorkflowDto({ id: '1', name: 'W', status: 'DRAFT', version: 1 });
    expect(s.triggerType).toBe('lead.created');
    expect(s.filters).toEqual([]);
    expect(s.steps).toEqual([]);
  });
});

describe('fromTemplate', () => {
  it('carries the template goal so Save does not drop it', () => {
    const s = fromTemplate({
      key: 'k', name: 'T', description: '', category: 'c',
      trigger: { type: 'form.submitted', filters: [] }, steps: [], goal: { onMet: 'exit', filters: [] },
    });
    expect(s.goal).toEqual({ onMet: 'exit', filters: [] });
    expect(s.triggerType).toBe('form.submitted');
  });
});

describe('toSavePayload', () => {
  const base = { name: 'W', triggerType: 'lead.created', filters: [], steps: [{ type: 'send_sms', body: 'x' }] };
  it('omits goal when undefined (leave-as-is on PATCH)', () => {
    expect('goal' in toSavePayload({ ...base, goal: undefined })).toBe(false);
  });
  it('includes goal:null to clear', () => {
    expect(toSavePayload({ ...base, goal: null }).goal).toBeNull();
  });
  it('includes a set goal', () => {
    expect(toSavePayload({ ...base, goal: { onMet: 'exit', filters: [] } }).goal).toEqual({ onMet: 'exit', filters: [] });
  });
  it('nests trigger and passes steps through', () => {
    const p = toSavePayload({ ...base, goal: undefined });
    expect(p).toMatchObject({ name: 'W', trigger: { type: 'lead.created', filters: [] }, steps: [{ type: 'send_sms', body: 'x' }] });
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (`npx vitest run src/pages/marketing/automations/workflowPayload.test.ts`).

- [ ] **Step 4: Implement** `workflowPayload.ts`:
```ts
import type { BuilderState, WorkflowDto, WorkflowTemplate } from './automationTypes';

export function fromWorkflowDto(dto: WorkflowDto): BuilderState {
  return {
    name: dto.name ?? '',
    triggerType: dto.trigger?.type ?? 'lead.created',
    filters: dto.trigger?.filters ?? [],
    steps: dto.steps ?? [],
    goal: undefined, // editing steps/trigger must not clobber the stored goal
  };
}

export function fromTemplate(tpl: WorkflowTemplate): BuilderState {
  return {
    name: tpl.name ?? '',
    triggerType: tpl.trigger?.type ?? 'lead.created',
    filters: tpl.trigger?.filters ?? [],
    steps: tpl.steps ?? [],
    goal: tpl.goal ?? null, // a fresh template workflow carries its goal (or none)
  };
}

export function toSavePayload(s: BuilderState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: s.name,
    trigger: { type: s.triggerType, filters: s.filters ?? [] },
    steps: s.steps ?? [],
  };
  if (s.goal !== undefined) payload.goal = s.goal;
  return payload;
}
```

- [ ] **Step 5: Run — expect PASS.**
- [ ] **Step 6: Commit** `feat(automations): builder payload (de)serialization helpers`.

---

## Task 2: Pure step-config row helpers (TDD)

**Files:**
- Create: `frontend/src/pages/marketing/automations/builderHelpers.ts`
- Test: `frontend/src/pages/marketing/automations/builderHelpers.test.ts`

These back the visual editors for the previously-JSON-only steps. A "condition" row is `{ field, op, value }` (matches the DSL, e.g. `{ field: 'lead.status', op: 'eq', value: 'NEW' }`). `update_lead` edits a `set` object as ordered rows of `{ key, value }`.

- [ ] **Step 1: Failing tests** — `builderHelpers.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  addCondition, removeCondition, patchCondition,
  setObjectToRows, rowsToSetObject,
} from './builderHelpers';

describe('branch conditions', () => {
  it('adds a blank condition row', () => {
    expect(addCondition([])).toEqual([{ field: '', op: 'eq', value: '' }]);
  });
  it('patches one row by index, leaving others intact', () => {
    const rows = [{ field: 'a', op: 'eq', value: '1' }, { field: 'b', op: 'eq', value: '2' }];
    expect(patchCondition(rows, 1, { value: '9' })[1]).toEqual({ field: 'b', op: 'eq', value: '9' });
    expect(patchCondition(rows, 1, { value: '9' })[0]).toEqual(rows[0]);
  });
  it('removes a row by index', () => {
    const rows = [{ field: 'a', op: 'eq', value: '1' }, { field: 'b', op: 'eq', value: '2' }];
    expect(removeCondition(rows, 0)).toEqual([{ field: 'b', op: 'eq', value: '2' }]);
  });
});

describe('update_lead set <-> rows', () => {
  it('converts a set object to ordered rows', () => {
    expect(setObjectToRows({ status: 'CONTACTED', tier: 'A' }))
      .toEqual([{ key: 'status', value: 'CONTACTED' }, { key: 'tier', value: 'A' }]);
  });
  it('round-trips rows back to an object, dropping blank keys', () => {
    expect(rowsToSetObject([{ key: 'status', value: 'NEW' }, { key: '', value: 'x' }]))
      .toEqual({ status: 'NEW' });
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `builderHelpers.ts`:
```ts
export interface Condition { field: string; op: string; value: string }
export const CONDITION_OPS = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'in'] as const;

export function addCondition(rows: Condition[]): Condition[] {
  return [...rows, { field: '', op: 'eq', value: '' }];
}
export function removeCondition(rows: Condition[], i: number): Condition[] {
  return rows.filter((_, idx) => idx !== i);
}
export function patchCondition(rows: Condition[], i: number, patch: Partial<Condition>): Condition[] {
  return rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
}

export interface SetRow { key: string; value: string }
export function setObjectToRows(set: Record<string, unknown> | undefined): SetRow[] {
  return Object.entries(set ?? {}).map(([key, value]) => ({ key, value: String(value ?? '') }));
}
export function rowsToSetObject(rows: SetRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) if (key.trim()) out[key] = value;
  return out;
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(automations): pure step-config row helpers`.

---

## Task 3: List filtering helper (TDD)

**Files:**
- Create: `frontend/src/pages/marketing/automations/listFilters.ts`
- Test: `frontend/src/pages/marketing/automations/listFilters.test.ts`

- [ ] **Step 1: Failing test:**
```ts
import { describe, it, expect } from 'vitest';
import { filterWorkflows } from './listFilters';
const rows = [
  { id: '1', name: 'Welcome flow', status: 'ACTIVE', version: 1, trigger: { type: 'lead.created' } },
  { id: '2', name: 'Win-back', status: 'PAUSED', version: 1, trigger: { type: 'lead.status_changed' } },
];
describe('filterWorkflows', () => {
  it('returns all with empty search + ALL status', () => {
    expect(filterWorkflows(rows, { search: '', status: 'ALL' })).toHaveLength(2);
  });
  it('matches name case-insensitively', () => {
    expect(filterWorkflows(rows, { search: 'win', status: 'ALL' }).map(r => r.id)).toEqual(['2']);
  });
  it('matches trigger type', () => {
    expect(filterWorkflows(rows, { search: 'status_changed', status: 'ALL' }).map(r => r.id)).toEqual(['2']);
  });
  it('filters by status', () => {
    expect(filterWorkflows(rows, { search: '', status: 'ACTIVE' }).map(r => r.id)).toEqual(['1']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement:**
```ts
import type { WorkflowRow } from './automationTypes';
export function filterWorkflows(rows: WorkflowRow[], f: { search: string; status: string }): WorkflowRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.status !== 'ALL' && r.status !== f.status) return false;
    if (!q) return true;
    return r.name.toLowerCase().includes(q) || (r.trigger?.type ?? '').toLowerCase().includes(q);
  });
}
```

- [ ] **Step 4: Run — expect PASS. Step 5: Commit** `feat(automations): list filter helper`.

---

## Task 4: Visual step editors + Advanced JSON

**Files:**
- Create: `frontend/src/pages/marketing/automations/stepEditors/BranchConditionBuilder.tsx`
- Create: `.../stepEditors/UpdateLeadEditor.tsx`
- Create: `.../stepEditors/AiClassifyEditor.tsx`
- Create: `.../stepEditors/WebhookEditor.tsx`
- Create: `.../stepEditors/AdvancedJsonField.tsx`
- Test: `.../stepEditors/BranchConditionBuilder.test.tsx`

Each editor takes `{ step: AnyStep; onPatch: (patch) => void }` and renders controlled inputs. `BranchConditionBuilder` uses the Task 2 helpers; `onPatch({ filters })`.

- [ ] **Step 1: Failing test (BranchConditionBuilder)** — render, add a row, type a field, assert `onPatch` last call has `filters` with that field. Use `@testing-library/react` + `userEvent`. Mock i18n inline (copy the `vi.mock('react-i18next', …)` pattern from `SocialPlannerPage.test.tsx`). Assert: initial empty → click "Add condition" → `onPatch` called with `{ filters: [{ field:'', op:'eq', value:'' }] }`.

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BranchConditionBuilder } from './BranchConditionBuilder';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: any, d: any) => (typeof d === 'string' ? d : _k), i18n: { language: 'en' } }) }));

it('adds a condition row via onPatch', async () => {
  const onPatch = vi.fn();
  render(<BranchConditionBuilder step={{ type: 'branch', filters: [] }} onPatch={onPatch} />);
  await userEvent.click(screen.getByRole('button', { name: /add condition/i }));
  expect(onPatch).toHaveBeenLastCalledWith({ filters: [{ field: '', op: 'eq', value: '' }] });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `BranchConditionBuilder.tsx`** (rows of Input/Select/Input + add/remove using `addCondition`/`removeCondition`/`patchCondition`; plus an "else → go to step N" number input writing `elseGoto`). Implement the other editors:
  - `UpdateLeadEditor.tsx`: rows from `setObjectToRows(step.set)`, edits call `onPatch({ set: rowsToSetObject(rows) })`.
  - `AiClassifyEditor.tsx`: prompt textarea + categories (comma input → `categories[]`) + per-category route number inputs (`routes`).
  - `WebhookEditor.tsx`: url Input, method Select (GET/POST/PUT/PATCH/DELETE), body Textarea.
  - `AdvancedJsonField.tsx`: a collapsible (`Accordion` or a `<details>`-style toggle) with a mono `Textarea` bound to `JSON.stringify(step, null, 2)`; on change, parse → if valid call `onReplace(parsed)`, else show inline error. Props `{ step; onReplace; }`.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(automations): visual editors for branch/update_lead/ai_classify/webhook + advanced JSON`.

---

## Task 5: StepPropertyPanel (selected-step editor host)

**Files:**
- Create: `frontend/src/pages/marketing/automations/StepPropertyPanel.tsx`
- Test: `.../StepPropertyPanel.test.tsx`

Move the existing `StepEditor` body from `WorkflowCanvas.tsx` (the simple email/sms/wait/task/tag/assign/notify fields) into `StepPropertyPanel`, then add the Task-4 editors for branch/update_lead/ai_classify/http_webhook_out, and the `AdvancedJsonField` at the bottom (collapsed). Props:
```ts
interface Props {
  index: number | null;            // null = nothing selected
  step: AnyStep | null;
  count: number;
  onPatch: (patch: Record<string, unknown>) => void;
  onReplace: (step: AnyStep) => void;   // from Advanced JSON
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
}
```
When `index == null`, show the existing hint ("Click a step to edit it…"). The move/delete footer stays.

- [ ] **Step 1: Failing test** — render with a `send_email` step, type in Subject, assert `onPatch({ subject })`; render with a `branch` step, assert the condition builder ("Add condition" button) appears (proves the previously-JSON-only type is now visual).
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(automations): StepPropertyPanel hosting all step editors`.

---

## Task 6: WorkflowCanvas — palette out, panel out

**Files:**
- Modify: `frontend/src/pages/marketing/automations/WorkflowCanvas.tsx`

- [ ] **Step 1:** Change `WorkflowCanvasProps` to expose selection + add-step to the parent and drop the internal right panel:
```ts
export interface WorkflowCanvasProps {
  triggerType: string;
  steps: AnyStep[];
  goal?: DslGoal | null;
  selected: number | null;
  onSelect: (index: number | null) => void;
  onStepsChange: (next: AnyStep[]) => void;
  onGoalChange?: (goal: DslGoal | null | undefined) => void;
}
```
Remove the in-canvas add-step palette overlay and the right-hand property `<div>`/`StepEditor` (now in the rail + panel). The component renders ONLY the React Flow surface filling its container (`h-full w-full`). Keep `addStep`/`patchStep`/`deleteStep`/`moveStep` logic but expose `addStep`, `deleteStep`, `moveStep`, `patchStep` via a small imperative export OR lift them to the parent. **Decision:** lift `deleteStep`/`moveStep`/`patchStep`/`addStep` into a new pure module `stepOps.ts` (TDD) so both the canvas (none now) and the builder page use them.

- [ ] **Step 2: Create `stepOps.ts` + test** (pure): `appendStep(steps, type)`, `deleteStepAt(steps, idx, goal)→{steps, goal}`, `moveStepAt(steps, idx, dir, goal)→{steps, goal}` — wrapping `NEW_STEP`, `remapJumpTargets`, `remapGoalGoto`. Move `NEW_STEP` here. Tests: delete remaps elseGoto; move swaps; append adds default config.
- [ ] **Step 3:** Canvas keeps only graph build + selection click. `StepEditor` and `Labeled`/`clampInt` move into `StepPropertyPanel.tsx`.
- [ ] **Step 4: Run** existing `workflowGraph.test.ts` + new `stepOps.test.ts` — PASS.
- [ ] **Step 5: Commit** `refactor(automations): slim WorkflowCanvas, extract stepOps`.

---

## Task 7: BuilderSettingsRail + BuilderTopBar

**Files:**
- Create: `frontend/src/pages/marketing/automations/BuilderSettingsRail.tsx`
- Create: `frontend/src/pages/marketing/automations/BuilderTopBar.tsx`

- [ ] **Step 1: `BuilderTopBar.tsx`** — props `{ name, onNameChange, status, dirty, saving, onBack, onSave, onToggleStatus }`. Sticky bar: back `IconButton` (ArrowLeft), inline `Input` for name, status `Badge`, `Save` button (loading=saving), Activate/Pause button (only when editing an existing workflow → gated by a `canToggle` prop).
- [ ] **Step 2: `BuilderSettingsRail.tsx`** — props `{ triggerType, onTriggerChange, filters, onFiltersChange, aiPrompt, onAiPromptChange, onDraft, drafting, onAddStep }`. Renders: Trigger `Select` (the `TRIGGER_TYPES` list, moved into a shared `constants.ts`), Trigger-filters `Textarea` (JSON, optional — kept as JSON here; advanced), AI-assist `Callout` (Input + Draft button), and the categorized step palette (buttons grouped Send/Flow/Action/AI using `STEP_META` tone) calling `onAddStep(type)`.
- [ ] **Step 3:** Create `constants.ts` with `TRIGGER_TYPES` and `STEP_PALETTE` groups (moved from `AutomationsPage.tsx`).
- [ ] **Step 4:** Smoke test each renders (mount with stub props, assert a key control present).
- [ ] **Step 5: Commit** `feat(automations): builder top bar + settings rail`.

---

## Task 8: AutomationBuilderPage (assembly) + routes

**Files:**
- Create: `frontend/src/pages/marketing/automations/AutomationBuilderPage.tsx`
- Modify: `frontend/src/App.tsx`
- Test: `.../AutomationBuilderPage.test.tsx`

- [ ] **Step 1: Failing route-render test** — mock `marketingApi` (`get` returns a workflow for `/workflows/:id`), render `<AutomationBuilderPage/>` inside `MemoryRouter` at `/automations/abc/edit` with a route param, assert the workflow name appears in the top-bar input and the canvas trigger node renders. Also a `/automations/new` mount renders an empty builder. (Mirror the mock+wrapper pattern from `SocialPlannerPage.test.tsx`.)
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement `AutomationBuilderPage.tsx`:**
  - `const { id } = useParams()`; `isEdit = !!id`.
  - State: `const [state, setState] = useState<BuilderState>(DEFAULT_BUILDER_STATE)`; `selected`; `aiPrompt`; `existingStatus`; `dirty`.
  - On edit: `useQuery(['marketing','workflow',id], () => GET /workflows/:id)`, on success `setState(fromWorkflowDto(dto))` + keep `dto.goal` for read-only canvas display (store `existingGoal`); on `?template`/`?ai` (read `useSearchParams`) prefill via `fromTemplate` / call draft.
  - Save mutation: `toSavePayload(state)` → `PATCH /workflows/:id` or `POST /workflows`; on success invalidate `['marketing','workflows']`, toast, `navigate('/automations')`.
  - Draft mutation (`POST /workflows/draft`) sets trigger/filters/steps from the AI response.
  - Status toggle mutation (`POST /workflows/:id/status`) — only in edit mode.
  - `canvasGoal = state.goal !== undefined ? state.goal : existingGoal`.
  - Layout: `BuilderTopBar` (sticky) over a 3-column flex: `BuilderSettingsRail` (left, collapsible), `WorkflowCanvas` (center, `flex-1 h-[calc(100vh-…)]`), `StepPropertyPanel` (right). Wire `onAddStep`→`appendStep`, selection, `onPatch`/`onReplace`/`onDelete`/`onMove`→`stepOps` + `setState`.
- [ ] **Step 4:** App.tsx: add
```tsx
const AutomationBuilderPage = lazy(() => import('./pages/marketing/automations/AutomationBuilderPage'));
// …in the marketing routes group, near /automations:
<Route path="/automations/new" element={<S><AutomationBuilderPage /></S>} />
<Route path="/automations/:id/edit" element={<S><AutomationBuilderPage /></S>} />
```
- [ ] **Step 5: Run — PASS** (`tsc --noEmit` + the new test).
- [ ] **Step 6: Commit** `feat(automations): full-page builder shell + routes`.

---

## Task 9: AutomationsListPage (rework) + drop the modal

**Files:**
- Create: `frontend/src/pages/marketing/automations/AutomationsListPage.tsx`
- Modify: `frontend/src/pages/marketing/AutomationsPage.tsx` → `export { default } from './automations/AutomationsListPage';`
- Test: `.../AutomationsListPage.test.tsx`

- [ ] **Step 1: Failing test** — render list with two workflows (mock `marketingApi.get('/workflows')`), type in search → only matching row remains (uses `filterWorkflows`); assert there is **no** builder dialog (the old `Dialog` with the steps editor is gone) and that "New automation" is a button/menu. Click "Edit" → asserts `navigate` called with `/automations/:id/edit` (spy `useNavigate`).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the list: `PageHeader` with a "New automation" `DropdownMenu` (Blank → `navigate('/automations/new')`; From template → opens the template picker `Dialog` (kept, but now it `navigate('/automations/new?template=key')`); Describe with AI → small `Dialog`/`Popover` with a prompt → `navigate('/automations/new?ai=' + encodeURIComponent(prompt))`). Search `Input` + status `SegmentedControl`/`Select`. Rows: same card layout + a stats line (`started → completed`). Keep `ConfirmDialog` (delete), `EnrollByFilterDialog`, and the status toggle mutation. Remove the create/edit `Dialog`, the `useForm`, the `WorkflowCanvas` import, `STEP_TEMPLATES`, `appendStep`, `parsedSteps`, `builderView`, `pendingGoal`/`existingGoal`, etc. (all moved to the builder page).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(automations): reworked list page, builder modal removed`.

---

## Task 10: i18n keys + final sweep

**Files:**
- Modify: `frontend/src/i18n/locales/{en,tr,ru,ar,uz}/marketing.json` (add any new `automations.*` keys used: `searchPlaceholder`, `status.all/active/paused/draft`, `newBlank`, `newFromTemplate`, `newWithAi`, `addCondition`, `elseGoto`, `advancedJson`, `invalidJson`, `statsStarted`, `statsCompleted`, etc.). All new `t()` calls already pass English `defaultValue`, so missing keys degrade gracefully; add at least `en` + `tr`.

- [ ] **Step 1:** Add keys to `en` and `tr` marketing.json (others fall back to defaultValue).
- [ ] **Step 2: Run full gate:**
```
cd frontend
npx vitest run src/pages/marketing/automations/
npx tsc --noEmit
npx eslint src/pages/marketing/automations src/pages/marketing/AutomationsPage.tsx src/App.tsx
```
Expected: all green, EXIT 0.
- [ ] **Step 3: Commit** `chore(automations): i18n keys + lint/type sweep`.

---

## Self-Review notes
- **Spec coverage:** routes (Task 8), list rework+entry flow (Task 9), all-visual step editors + hidden JSON (Tasks 4–5), state model change to typed `steps[]` (Tasks 1, 8), backend untouched (no backend task), tests (each task TDD). ✓
- **Type consistency:** `BuilderState` (Task 1) used by `toSavePayload`/builder (Tasks 1, 8); `Condition`/`SetRow` (Task 2) used by editors (Task 4); `stepOps` (Task 6) used by builder (Task 8). ✓
- **No placeholders:** pure-logic tasks carry full code; component tasks specify props/behavior + the one critical test. Component JSX is assembled against existing primitives (`@/components/ui`) following `CreateLeadPage`/`SocialPlannerPage` patterns.
