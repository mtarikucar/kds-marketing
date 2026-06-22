-- Epic 13 sending-domains / DKIM. Additive: a brand-new table only.
CREATE TABLE "sending_domains" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "fromEmail" TEXT,
    "fromName" TEXT,
    "dkimSelector" TEXT NOT NULL,
    "dkimPublicKey" TEXT NOT NULL,
    "dkimPrivateSealed" TEXT NOT NULL,
    "lastError" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "providerDomainId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sending_domains_pkey" PRIMARY KEY ("id")
);

-- One registration per (workspace, domain).
CREATE UNIQUE INDEX "sending_domains_workspaceId_domain_key" ON "sending_domains"("workspaceId", "domain");

CREATE INDEX "sending_domains_workspaceId_status_idx" ON "sending_domains"("workspaceId", "status");
