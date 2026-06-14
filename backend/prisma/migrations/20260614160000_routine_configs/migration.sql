-- Routine configs: platform-level configuration for the 4 cloud routines.
-- Each row holds the trigger URL + sealed token + schedule/event settings.
-- Rows are seeded on boot by RoutineConfigService.ensureSeeded().

-- CreateTable
CREATE TABLE "routine_configs" (
    "id"                 TEXT NOT NULL,
    "key"                TEXT NOT NULL,
    "enabled"            BOOLEAN NOT NULL DEFAULT false,
    "cron"               TEXT,
    "onEvent"            BOOLEAN NOT NULL DEFAULT false,
    "triggerUrl"         TEXT,
    "triggerTokenSealed" TEXT,
    "eventCooldownSec"   INTEGER NOT NULL DEFAULT 300,
    "lastTriggeredAt"    TIMESTAMP(3),
    "lastTriggerStatus"  TEXT,
    "lastTriggerError"   TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routine_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "routine_configs_key_key" ON "routine_configs"("key");
