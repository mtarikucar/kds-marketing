-- Hardware "Teklif Al" leads (source=HARDWARE_QUOTE): frozen catalog snapshot
-- + soft-FK to the requesting core tenant (string, no FK — core lives in
-- another database).
ALTER TABLE "leads" ADD COLUMN "productSnapshot" JSONB;
ALTER TABLE "leads" ADD COLUMN "originTenantId" TEXT;

CREATE INDEX "leads_originTenantId_idx" ON "leads"("originTenantId");
