# Task Assignment UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the marketing task-assignment UX — date off-by-one, no hourly time, can't pick a past date, no assignee picker — and polish the dialog.

**Architecture:** Two pure, unit-tested helpers carry the fix. Backend: a `parseDueDate` util (date-only → end-of-day for back-compat, full datetime as-is, **no past-date rejection**) replaces the service's private `assertDueDateNotInPast`. Frontend: a `datetime` util (`toLocalYmd` / `toLocalHm` / `localDateTimeToIso`) computes dates from **local** calendar fields (no `toISOString` round-trip → no off-by-one) and combines a date + time into a full ISO datetime that the API stores exactly. The form gains a time input, an assignee `Select`, and quick presets; the list shows the hour.

**Tech Stack:** Backend NestJS 11 + Jest. Frontend React + react-hook-form + zod + Radix Select + Vitest. The spec this implements: `docs/superpowers/specs/2026-06-22-task-assignment-ux-design.md`.

---

## File Structure

**Backend:**
- Create: `backend/src/modules/marketing/services/marketing-task-date.util.ts` — pure `parseDueDate(dueDate): Date`. One responsibility: parse a task due value into a `Date` (no past rejection).
- Create: `backend/src/modules/marketing/services/marketing-task-date.util.spec.ts` — unit tests for the util.
- Modify: `backend/src/modules/marketing/services/marketing-tasks.service.ts` — delegate to `parseDueDate`; drop the private method + the `PAST_DUE_GRACE_MS` constant.

**Frontend:**
- Create: `frontend/src/features/marketing/utils/datetime.ts` — `toLocalYmd`, `toLocalHm`, `localDateTimeToIso`. One responsibility: timezone-correct local date/time conversion.
- Create: `frontend/src/features/marketing/utils/datetime.test.ts` — unit tests for the util.
- Create: `frontend/src/features/marketing/schemas.test.ts` — tests for the `taskSchema` change.
- Modify: `frontend/src/features/marketing/schemas.ts` — `taskSchema`: add `dueTime`, drop the `dateFuture` refine.
- Modify: `frontend/src/pages/marketing/tasks/TaskFormDialog.tsx` — date+time row, assignee `Select`, quick presets, edit-populate split, default assignee.
- Modify: `frontend/src/pages/marketing/tasks/TasksPage.tsx` — fetch reps (managers), pass to dialog; combine date+time → ISO on submit; due column shows `fmtDateTime`.
- Create: `frontend/src/pages/marketing/tasks/TasksPage.test.tsx` — mounts + create payload smoke test.
- Modify: `frontend/src/pages/marketing/leadDetail/TasksTab.tsx` — align date+time handling (off-by-one fix + send valid datetime).
- Modify: `frontend/src/i18n/locales/tr/marketing.json` and `frontend/src/i18n/locales/en/marketing.json` — add time/assignee/preset labels.

**Decision (recorded):** The spec said "rename `assertDueDateNotInPast` → `parseDueDate`". We extract it to a pure util module instead of leaving it a private method, because the repo's convention is heavy util extraction (`netgsm-*.util.ts`, `marketing` utils) and a pure function is trivially unit-testable. Same name, same parse semantics, minus the past rejection.

**Decision (recorded):** The form keeps two fields — `dueDate` (`YYYY-MM-DD`, local) and `dueTime` (`HH:mm`). Submit handlers combine them into a full ISO datetime via `localDateTimeToIso` and send that single ISO string as the API's `dueDate`. This keeps the DatePicker + time input each bound to one clean value and localizes the off-by-one fix to one helper.

---

## Task 1: Backend `parseDueDate` util (no past rejection)

**Files:**
- Create: `backend/src/modules/marketing/services/marketing-task-date.util.ts`
- Create: `backend/src/modules/marketing/services/marketing-task-date.util.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/marketing/services/marketing-task-date.util.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { parseDueDate } from './marketing-task-date.util';

describe('parseDueDate', () => {
  it('parses a date-only string as end-of-day UTC (back-compat)', () => {
    const d = parseDueDate('2030-01-15');
    expect(d.toISOString()).toBe('2030-01-15T23:59:59.999Z');
  });

  it('parses a full ISO datetime as the exact instant', () => {
    const d = parseDueDate('2030-01-15T14:30:00.000Z');
    expect(d.toISOString()).toBe('2030-01-15T14:30:00.000Z');
  });

  it('accepts a Date and returns an equivalent Date', () => {
    const input = new Date('2030-01-15T08:00:00.000Z');
    expect(parseDueDate(input).toISOString()).toBe('2030-01-15T08:00:00.000Z');
  });

  it('allows a past date (no rejection)', () => {
    // The whole point of this change: past dates must NOT throw.
    expect(() => parseDueDate('2000-01-01')).not.toThrow();
    expect(parseDueDate('2000-01-01').toISOString()).toBe('2000-01-01T23:59:59.999Z');
  });

  it('throws BadRequestException on an unparseable value', () => {
    expect(() => parseDueDate('not-a-date')).toThrow(BadRequestException);
  });

  it('trims surrounding whitespace on a date-only string', () => {
    expect(parseDueDate('  2030-01-15  ').toISOString()).toBe('2030-01-15T23:59:59.999Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest marketing-task-date.util --silent`
