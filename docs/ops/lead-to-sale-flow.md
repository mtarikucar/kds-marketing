# Lead → Sale: end-to-end flow

How a prospect enters the CRM and becomes a paying customer, step by step — the
single most critical flow in the marketing platform. This document is grounded
in the actual code (services, endpoints, `Lead.status` values and the side
effects each step fires), so it doubles as an operator guide and an engineering
reference.

> **Verified.** Each step below was traced against the implementation. The core
> chain (create → assign → progress → **convert → WON + commission + attribution**
> → approve/pay) is wired end-to-end.

---

## 0. The pipeline at a glance

```
                                 (re-engage / dedupe)
                                        ▲
  ENTRY ──► NEW ──► CONTACTED ──► MEETING_DONE / DEMO_SCHEDULED ──► OFFER_SENT ─┐
            │          │                    │                          WAITING  │
            └──► NOT_REACHABLE              └──────────────► LOST  ◄─────────────┤
                                                                                │
                                                            ┌── Convert ◄───────┘
                                                            ▼
                                                  WON  +  tenant provisioned
                                                       +  SIGNUP commission (PENDING)
                                                       +  source/rep attribution
                                                            │
                                              Approve ──► Mark Paid   (commission lifecycle)
                                              Renewals/upsells ──► RENEWAL/UPSELL commission
```

`Lead.status` values: `NEW`, `CONTACTED`, `NOT_REACHABLE`, `MEETING_DONE`,
`DEMO_SCHEDULED`, `OFFER_SENT`, `WAITING`, `WON`, `LOST`.
`WON` and `LOST` are **terminal** — a closed lead is never re-opened from the
status endpoint, and `WON` is reachable **only** through Convert (which
provisions the tenant + creates the commission).

---

## 1. A lead enters the system

A lead always lands in status **`NEW`**, is **auto-assigned** to a rep (per the
workspace's distribution config), and is **de-duplicated** by normalized
email/phone (a returning prospect reuses the existing lead instead of creating a
duplicate; tombstoned/merged leads are excluded). There are six entry points:

| Entry | How | Source | Notes |
|---|---|---|---|
| **Manual** | Panel → Leads → **New Lead** | as entered | Required: business name, contact, type, source. Fires the `lead.created` workflow trigger. |
| **Public form** | A published funnel form is submitted | `WEBSITE` | Fires `lead.created` + `form.submitted` triggers. |
| **Booking** | A visitor reserves a slot on a booking page | `WEBSITE` | Also creates the appointment + reminder. |
| **Live chat / WhatsApp / social DM** | First inbound message on a connected channel | per channel | Also opens a conversation in the inbox. |
| **CSV import** | Manager uploads + maps a CSV (Skip/Update dedupe) | mapped / `IMPORT` | A converted (WON) customer is never overwritten. |
| **AI research (ingest API)** | Automated research routine posts candidates | `AI_RESEARCH` | Per-workspace daily quota; deduped by external ref. |

> Dedup keys are **normalized** (case/format-insensitive), so the same person
> arriving via different channels collides onto one lead.

---

## 2. Working the lead (pipeline)

The rep moves the lead toward a sale. Every action is recorded on the lead's
**activity timeline**.

1. **Advance status** — Lead detail → *Change Status* → e.g. `CONTACTED` →
   `MEETING_DONE`/`DEMO_SCHEDULED` → **`OFFER_SENT`** / **`WAITING`**.
   Each change writes a `STATUS_CHANGE` activity and fires the
   `lead.status_changed` workflow trigger. Moving to `LOST` cancels open tasks.
2. **Log an activity** — note / call / visit / email on the timeline.
3. **Schedule a task** — a follow-up ("call tomorrow") with a due date; completing
   it fires the `task.completed` workflow trigger.
4. **Log a sales call** — one-click dial (`tel:`), then record the outcome; it
   mirrors onto the lead timeline as a `CALL` activity.
5. **Send an offer** — create an offer (plan / custom price / discount / trial /
   valid-until) as `DRAFT`, then **Send**. Sending flips the offer to `SENT` and,
   in the same transaction, advances the lead to **`OFFER_SENT`**.

Reaching `OFFER_SENT` or `WAITING` is what reveals the **Convert** button.

---

## 3. Convert to sale (the crux)

With the lead in `OFFER_SENT`/`WAITING`, the rep/manager clicks the green
**Convert to Customer** in the lead header and confirms (tenant name + admin
email/name, pre-filled; an optional linked offer). The **admin's temporary
password is generated and emailed server-side** — sales staff never handle it.

In **one transaction**, Convert:

- flips the lead to **`WON`** and stamps `convertedTenantId` + `convertedAt`
  (an idempotent claim — concurrent converts can't double-provision);
- **provisions the customer tenant + admin account** via the core provisioning
  port (idempotent on the lead id);
- marks the linked offer **`ACCEPTED`** and cancels the lead's open tasks;
- creates a **`SIGNUP` commission (`PENDING`)** for the lead's assigned rep
  (skipped only if the lead is unassigned);
- records **attribution** (source + rep) and emits the `lead.converted` event.

A welcome email goes to the new admin after the transaction (best-effort; never
rolls back the conversion). A converted lead can't be re-archived or re-converted.

---

## 4. After the sale — money & reporting

### Commission lifecycle
- New commissions start **`PENDING`**. On the **Commissions** page a manager
  **Approves** (`PENDING → APPROVED`) then **Marks Paid** (`APPROVED → PAID`);
  both are audit-logged. Reps see only their own commissions.
- **Recurring revenue:** when the converted tenant later pays a **renewal/upsell**
  (or starts a referral-driven self-serve subscription), the system auto-creates
  a **`RENEWAL`/`UPSELL`/`SIGNUP`** commission credited to **the rep who
  originally converted** the tenant (resolved from the SIGNUP commission, not the
  lead's current assignee), idempotent per payment.

### Reporting
- **Reports:** won/lost counts, conversion rate, by-source and by-region
  performance, rep leaderboards.
- **Commissions:** pending / approved / paid totals.
- **Targets:** each rep's period attainment vs target.
- **Attribution:** first/last/linear channel-credit models; a lead counts as
  converted off the real `WON`/`convertedTenantId` signal (not merely whether it
  had a priced offer).

---

## 5. Quick operator checklist

1. Lead arrives (any of the six entries) → **NEW**, auto-assigned.
2. Rep contacts → advances status, logs activities/calls, schedules tasks.
3. Rep sends an **offer** → lead → **OFFER_SENT**.
4. Click **Convert to Customer** → lead **WON**, tenant created, **commission**
   generated, attribution recorded.
5. Manager **approves** then **marks the commission paid**.
6. Recurring payments accrue further commissions to the converting rep.

---

_Maintainers: the canonical sources are `marketing-leads.service.ts` (create /
status / assign / **convert**), `marketing-offers.service.ts`,
`marketing-commissions.service.ts`, `settlement-commission.consumer.ts`
(lifetime commissions), `attribution.service.ts`, and the lead-in services under
`sites/` + `channels/` + `services/import|ingest`. Status transitions are
enforced by `ALLOWED_TRANSITIONS` in `marketing-leads.service.ts`._
