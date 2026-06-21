-- AlterTable
ALTER TABLE "marketing_users" ADD COLUMN     "dahili" TEXT;

-- CreateTable
CREATE TABLE "telephony_configs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'netgsm-netsantral',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "configSealed" TEXT,
    "trunk" TEXT,
    "pbxnum" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telephony_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telephony_configs_workspaceId_key" ON "telephony_configs"("workspaceId");
