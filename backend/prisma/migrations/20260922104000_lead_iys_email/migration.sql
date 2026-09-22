-- İYS (İleti Yönetim Sistemi) EPOSTA consent, cached on the lead.
-- A live İYS search per recipient would run through the shared NetGSM rate
-- budget — 10 calls per 60 s, the same bucket a TİCARİ SMS campaign uses — so a
-- 50-recipient email tick would stall an unrelated SMS send. The answer is
-- cached here (ONAY | RET | UNKNOWN) and only a miss, or a stale check, goes out.
-- Both columns are nullable and stay null everywhere until a workspace arms the
-- EPOSTA gate: null means "never asked", which is not the same as RET.

-- AlterTable
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "iysEmailStatus" TEXT,
ADD COLUMN IF NOT EXISTS "iysEmailCheckedAt" TIMESTAMP(3);
