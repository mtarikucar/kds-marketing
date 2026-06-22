# Task assignment UX — fixes + improvements

**Date:** 2026-06-22
**Status:** Design — approved
**Part of:** [[ghl-parity-program]]

## Problem (reported + investigated)

The marketing task-assignment UI has three bugs and a UX gap:

1. **Date off-by-one.** `TaskFormDialog.tsx:209` does `field.onChange(date.toISOString().split('T')[0])`. The DatePicker yields a local-midnight `Date`; for a UTC+ user (Turkey UTC+3) `toISOString()` rolls back to the previous day, so the saved date is one day earlier than picked. (Read-back at line 208 uses `…T12:00:00` so display is fine — only the write is wrong.)
2. **No hourly tasks.** The model `MarketingTask.dueDate` is a `DateTime` and the backend accepts a datetime (`@IsDateString`), but the form has only a date picker — it sends a date-only string, which the service stores as end-of-day (`…T23:59:59.999Z`). No time can be set.
3. **Can't assign to a past date.** Blocked in **two** places: the frontend `taskSchema.dueDate` `.refine(v => new Date(v).getTime() > Date.now() - 5min, 'dateFuture')`, and the backend `MarketingTasksService.assertDueDateNotInPast` (`'dueDate must not be in the past'`).
4. **No assignee picker.** `taskSchema` + `CreateTaskDto` + the service all support `assignedToId` (defaults to the creator), and `TasksPage` already forwards it + shows an "assignedTo" column — but `TaskFormDialog` never renders an assignee field, so a task can only be created for oneself.

There are **two** task-creation UIs that share the schema/backend: `TasksPage → TaskFormDialog` (the main one, calendar DatePicker) and `leadDetail/TasksTab` (a simpler inline form with its own `dueDate` input).

## Design

### 1. Timezone-correct date + time (fixes #1, adds #2)
Add a helper `toLocalYmd(date: Date): string` = `${y}-${pad(m+1)}-${pad(d)}` from **local** `getFullYear/getMonth/getDate` (no `toISOString`). In `TaskFormDialog`:
- Keep the calendar `DatePicker`; its `onChange` stores `toLocalYmd(date)` (off-by-one gone).
- Add a `<input type="time">` (HH:mm) next to it, defaulting to a sensible time (e.g. `09:00`, or the next hour).
- The form value becomes a **full local datetime**: on submit, combine `new Date(`${ymd}T${hhmm}`)` (parsed as LOCAL wall-clock by JS) → `.toISOString()` → send the ISO datetime as `dueDate`.

`taskSchema.dueDate` becomes a datetime string and **drops** the `'dateFuture'` refine (only "required" + valid-date remain). Store date+time internally as `{ dueDate: ymd, dueTime: hhmm }` in the form, or a single ISO — implementation detail for the plan; the submitted `dueDate` is a full ISO datetime.

### 2. Allow past dates (fixes #3)
- Frontend: remove the `.refine(...'dateFuture')` from `taskSchema.dueDate`.
- Backend: rename `assertDueDateNotInPast` → `parseDueDate`; keep the date-only→end-of-day parse (back-compat) + the "Invalid dueDate" guard; **remove** the past-date rejection. (Update both create + update paths that call it.)

### 3. Assignee picker (fixes #4)
- Add an "Atanan kişi" (Assignee) `Select` to `TaskFormDialog`, listing the workspace's marketing users, defaulting to the current user. The reps list is already fetched on `TasksPage` (for the rep filter) — pass it into the dialog (or fetch via the same `/users` query). Wire the selection into `assignedToId` (already in the schema + forwarded by `TasksPage` + handled by the service).

### 4. UX polish
- Lay date + time on one row; assignee on its own row.
- **Quick presets** (buttons): "Bugün 18:00", "Yarın 09:00", "+1 hafta" — each sets date+time in one click (local, timezone-correct via the same helper).
- `TasksPage` due column shows date **+ time** (`fmtDateTime`) so the hour is visible; keep the overdue styling (now hour-accurate).

### 5. Consistency — `leadDetail/TasksTab`
The shared `taskSchema` + backend changes auto-apply (past dates allowed there too). Bring its own `dueDate` input in line: use the same date+time + `toLocalYmd` approach (or at least fix off-by-one + send a valid datetime). Assignee on lead tasks defaults to the creator (no picker needed there unless trivial to add).

## Files

**Frontend:**
- `src/pages/marketing/tasks/TaskFormDialog.tsx` — date+time inputs, `toLocalYmd`, assignee Select, presets.
- `src/features/marketing/schemas.ts` — `taskSchema.dueDate`: datetime string, drop `'dateFuture'`.
- `src/pages/marketing/tasks/TasksPage.tsx` — pass reps into the dialog; due column shows time (`fmtDateTime`).
- `src/features/marketing/utils/format.ts` — reuse `fmtDateTime` (exists); add `toLocalYmd` helper (or colocate in a date util).
- `src/pages/marketing/leadDetail/TasksTab.tsx` — align date/time handling.

**Backend:**
- `src/modules/marketing/services/marketing-tasks.service.ts` — `assertDueDateNotInPast` → `parseDueDate` (no past rejection); update create + update call sites.
- (`create-task.dto.ts` / `update-task.dto.ts` already accept `@IsDateString` + `assignedToId` — no change.)

## Testing
- **Off-by-one:** `toLocalYmd` returns the picked local day (e.g. a Date at 2026-06-22 00:00 local → "2026-06-22", not "-21"); a submit round-trip preserves the chosen calendar day.
- **Hourly:** picking 2026-06-22 + 14:30 submits an ISO datetime whose local time is 14:30; the value survives create→read.
- **Past date:** `parseDueDate('2020-01-01')` returns a Date (no throw); schema accepts a past date.
- **Assignee:** selecting another rep submits `assignedToId`; default is the current user.
- **BE service:** `parseDueDate` — valid date/datetime parsed, invalid throws, past allowed.

## Out of scope (YAGNI)
Recurring tasks, reminders/notifications timing changes, calendar drag-drop, per-task timezone selection (we use the browser's local zone).
