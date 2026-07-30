# Putting a workspace on a package (without a payment)

Every normal subscription is written by PSP settlement (`BillingSettlementService`),
agency sub-account provisioning, or registration (which grants `TRIAL`). None of
those can grant the internal **`OPERATOR`** package, and none of them can comp a
customer. This document covers the two paths that can.

Both write the **same** subscription row — they share
`backend/src/modules/billing/package-assignment.ts`
(`assignPackageToWorkspace`).

## What the grant writes, and why it survives the billing scheduler

| field | value | why |
| --- | --- | --- |
| `packageId` | the package with the requested `code` | the grant itself |
| `status` | `ACTIVE` | `EntitlementsService` only serves full entitlements for `ACTIVE`/`PAST_DUE`/live `TRIALING` |
| `trialEndsAt` | `null` | keeps the row out of the scheduler's `TRIALING and trialEndsAt < now → EXPIRED` branch **and** out of the read-side "trial past its end → zeroEntitlements" belt |
| `currentPeriodEnd` | `2999-12-31T00:00:00Z` | `BillingSchedulerService.sweepLifecycle()` runs hourly and flips every `ACTIVE` row whose `currentPeriodEnd < now` to `PAST_DUE` (then `EXPIRED` 7 days later). `WorkspaceSubscription` has **no** "never expires" flag, so a period end that never arrives is the only representation of a perpetual grant. |
| `cancelAtPeriodEnd` | `false` | the lapse branch routes `cancelAtPeriodEnd: true` rows to `CANCELLED` |
| `currentPeriodStart` | now (only when the row actually changes) | audit trail |
| `billingCycle` | `MONTHLY` | required column; meaningless for a comped grant |
| `currency` | workspace `defaultCurrency`, or `USD` if it isn't `TRY`/`USD` | required column |
| `provider` | `manual` | not a PSP subscription |
| `providerRef` | `null` | keeps the row out of `extendSubscriptionByProviderRef`'s lookups |

**Idempotent by construction**: the helper first reads the existing row and
writes nothing when it already matches the target grant (same package, `ACTIVE`,
`trialEndsAt: null`, `cancelAtPeriodEnd: false`, same far-future period end). A
redeploy therefore does not churn `updatedAt`/`currentPeriodStart`.

## Path 1 — deploy-time bootstrap (no credentials needed)

`backend/prisma/seed-operator-workspace.ts`, run by the backend container on
every boot (after `prisma migrate deploy` and after the package-catalog seed,
which must create the `OPERATOR` row first):

```
docker-compose.prod.yml → backend.command:
  npx prisma migrate deploy
  && (node dist-seed/seed-packages.js || echo '… continuing')
  && (node dist-seed/prisma/seed-operator-workspace.js || echo '… continuing')
  && (node dist-seed/prisma/seed-platform-operator.js || echo '… continuing')
  && node dist/main
```

- `OPERATOR_WORKSPACE_ID` **unset or blank → no-op, exit 0.** Safe in every
  environment; that is the default.
- Set but pointing at nothing → error + exit 1. The `|| echo … continuing`
  wrapper keeps it non-fatal, so a bad id is loud in `docker logs` without
  blocking boot.
- Locally: `OPERATOR_WORKSPACE_ID=<uuid> npx ts-node prisma/seed-operator-workspace.ts`.

Find the workspace id with `SELECT id, name, slug FROM workspaces;` or from the
operator console's workspace list.

## Path 2 — operator console endpoint (any workspace, any package)

```
PATCH /api/platform/workspaces/:id/subscription
Authorization: Bearer <platform operator JWT>     (PlatformGuard)
Content-Type: application/json

{ "packageCode": "OPERATOR" }
```

- `packageCode` is validated against the **live** `Package` catalog — an unknown
  code returns **400** with the list of valid codes (adding a package to
  `seed-packages.ts` is enough; there is no hard-coded enum). The code is
  trimmed and upper-cased before lookup.
- Unknown workspace → **404**.
- Success → **200** with the resulting effective grant:

```json
{
  "workspaceId": "…",
  "packageCode": "OPERATOR",
  "packageName": "Operator (internal)",
  "status": "ACTIVE",
  "changed": true,
  "currentPeriodEnd": "2999-12-31T00:00:00.000Z",
  "trialEndsAt": null,
  "limits": { "dailyLeadQuota": -1, "maxUsers": -1, "maxResearchProfiles": -1,
              "aiCreditsMonthly": -1, "messagesMonthly": -1, "maxAgents": -1,
              "maxWorkflows": -1, "maxFunnels": -1, "maxKnowledgeDocs": -1,
              "maxCalendars": -1 }
}
```

`changed: false` means the workspace was already on exactly this grant (the
call was a no-op). `-1` = unlimited.

The call is audited as `workspace.subscription.assign` (resource `workspace`,
body key `packageCode` captured) and it invalidates the 30-second effective-
entitlement cache, so the new plan is live on the very next request.

> After a large upgrade, a workspace that has an explicit `activatedModules`
> allow-list may still hide newly entitled modules — turn them on in
> Settings → Modules. (PSP settlement widens that list automatically; this
> manual grant deliberately does not touch tenant module choices.)

## GitHub secrets the owner must add

| secret | required? | effect when unset |
| --- | --- | --- |
| `OPERATOR_WORKSPACE_ID` | optional | the operator-package seed no-ops; nothing is granted |
| `PLATFORM_OPERATOR_EMAIL` | optional (set with the password) | the superadmin seed no-ops; the platform realm has no login |
| `PLATFORM_OPERATOR_PASSWORD` | optional (set with the email) | as above. Must be ≥ 12 characters and single-line (it is rendered into `.env.production`) |

Setting exactly one of the two `PLATFORM_OPERATOR_*` secrets is treated as a
misconfiguration (error + non-zero exit, still non-fatal to boot), not as an
opt-out. Every deploy re-runs the seed, which **rotates** the operator password
to the secret's current value and bumps `tokenVersion` — existing operator
sessions are logged out. Rotate by changing the secret and redeploying.

`deploy.yml` renders all three into `.env.production` in the usual two places
(the step's `env:` block and the `.env.rendered` heredoc).

## Caveat — `OPERATOR` is not a product

`OPERATOR` is seeded with `isPublic: false`, price 0, and every limit `-1`
(unlimited leads, users, AI credits, messages, agents…). It exists for the
platform-owner workspace only.

- It must **never** be selectable from any customer-facing surface. The public
  catalog endpoint filters on `isPublic`, and checkout must keep doing so —
  granting it is only possible through the platform realm (`PlatformGuard`) or
  a server-side env var, both operator-only by construction.
- It is also the only package with `fax: true` and unmetered AI credit, so a
  customer workspace parked on it would consume paid COGS with no revenue and
  no quota ceiling.
- Point `OPERATOR_WORKSPACE_ID` at the platform-owner workspace only. To comp a
  real customer, assign a **customer** package (`STARTER`/`GROWTH`/`SCALE`) via
  the endpoint instead — same mechanism, correct limits.