Expected: FAIL — `Cannot find module './marketing-task-date.util'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/modules/marketing/services/marketing-task-date.util.ts`:

```ts
import { BadRequestException } from '@nestjs/common';

/**
 * Parse a task `dueDate` (date-only `YYYY-MM-DD`, full ISO datetime, or a Date)
 * into a `Date`. A date-only value is interpreted as the END of that day, not
 * UTC midnight — otherwise a task due "today", created in the afternoon by a
 * UTC+ user (e.g. UTC+3 / Turkey), would parse as hours in the past. Full
 * datetimes are used as-is.
 *
 * Past dates are ALLOWED — back-dating a task (e.g. logging a call that already
 * happened) is a legitimate workflow. The only failure is an unparseable value.
 */
export function parseDueDate(dueDate: Date | string): Date {
  const d =
    typeof dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dueDate.trim())
      ? new Date(`${dueDate.trim()}T23:59:59.999Z`)
      : new Date(dueDate);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException('Invalid dueDate');
  }
  return d;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest marketing-task-date.util --silent`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/services/marketing-task-date.util.ts backend/src/modules/marketing/services/marketing-task-date.util.spec.ts
git commit -m "feat(tasks): parseDueDate util — allow past due dates, keep date-only back-compat"
```

---

## Task 2: Wire `parseDueDate` into the tasks service

**Files:**
- Modify: `backend/src/modules/marketing/services/marketing-tasks.service.ts`

- [ ] **Step 1: Add the import**

At the top of `marketing-tasks.service.ts`, after the existing `MarketingEventTypes` import (line 14), add:

```ts
import { parseDueDate } from './marketing-task-date.util';
```

- [ ] **Step 2: Remove the now-unused grace constant**

Delete this block (lines 16–18):

```ts
// Allow a small grace for clock skew before rejecting a dueDate as
// "in the past". 5 minutes is enough for any sane client drift.
const PAST_DUE_GRACE_MS = 5 * 60 * 1000;
```

Leave `const MAX_CALENDAR_RANGE_DAYS = 62;` in place.

- [ ] **Step 3: Remove the private `assertDueDateNotInPast` method**

Delete the entire private method (lines 31–47):

```ts
  private assertDueDateNotInPast(dueDate: Date | string): Date {
    const d =
      typeof dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dueDate.trim())
        ? new Date(`${dueDate.trim()}T23:59:59.999Z`)
        : new Date(dueDate);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException('Invalid dueDate');
    }
    if (d.getTime() < Date.now() - PAST_DUE_GRACE_MS) {
      throw new BadRequestException('dueDate must not be in the past');
    }
    return d;
  }
```

- [ ] **Step 4: Update the `create()` call site**

In `create()`, change the `dueDate` line (was `dueDate: this.assertDueDateNotInPast(dto.dueDate),`) to:

```ts
        dueDate: parseDueDate(dto.dueDate),
```

- [ ] **Step 5: Update the `update()` call site**

In `update()`, change the line `if (dto.dueDate) data.dueDate = new Date(dto.dueDate);` to use the same parser (so a date-only update also lands at end-of-day, and a past date is allowed):

```ts
    if (dto.dueDate) data.dueDate = parseDueDate(dto.dueDate);
```

- [ ] **Step 6: Run the tasks service + full marketing suite to verify nothing broke**

Run: `cd backend && npx jest src/modules/marketing --silent`
Expected: PASS. (No spec referenced the deleted "dueDate must not be in the past" message — verified during planning. `BadRequestException` is still imported and used by `findCalendar`, so the import stays.)

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/marketing/services/marketing-tasks.service.ts
git commit -m "refactor(tasks): use parseDueDate in create/update; drop past-date rejection"
```

---

## Task 3: Frontend `datetime` util

