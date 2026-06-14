-- Migration: add lastGatherToken to voice_calls for Twilio gather idempotency (BUG 10)
ALTER TABLE "voice_calls" ADD COLUMN "lastGatherToken" TEXT;
