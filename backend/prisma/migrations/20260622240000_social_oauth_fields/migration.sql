-- AlterTable
ALTER TABLE "social_accounts" ADD COLUMN     "accountType" TEXT,
ADD COLUMN     "connectedVia" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "refreshToken" TEXT;

-- CreateTable
CREATE TABLE "pending_social_connections" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_social_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_social_connections_workspaceId_idx" ON "pending_social_connections"("workspaceId");