**Files:**
- Create: `frontend/src/features/marketing/utils/datetime.ts`
- Create: `frontend/src/features/marketing/utils/datetime.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/marketing/utils/datetime.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toLocalYmd, toLocalHm, localDateTimeToIso } from './datetime';

describe('toLocalYmd', () => {
  it('returns the local calendar day, not a UTC-shifted one', () => {
    // Local midnight on 2026-06-22. In a UTC+ zone toISOString() would roll
    // this back to 2026-06-21 — toLocalYmd must NOT do that.
    const d = new Date(2026, 5, 22, 0, 0, 0); // month is 0-based: 5 = June
    expect(toLocalYmd(d)).toBe('2026-06-22');
  });

  it('zero-pads month and day', () => {
    const d = new Date(2026, 0, 5, 12, 0, 0); // 2026-01-05
    expect(toLocalYmd(d)).toBe('2026-01-05');
  });
});

describe('toLocalHm', () => {
  it('formats local hours and minutes zero-padded', () => {
    const d = new Date(2026, 5, 22, 9, 5, 0);
    expect(toLocalHm(d)).toBe('09:05');
  });
});

describe('localDateTimeToIso', () => {
  it('combines a local date + time into an ISO instant that reads back as that local wall-clock', () => {
    const iso = localDateTimeToIso('2026-06-22', '14:30');
    const back = new Date(iso);
    expect(back.getFullYear()).toBe(2026);
    expect(back.getMonth()).toBe(5);
    expect(back.getDate()).toBe(22);
    expect(back.getHours()).toBe(14);
    expect(back.getMinutes()).toBe(30);
  });

  it('defaults to 00:00 when no time is given', () => {
    const back = new Date(localDateTimeToIso('2026-06-22'));
    expect(back.getHours()).toBe(0);
    expect(back.getMinutes()).toBe(0);
  });

  it('returns empty string for an empty date', () => {
    expect(localDateTimeToIso('')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/marketing/utils/datetime.test.ts`
