-- Epic 13 call-recording: watermark column so the hourly sweep makes forward progress.
ALTER TABLE "sales_calls" ADD COLUMN "recordingCheckedAt" TIMESTAMP(3);
