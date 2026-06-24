-- Per-period rebilling idempotency. computeCharge dedups with a findFirst then
-- create — race-prone (two concurrent computes both insert) and unbacked by any
-- DB constraint. At most one non-FAILED charge per (agency, location, period);
-- FAILED rows are excluded so a retry after a failed settle can re-compute.
CREATE UNIQUE INDEX "rebill_charges_agency_location_period_key"
  ON "rebill_charges" ("workspaceId", "locationWorkspaceId", "periodStart", "periodEnd")
  WHERE "status" <> 'FAILED';