Expected: FAIL — cannot resolve `./datetime`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/features/marketing/utils/datetime.ts`:

```ts
/**
 * Timezone-correct local date/time helpers for the marketing forms.
 *
 * The bug these fix: `date.toISOString().split('T')[0]` on a local-midnight
 * Date in a UTC+ zone (Turkey is UTC+3) rolls the calendar day BACK one day.
 * These helpers read the LOCAL calendar fields instead, so the day the user
 * picked is the day that gets stored.
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local `YYYY-MM-DD` from a Date, using local calendar fields (no UTC shift). */
export function toLocalYmd(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local `HH:mm` from a Date. */
export function toLocalHm(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Combine a local `YYYY-MM-DD` and optional `HH:mm` into a full ISO datetime
 * string. `new Date('2026-06-22T14:30')` (no zone suffix) is parsed by JS as
 * LOCAL wall-clock, so `.toISOString()` yields the correct UTC instant.
 * Returns '' for an empty/invalid date so callers can guard.
 */
export function localDateTimeToIso(ymd: string, hm?: string): string {
  if (!ymd) return '';
  const d = new Date(`${ymd}T${hm || '00:00'}`);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/marketing/utils/datetime.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/marketing/utils/datetime.ts frontend/src/features/marketing/utils/datetime.test.ts
git commit -m "feat(tasks): local date/time util (toLocalYmd/toLocalHm/localDateTimeToIso)"
```

---

## Task 4: Schema change — add `dueTime`, drop the `dateFuture` refine

**Files:**
- Modify: `frontend/src/features/marketing/schemas.ts`
- Create: `frontend/src/features/marketing/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/marketing/schemas.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { taskSchema } from './schemas';

const base = {
  title: 'Call the lead',
  type: 'CALL' as const,
  priority: 'MEDIUM' as const,
};

describe('taskSchema', () => {
  it('accepts a past dueDate (past-date block removed)', () => {
    const r = taskSchema.safeParse({ ...base, dueDate: '2000-01-01', dueTime: '09:00' });
    expect(r.success).toBe(true);
  });

  it('still requires dueDate', () => {
    const r = taskSchema.safeParse({ ...base, dueDate: '' });
    expect(r.success).toBe(false);
  });

  it('accepts a valid HH:mm dueTime', () => {
    const r = taskSchema.safeParse({ ...base, dueDate: '2026-06-22', dueTime: '23:59' });
    expect(r.success).toBe(true);
  });

  it('rejects a malformed dueTime', () => {
    const r = taskSchema.safeParse({ ...base, dueDate: '2026-06-22', dueTime: '25:00' });
    expect(r.success).toBe(false);
  });

  it('allows dueTime to be omitted', () => {
    const r = taskSchema.safeParse({ ...base, dueDate: '2026-06-22' });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/marketing/schemas.test.ts`
Expected: FAIL — the past-date case fails because the current `.refine('dateFuture')` rejects `2000-01-01`.

- [ ] **Step 3: Apply the schema change**

In `frontend/src/features/marketing/schemas.ts`, replace the `taskSchema` `dueDate` field + add `dueTime`. Change this block:

```ts
  dueDate: z
    .string()
    .min(1, 'required')
    .refine((v) => new Date(v).getTime() > Date.now() - 5 * 60 * 1000, { message: 'dateFuture' }),
  leadId: z.string().optional(),
  assignedToId: z.string().optional(),
```

to:

```ts
  // Local YYYY-MM-DD. Combined with dueTime into a full ISO datetime on submit.
  // Past dates are allowed (back-dating a task is legitimate); the backend
  // parseDueDate accepts them too.
  dueDate: z.string().min(1, 'required'),
  // Optional HH:mm (24h). Defaults to a sensible hour in the form when blank.
  dueTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'timeInvalid')
    .optional(),
  leadId: z.string().optional(),
  assignedToId: z.string().optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/marketing/schemas.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/marketing/schemas.ts frontend/src/features/marketing/schemas.test.ts
git commit -m "feat(tasks): taskSchema adds dueTime, drops past-date block"
```

---

## Task 5: i18n keys (time, assignee, presets)

**Files:**
- Modify: `frontend/src/i18n/locales/tr/marketing.json`
- Modify: `frontend/src/i18n/locales/en/marketing.json`

Note: the components below call `t(key, { defaultValue })`, so a missing key never crashes — these additions keep tr/en clean. Other locales (ru/uz/ar) fall back to the `defaultValue`.

- [ ] **Step 1: Add Turkish keys**

In `frontend/src/i18n/locales/tr/marketing.json`, inside `leadDetail.taskDialog` (currently has `title`, `titleLabel`, `typeLabel`, `priorityLabel`, `dueDateLabel`, `descriptionLabel`), add two keys:

```json
      "timeLabel": "Saat",
      "assigneeLabel": "Atanan kişi"
```

In the same file, inside the `tasks` object, add a `presets` object:

```json
    "presets": {
      "today6pm": "Bugün 18:00",
      "tomorrow9am": "Yarın 09:00",
      "nextWeek": "+1 hafta"
    }
```

In the same file, inside the `validation` object, add:

```json
    "timeInvalid": "Geçersiz saat"
```

- [ ] **Step 2: Add English keys**

In `frontend/src/i18n/locales/en/marketing.json`, mirror the same structure:

`leadDetail.taskDialog`:

```json
      "timeLabel": "Time",
      "assigneeLabel": "Assignee"
```

`tasks.presets`:

```json
    "presets": {
      "today6pm": "Today 6:00 PM",
      "tomorrow9am": "Tomorrow 9:00 AM",
      "nextWeek": "+1 week"
    }
```

`validation`:

```json
    "timeInvalid": "Invalid time"
```

- [ ] **Step 3: Verify JSON is valid**

Run: `cd frontend && node -e "JSON.parse(require('fs').readFileSync('src/i18n/locales/tr/marketing.json','utf8')); JSON.parse(require('fs').readFileSync('src/i18n/locales/en/marketing.json','utf8')); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/i18n/locales/tr/marketing.json frontend/src/i18n/locales/en/marketing.json
git commit -m "i18n(tasks): time/assignee/preset labels (tr,en)"
```

---

## Task 6: TaskFormDialog — date+time, assignee picker, presets, off-by-one fix

**Files:**
- Modify: `frontend/src/pages/marketing/tasks/TaskFormDialog.tsx`

This is the main UI change. The dialog gains a `reps` prop (the workspace marketing users, passed from TasksPage), reads the current user from the auth store for the default assignee, splits an edited task's ISO `dueDate` into local `dueDate`+`dueTime`, and lays out a date+time row, quick-preset buttons, and an assignee `Select`.

- [ ] **Step 1: Update imports + props + add a RepRow type**

Replace the import block + props interface at the top. Change:

```ts
import { useEffect } from 'react';
```

to:

```ts
import { useEffect } from 'react';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { toLocalYmd, toLocalHm } from '../../../features/marketing/utils/datetime';
import type { MarketingUserInfo } from '../../../features/marketing/types';
```

Then change the `TaskFormDialogProps` interface:

```ts
interface TaskFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass a task to edit, or undefined/null to create. */
  task?: MarketingTask | null;
  onSubmit: (values: TaskFormValues) => void;
  isPending: boolean;
}
```

to:

```ts
interface RepRow extends MarketingUserInfo {
  role: string;
}

interface TaskFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass a task to edit, or undefined/null to create. */
  task?: MarketingTask | null;
  onSubmit: (values: TaskFormValues) => void;
  isPending: boolean;
  /** Workspace marketing users for the assignee picker (managers only). */
  reps?: RepRow[];
}
```

- [ ] **Step 2: Add a default-time constant and read the current user**

After the `PRIORITIES` const (line 51), add:

```ts
// Sensible default hour for a new task when none is picked.
const DEFAULT_DUE_TIME = '09:00';
```

Then change the component signature + add the auth store read. Change:

```ts
export function TaskFormDialog({
  open,
  onOpenChange,
  task,
  onSubmit,
  isPending,
}: TaskFormDialogProps) {
  const { t } = useTranslation('marketing');
  const isEdit = !!task;
```

to:

```ts
export function TaskFormDialog({
  open,
  onOpenChange,
  task,
  onSubmit,
  isPending,
  reps = [],
}: TaskFormDialogProps) {
  const { t } = useTranslation('marketing');
  const { user } = useMarketingAuthStore();
  const isEdit = !!task;
  const currentUserId = user?.id;
```

- [ ] **Step 3: Update defaultValues + edit-populate to include dueTime + assignee**

Replace the `useForm` defaultValues + the `useEffect` reset block. Change:

```ts
  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskSchema),
    mode: 'onBlur',
    defaultValues: {
      title: '',
      description: '',
      type: 'FOLLOW_UP',
      priority: 'MEDIUM',
      dueDate: new Date().toISOString().split('T')[0],
    },
  });

  // Populate form when editing
  useEffect(() => {
    if (open) {
      if (task) {
        form.reset({
          title: task.title,
          description: task.description || '',
          type: task.type as TaskFormValues['type'],
          priority: task.priority as TaskFormValues['priority'],
          dueDate: task.dueDate ? task.dueDate.split('T')[0] : new Date().toISOString().split('T')[0],
        });
      } else {
        form.reset({
          title: '',
          description: '',
          type: 'FOLLOW_UP',
          priority: 'MEDIUM',
          dueDate: new Date().toISOString().split('T')[0],
        });
      }
    }
  }, [task, open, form]);
```

to:

```ts
  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskSchema),
    mode: 'onBlur',
    defaultValues: {
      title: '',
      description: '',
      type: 'FOLLOW_UP',
      priority: 'MEDIUM',
      dueDate: toLocalYmd(new Date()),
      dueTime: DEFAULT_DUE_TIME,
      assignedToId: currentUserId,
    },
  });

  // Populate form when editing
  useEffect(() => {
    if (open) {
      if (task) {
        const due = task.dueDate ? new Date(task.dueDate) : null;
        form.reset({
          title: task.title,
          description: task.description || '',
          type: task.type as TaskFormValues['type'],
          priority: task.priority as TaskFormValues['priority'],
          dueDate: due ? toLocalYmd(due) : toLocalYmd(new Date()),
          dueTime: due ? toLocalHm(due) : DEFAULT_DUE_TIME,
          assignedToId: task.assignedTo?.id || currentUserId,
        });
      } else {
        form.reset({
          title: '',
          description: '',
          type: 'FOLLOW_UP',
          priority: 'MEDIUM',
          dueDate: toLocalYmd(new Date()),
          dueTime: DEFAULT_DUE_TIME,
          assignedToId: currentUserId,
        });
      }
    }
  }, [task, open, form, currentUserId]);
