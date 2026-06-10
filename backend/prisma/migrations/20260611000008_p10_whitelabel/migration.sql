-- P10: white-label-lite. Additive (one new table).

CREATE TABLE "workspace_branding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandName" TEXT,
    "accentColor" TEXT,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workspace_branding_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workspace_branding_workspaceId_key" ON "workspace_branding"("workspaceId");
