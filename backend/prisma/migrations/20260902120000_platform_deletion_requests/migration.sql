-- Platform (Meta/TikTok/…) data-deletion callback requests.
-- Deliberately NOT workspace-scoped: the callback carries only a platform-scoped
-- user id and no tenant context. The real erasure audit stays in data_requests,
-- referenced by data_request_ids.
CREATE TABLE "platform_deletion_requests" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "confirmationCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "matchedLeads" INTEGER NOT NULL DEFAULT 0,
    "dataRequestIds" TEXT[],
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "platform_deletion_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_deletion_requests_confirmationCode_key" ON "platform_deletion_requests"("confirmationCode");

CREATE INDEX "platform_deletion_requests_platform_subjectHash_idx" ON "platform_deletion_requests"("platform", "subjectHash");