```

- [ ] **Step 4: Add a preset helper inside the component**

After the `handleSubmit` definition (the `const handleSubmit: SubmitHandler<TaskFormValues> = ...` block) and before `const errors = form.formState.errors;`, add:

```ts
  // Quick presets: set date+time in one click, all in local wall-clock so the
  // saved value matches what the label says.
  const applyPreset = (preset: 'today6pm' | 'tomorrow9am' | 'nextWeek') => {
    const now = new Date();
    let target: Date;
    let time: string;
    if (preset === 'today6pm') {
      target = now;
      time = '18:00';
    } else if (preset === 'tomorrow9am') {
      target = new Date(now);
      target.setDate(target.getDate() + 1);
      time = '09:00';
    } else {
      target = new Date(now);
      target.setDate(target.getDate() + 7);
      time = '09:00';
    }
    form.setValue('dueDate', toLocalYmd(target), { shouldValidate: true });
    form.setValue('dueTime', time, { shouldValidate: true });
  };
```

- [ ] **Step 5: Replace the Due Date field with a date+time row + presets**

Replace the entire `{/* Due Date */}` `<Field>...</Field>` block (the one wrapping the `DatePicker`) with:

```tsx
          {/* Due date + time */}
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Field
                label={t('leadDetail.taskDialog.dueDateLabel')}
                error={fieldErr(errors.dueDate?.message)}
                required
              >
                {() => (
                  <Controller
                    control={form.control}
                    name="dueDate"
                    render={({ field }) => (
                      <DatePicker
                        aria-label={t('leadDetail.taskDialog.dueDateLabel')}
                        value={field.value ? new Date(field.value + 'T12:00:00') : null}
                        onChange={(date) => field.onChange(toLocalYmd(date))}
                      />
                    )}
                  />
                )}
              </Field>

              <Field
                label={t('leadDetail.taskDialog.timeLabel', { defaultValue: 'Time' })}
                error={fieldErr(errors.dueTime?.message)}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    type="time"
                    className="w-32"
                    {...form.register('dueTime')}
                  />
                )}
              </Field>
            </div>

            {/* Quick presets */}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => applyPreset('today6pm')}>
                {t('tasks.presets.today6pm', { defaultValue: 'Today 6:00 PM' })}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => applyPreset('tomorrow9am')}>
                {t('tasks.presets.tomorrow9am', { defaultValue: 'Tomorrow 9:00 AM' })}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => applyPreset('nextWeek')}>
                {t('tasks.presets.nextWeek', { defaultValue: '+1 week' })}
              </Button>
            </div>
          </div>
