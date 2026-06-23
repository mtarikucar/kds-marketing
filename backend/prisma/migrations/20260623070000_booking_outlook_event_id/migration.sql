-- Outlook/O365 (Microsoft Graph) 2-way sync: mirror event id on bookings,
-- the Graph analogue of "googleEventId". Nullable; a transient `pending:<uuid>`
-- value claims the create so concurrent push paths can't mint duplicate events.
ALTER TABLE "bookings" ADD COLUMN "outlookEventId" TEXT;

CREATE INDEX "bookings_workspaceId_outlookEventId_idx" ON "bookings" ("workspaceId", "outlookEventId");
