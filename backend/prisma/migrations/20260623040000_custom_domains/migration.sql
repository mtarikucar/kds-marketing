-- Epic 13 custom-domain white-label. Additive: a brand-new table only.
CREATE TABLE "custom_domains" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "verifyToken" TEXT NOT NULL,
    "homeSlug" TEXT NOT NULL DEFAULT 'home',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "txtVerifiedAt" TIMESTAMP(3),
    "sslStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_domains_pkey" PRIMARY KEY ("id")
);

-- A hostname maps to exactly one workspace, globally.
CREATE UNIQUE INDEX "custom_domains_hostname_key" ON "custom_domains"("hostname");

CREATE INDEX "custom_domains_workspaceId_idx" ON "custom_domains"("workspaceId");
