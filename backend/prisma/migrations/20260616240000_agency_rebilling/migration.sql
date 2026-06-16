-- Migration: agency rebilling / SaaS-mode (GoHighLevel "agency charges sub-account" parity).
--
-- Additive only: two new tables, `rebilling_plans` and `rebill_charges`. Both are
-- workspace-OWNED by the AGENCY (`workspaceId` is the agency's id, carrying the same
-- workspaceId-scoping invariant as every other owned delegate). `locationWorkspaceId`
-- points at the agency's child LOCATION the plan/charge is for; the agency↔location
-- relationship is bounded by the service layer (assertAgencyOwns), not a DB cascade —
-- matching this schema's soft-reference style (no FK to `workspaces`, like `snapshots`).
--
-- This does NOT touch the existing customer billing tables (packages, payment_orders,
-- workspace_subscriptions, invoices, workspace_psp_configs). Rebilling is a separate,
-- additive, agency-level settlement ledger.
--
-- Money stays Decimal(10,2) TRY — identical money semantics to packages/invoices.

-- One rebilling plan per child LOCATION (the monthly SaaS fee the agency charges it,
-- plus a markup applied to that location's REAL metered usage).
CREATE TABLE "rebilling_plans" (
  "id"                  TEXT NOT NULL,
  "workspaceId"         TEXT NOT NULL,           -- the AGENCY that owns this plan
  "locationWorkspaceId" TEXT NOT NULL,           -- the child LOCATION it bills
  "basePrice"           DECIMAL(10,2) NOT NULL DEFAULT 0,  -- flat monthly SaaS fee (TRY)
  "usageUnitPrice"      DECIMAL(10,2) NOT NULL DEFAULT 0,  -- agency cost basis per metered usage unit (TRY)
  "markupPercent"       DECIMAL(10,2) NOT NULL DEFAULT 0,  -- % markup the agency adds on metered usage
  "enabled"             BOOLEAN NOT NULL DEFAULT true,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "rebilling_plans_pkey" PRIMARY KEY ("id")
);
-- At most one plan per (agency, location) — the agency sets one SaaS plan per child.
CREATE UNIQUE INDEX "rebilling_plans_workspaceId_locationWorkspaceId_key"
  ON "rebilling_plans" ("workspaceId", "locationWorkspaceId");
CREATE INDEX "rebilling_plans_workspaceId_idx" ON "rebilling_plans" ("workspaceId");

-- A monthly settlement line per location: base + usage(with markup) = total.
-- status DRAFT → INVOICED/PAID (live Stripe-Connect charge) or FAILED.
CREATE TABLE "rebill_charges" (
  "id"                  TEXT NOT NULL,
  "workspaceId"         TEXT NOT NULL,           -- the AGENCY that owns this charge
  "locationWorkspaceId" TEXT NOT NULL,           -- the child LOCATION being settled
  "periodStart"         TIMESTAMP(3) NOT NULL,
  "periodEnd"           TIMESTAMP(3) NOT NULL,
  "baseAmount"          DECIMAL(10,2) NOT NULL DEFAULT 0,
  "usageAmount"         DECIMAL(10,2) NOT NULL DEFAULT 0,
  "totalAmount"         DECIMAL(10,2) NOT NULL DEFAULT 0,
  "usageUnits"          INTEGER NOT NULL DEFAULT 0,   -- raw metered units the usage line settled (audit trail)
  "status"              TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | INVOICED | PAID | FAILED
  "stripeChargeId"      TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rebill_charges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "rebill_charges_workspaceId_idx" ON "rebill_charges" ("workspaceId");
CREATE INDEX "rebill_charges_workspaceId_locationWorkspaceId_idx"
  ON "rebill_charges" ("workspaceId", "locationWorkspaceId");
