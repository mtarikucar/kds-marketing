-- DEVICE CONTROL — a workspace can drive a physical phone.
--
-- Purely additive: two new tables, nothing altered, nothing backfilled. A
-- deploy that applies this and then rolls back leaves two unused tables, which
-- is the cheapest possible failure for a capability nobody is using yet.
--
-- The server never reaches the phone. A local bridge authenticates as the
-- workspace, CLAIMS queued commands, runs them over ADB and writes back what
-- happened. `devices.mode` defaults to MANUAL so a freshly paired phone does
-- nothing without a person pressing the button.
CREATE TABLE IF NOT EXISTS "devices" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "platform"    TEXT NOT NULL DEFAULT 'ANDROID',
  "serial"      TEXT,
  "properties"  JSONB NOT NULL DEFAULT '{}',
  "mode"        TEXT NOT NULL DEFAULT 'MANUAL',
  "status"      TEXT NOT NULL DEFAULT 'ACTIVE',
  "lastSeenAt"  TIMESTAMP(3),
  "pairedAt"    TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "devices_workspaceId_status_idx"
  ON "devices"("workspaceId", "status");

CREATE TABLE IF NOT EXISTS "device_commands" (
  "id"            TEXT NOT NULL,
  "deviceId"      TEXT NOT NULL,
  "workspaceId"   TEXT NOT NULL,
  "kind"          TEXT NOT NULL,
  "args"          JSONB NOT NULL DEFAULT '{}',
  "status"        TEXT NOT NULL DEFAULT 'QUEUED',
  "source"        TEXT NOT NULL,
  "requestedBy"   TEXT,
  "result"        JSONB,
  "screenshotKey" TEXT,
  "error"         TEXT,
  "claimedAt"     TIMESTAMP(3),
  "completedAt"   TIMESTAMP(3),
  "expiresAt"     TIMESTAMP(3) NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_commands_pkey" PRIMARY KEY ("id")
);

-- The claim query reads (deviceId, status) in createdAt order; the audit read
-- is by workspace and time. Two indexes because they are two different
-- questions and the second one must not have to walk a device's whole history.
CREATE INDEX IF NOT EXISTS "device_commands_deviceId_status_createdAt_idx"
  ON "device_commands"("deviceId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "device_commands_workspaceId_createdAt_idx"
  ON "device_commands"("workspaceId", "createdAt");

-- Cascade: unpairing a device takes its command history with it. The audit
-- that matters after a device is gone lives in the product's own audit log,
-- not in a queue whose rows can no longer be acted on.
ALTER TABLE "device_commands"
  ADD CONSTRAINT "device_commands_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