```

- [ ] **Step 6: Add the assignee Select (after the date+time block, before Description)**

Immediately after the date+time `</div>` block from Step 5 and before the `{/* Description */}` field, add:

```tsx
          {/* Assignee — only when reps are available (managers); reps create for self */}
          {reps.length > 0 && (
            <Field
              label={t('leadDetail.taskDialog.assigneeLabel', { defaultValue: 'Assignee' })}
              error={fieldErr(errors.assignedToId?.message)}
            >
              {({ id, describedBy, invalid }) => (
                <Controller
                  control={form.control}
                  name="assignedToId"
                  render={({ field }) => (
                    <Select value={field.value || ''} onValueChange={field.onChange}>
                      <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {reps.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.firstName} {r.lastName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>
          )}
```

- [ ] **Step 7: Typecheck + run the FE suite**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src/pages/marketing/tasks`
Expected: tsc clean; no task-dialog tests yet (added in Task 7) so vitest reports "no test files" for that path or passes existing — that's fine. The real gate is `tsc --noEmit` passing.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/marketing/tasks/TaskFormDialog.tsx
git commit -m "feat(tasks): TaskFormDialog — date+time, presets, assignee picker, off-by-one fix"
```

---

## Task 7: TasksPage — fetch reps, combine date+time on submit, show time

**Files:**
- Modify: `frontend/src/pages/marketing/tasks/TasksPage.tsx`
- Create: `frontend/src/pages/marketing/tasks/TasksPage.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/marketing/tasks/TasksPage.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import TasksPage from './TasksPage';

const getMock = vi.fn();
const postMock = vi.fn().mockResolvedValue({ data: {} });
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: () => ({ user: { workspaceId: 'ws-1', role: 'MANAGER', id: 'u-1' } }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('TasksPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockImplementation((url: string) => {
      if (url === '/tasks') return Promise.resolve({ data: { data: [], meta: { total: 0 } } });
      if (url === '/users')
        return Promise.resolve({
          data: [{ id: 'u-1', firstName: 'Tarik', lastName: 'U', role: 'MANAGER' }],
        });
      return Promise.resolve({ data: {} });
    });
  });

  it('mounts without crashing and fetches reps for a manager', async () => {
    render(<TasksPage />, { wrapper });
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/users'));
    expect(screen.getByText(/./)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/marketing/tasks/TasksPage.test.tsx`
Expected: FAIL — TasksPage does not yet call `/users` (no reps query).

- [ ] **Step 3: Add imports for the reps query + datetime util + auth store**

In `TasksPage.tsx`, change the import of `fmtDate`:

```ts
import { fmtDate } from '../../../features/marketing/utils/format';
```

to:

```ts
import { fmtDateTime } from '../../../features/marketing/utils/format';
import { localDateTimeToIso } from '../../../features/marketing/utils/datetime';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import type { MarketingUserInfo } from '../../../features/marketing/types';
```

- [ ] **Step 4: Add a RepRow type**

After the `TYPE_TONE` const block (before `// ── Component ──`), add:

```ts
interface RepRow extends MarketingUserInfo {
  role: string;
}
```

- [ ] **Step 5: Add the reps query inside the component**

Right after `const { t } = useTranslation('marketing');` near the top of the component, add the auth + reps query:

```ts
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const { data: reps = [] } = useQuery<RepRow[]>({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
    enabled: isManager,
    staleTime: 60_000,
  });
```

- [ ] **Step 6: Combine date+time → ISO in the submit handler**

In `handleFormSubmit`, change the payload's `dueDate` line. Change:

```ts
    const payload: Record<string, unknown> = {
      title: values.title,
      type: values.type,
      priority: values.priority,
      dueDate: values.dueDate,
      ...(values.description ? { description: values.description } : {}),
      ...(values.leadId ? { leadId: values.leadId } : {}),
      ...(values.assignedToId ? { assignedToId: values.assignedToId } : {}),
    };
```

to:

```ts
    const payload: Record<string, unknown> = {
      title: values.title,
      type: values.type,
      priority: values.priority,
      // Combine the local date + time into a full ISO datetime so the hour the
      // rep picked is exactly what gets stored (no off-by-one, no end-of-day).
      dueDate: localDateTimeToIso(values.dueDate, values.dueTime),
      ...(values.description ? { description: values.description } : {}),
      ...(values.leadId ? { leadId: values.leadId } : {}),
      ...(values.assignedToId ? { assignedToId: values.assignedToId } : {}),
    };
```

- [ ] **Step 7: Show the time in the due column**

In the `dueDate` column `cell`, change `{fmtDate(task.dueDate)}` to `{fmtDateTime(task.dueDate)}`. The surrounding overdue logic already uses `new Date(task.dueDate) < new Date()`, which is now hour-accurate.

- [ ] **Step 8: Pass reps into the dialog**

In the `<TaskFormDialog ... />` render, add the `reps` prop. Change:

```tsx
      <TaskFormDialog
        open={formOpen}
        onOpenChange={handleDialogClose}
        task={editingTask}
        onSubmit={handleFormSubmit}
        isPending={createMutation.isPending || updateMutation.isPending}
      />
```

to:

```tsx
      <TaskFormDialog
        open={formOpen}
        onOpenChange={handleDialogClose}
        task={editingTask}
        onSubmit={handleFormSubmit}
        isPending={createMutation.isPending || updateMutation.isPending}
        reps={reps}
      />
```

- [ ] **Step 9: Run the test + typecheck**

Run: `cd frontend && npx vitest run src/pages/marketing/tasks/TasksPage.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean. (`fmtDate` import was removed — confirm no other use of `fmtDate` remains in this file; the only usage was the due column, now `fmtDateTime`.)

- [ ] **Step 10: Commit**

```bash
git add frontend/src/pages/marketing/tasks/TasksPage.tsx frontend/src/pages/marketing/tasks/TasksPage.test.tsx
git commit -m "feat(tasks): TasksPage fetches reps, sends ISO datetime, shows due time"
```

---

## Task 8: TasksTab (lead detail) — align date+time handling

**Files:**
- Modify: `frontend/src/pages/marketing/leadDetail/TasksTab.tsx`

The lead-detail inline task form uses a raw `<input type="date">` registered directly to `dueDate`, then sends `values.dueDate` (a bare `YYYY-MM-DD`) to the API. With the schema now expecting the submit handler to build an ISO datetime, align this form: add a time input and combine on submit. The off-by-one never affected this form's *write* (it sent the raw input string), but it sent a date-only value → stored end-of-day; aligning makes lead tasks hour-accurate too. No assignee picker here (lead tasks default to the creator per spec).

- [ ] **Step 1: Add the datetime util import**

After the existing type import line `import type { MarketingTask } from '../../../features/marketing/types';`, add:

```ts
import { localDateTimeToIso, toLocalYmd } from '../../../features/marketing/utils/datetime';
```

- [ ] **Step 2: Seed default date+time**

In the `useForm` defaultValues, change:

```ts
    defaultValues: {
      title: '',
      description: '',
      type: 'FOLLOW_UP',
      priority: 'MEDIUM',
      dueDate: '',
      leadId,
    },
```

to:

```ts
    defaultValues: {
      title: '',
      description: '',
      type: 'FOLLOW_UP',
      priority: 'MEDIUM',
      dueDate: toLocalYmd(new Date()),
      dueTime: '09:00',
      leadId,
    },
```

- [ ] **Step 3: Combine date+time → ISO on submit, and reset with the same defaults**

Change the `submit` handler:

```ts
  const submit: SubmitHandler<TaskFormValues> = (values) => {
    onCreate({
      title: values.title,
      type: values.type,
      priority: values.priority,
      dueDate: values.dueDate,
      leadId,
      ...(values.description ? { description: values.description } : {}),
    });
    form.reset({
      title: '',
      description: '',
      type: 'FOLLOW_UP',
      priority: 'MEDIUM',
      dueDate: '',
      leadId,
    });
    setOpen(false);
  };
```

to:

```ts
  const submit: SubmitHandler<TaskFormValues> = (values) => {
    onCreate({
      title: values.title,
      type: values.type,
      priority: values.priority,
      dueDate: localDateTimeToIso(values.dueDate, values.dueTime),
      leadId,
      ...(values.description ? { description: values.description } : {}),
    });
    form.reset({
      title: '',
      description: '',
      type: 'FOLLOW_UP',
      priority: 'MEDIUM',
      dueDate: toLocalYmd(new Date()),
      dueTime: '09:00',
      leadId,
    });
    setOpen(false);
  };
```

- [ ] **Step 4: Add a time input next to the date input**

Replace the single Due Date field:

```tsx
            <Field label="Due Date" required error={fieldErr(form.formState.errors.dueDate?.message)}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  type="date"
                  {...form.register('dueDate')}
                />
              )}
            </Field>
```

with a date+time row:

```tsx
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Field label="Due Date" required error={fieldErr(form.formState.errors.dueDate?.message)}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    type="date"
                    {...form.register('dueDate')}
                  />
                )}
              </Field>
              <Field label="Time" error={fieldErr(form.formState.errors.dueTime?.message)}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    type="time"
                    className="w-32"
                    {...form.register('dueTime')}
                  />
                )}
              </Field>
            </div>
