-- Count Anthropic SERVER-tool requests (web_search), which are billed per
-- request, not per token.
--
-- The August invoice showed 118 web searches ($1.18) that no token column
-- could ever have represented — NativeWebProvider drives them, and a
-- search-heavy research run reports only its cheap Haiku tokens while the
-- invoice also carries the per-search price.
--
-- Additive, defaulted: existing rows stay correct.

ALTER TABLE "ai_usage_logs"
  ADD COLUMN IF NOT EXISTS "webSearches" INTEGER NOT NULL DEFAULT 0;
