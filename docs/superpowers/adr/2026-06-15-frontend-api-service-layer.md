# ADR: Frontend API Service Layer Convention

**Date:** 2026-06-15
**Status:** Accepted
**Deciders:** Engineering (marketing frontend)

---

## Context

The frontend currently makes HTTP calls by importing `marketingApi` (or `platformApi`) directly in each page component and inlining the axios call in the React Query `queryFn` or `useMutation` `mutationFn`:

```ts
// Before — inline axios inside a page component
queryFn: () =>
  marketingApi
    .get<PaginatedResponse<Lead>>('/leads', { params: { ... } })
    .then((r) => r.data),
```

This works, but has three friction points as the codebase grows:

1. **No typed home for endpoints.** Each endpoint string (e.g. `/leads/:id/activities`) and its param/payload shape lives wherever it's first used. Adding a second caller means copy-paste with no shared reference to catch drift.
2. **Return types live in the call-site annotation.** `marketingApi.get<PaginatedResponse<Lead>>` — if the domain type changes, every call-site must be updated manually.
3. **Testing** a mutation requires setting up a full React tree or mocking `marketingApi` at module level. A plain function is easier to stub.

The app already has everything else: domain models (`features/marketing/types.ts`), Zod schemas validating form payloads (`features/marketing/schemas.ts`), and two configured axios instances with interceptors (`marketingApi` / `platformApi`). A full DTO/model indirection layer across 30+ pages all at once is large and low-ROI. YAGNI applies.

---

## Decision

Introduce **typed per-feature service modules** (`*.service.ts`) that wrap `marketingApi` / `platformApi` and return the existing domain types. React Query hooks call service functions; Zod schemas validate form payloads before those functions are called.

### Rules

| Rule | Detail |
|---|---|
| **File location** | `features/<feature>/api/<feature>.service.ts` |
| **One function per logical operation** | `listLeads`, `getLead`, `updateLeadStatus`, … |
| **Returns domain types** | `Promise<Lead>`, `Promise<PaginatedResponse<Lead>>`, … (from `types.ts`) |
| **Thin wrapper only** | No caching, no retry logic, no UI side-effects — those stay in React Query / the hook layer |
| **Named payload types** | `LeadListParams`, `CreateActivityPayload`, etc. — defined in the same service file |
| **Query keys unchanged** | Service functions are not aware of query keys; keys stay in the hook call-site |
| **Zod validates forms** | Form payloads are validated by a Zod schema before reaching the service function; the service trusts its inputs |

### Reference implementation

`frontend/src/features/marketing/api/leads.service.ts` is the canonical example. It covers every endpoint the leads list page and lead detail page use:

- `listLeads(params: LeadListParams)` → `Promise<PaginatedResponse<Lead>>`
- `getLead(id)` → `Promise<DetailLead>`
- `upsertLead(payload, id?)` → `Promise<Lead>` (POST or PATCH depending on id)
- `updateLeadStatus(id, status)` → `Promise<void>`
- `convertLead(id, data)` → `Promise<void>`
- `deleteLead(id)` → `Promise<void>`
- `createLeadActivity(leadId, data)` → `Promise<LeadActivity>`
- `createOffer(data)` / `sendOffer(offerId)` / `deleteOffer(offerId)`
- `createTask(data)` / `completeTask(taskId)` / `deleteTask(taskId)`
- `bulkAssignLeads(leadIds, assignedToId)` → `Promise<{ assigned: number }>`

`LeadsPage.tsx` and `LeadDetailPage.tsx` have been refactored to call these functions. Query keys, params, payloads, and invalidations are identical — there is zero behavior change.

---

## Consequences

**Positive**

- Every endpoint has a single typed home; renaming a path or changing a response type is a one-file change.
- Page components no longer import `marketingApi` for leads calls; they import named, self-documenting functions.
- Service functions are plain async functions — trivial to unit-test or mock in component tests.

**Negative / Trade-offs**

- A thin indirection layer: callers must know to look in `leads.service.ts`, not in `marketingApi.ts`.
- Added file per feature (low cost, one-time).

**Deferred**

The full rollout (migrating all other feature pages to service modules) is an **explicit follow-up task**, not part of this change. Other pages continue to call `marketingApi` directly until their service module is authored. The pattern is now documented and demonstrated; adoption is incremental.

---

## Alternatives considered

| Option | Rejected because |
|---|---|
| Full sweep now (all 30+ pages) | High churn, low ROI, risky in one PR; YAGNI |
| Generated API client (OpenAPI/orval) | Valuable long-term, but requires backend spec maintenance and is a separate track |
| Keep inline calls everywhere | Accumulating friction; no typed home for endpoints |