```

- [ ] **Step 5: Typecheck + run the marketing FE suite**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src/pages/marketing src/features/marketing`
Expected: tsc clean; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/marketing/leadDetail/TasksTab.tsx
git commit -m "feat(tasks): lead-detail task form gains time input, sends ISO datetime"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Backend marketing suite**

Run: `cd backend && npx jest src/modules/marketing --silent`
Expected: all green (was 872 passing; +6 from the new util spec, no regressions).

- [ ] **Step 2: Frontend full suite + typecheck**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all vitest tests pass (existing + new datetime/schema/TasksPage tests).

- [ ] **Step 3: Frontend build (catches anything tsc/vitest miss)**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Manual smoke checklist (record results in the PR description)**

Over the running app:
- Create a task, pick a calendar day → the saved/listed due date is the SAME day (off-by-one gone).
- Set a time (e.g. 14:30) → the list shows date **and** 14:30.
- Use each preset → date+time fill correctly ("Bugün 18:00", "Yarın 09:00", "+1 hafta").
- Pick a past date → no validation error; task is created.
- As a manager, pick a different assignee → the task's "Sahibi"/assignee column shows that person.
- Open a lead → create a task from the lead detail tab with a date+time → stored hour-accurate.

---

## Self-Review (run before dispatching)

**Spec coverage:**
- Off-by-one (#1) → Task 3 (`toLocalYmd`) + Task 6 (DatePicker onChange) + Task 8.
- Hourly tasks (#2) → Task 3 (`localDateTimeToIso`) + Task 4 (`dueTime`) + Tasks 6/7/8 (time input + combine).
- Past dates (#3) → Task 1/2 (backend, drop rejection) + Task 4 (drop `dateFuture` refine).
- Assignee picker (#4) → Task 6 (Select) + Task 7 (reps query + pass-through).
- UX polish (presets, show time) → Task 6 (presets) + Task 7 (`fmtDateTime`).
- Consistency (leadDetail/TasksTab) → Task 8.

**Placeholder scan:** none — every code step shows complete code.

**Type consistency:** `toLocalYmd`/`toLocalHm`/`localDateTimeToIso` signatures are defined in Task 3 and used identically in Tasks 6/7/8. `dueTime` added to `taskSchema` in Task 4 is read in Tasks 6/7/8. `RepRow extends MarketingUserInfo` matches the existing pattern in CallsPage/LeadsPage. `parseDueDate` defined in Task 1, imported in Task 2.
