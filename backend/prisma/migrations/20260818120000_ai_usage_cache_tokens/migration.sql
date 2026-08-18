-- Record prompt-cache tokens alongside plain input/output.
--
-- Anthropic reports cache tokens SEPARATELY from `input_tokens` and bills them
-- at different rates: a cache write is 1.25x the input rate, a read is 0.1x.
-- Tool-schema caching was switched on in v2.184.0, which moved most of the
-- input volume out of `input_tokens` — so without these columns the cost
-- report would show the saving as total rather than ~90%, and would never show
-- cache-write cost at all. A spend report that errs optimistic is worse than
-- no report.
--
-- Additive, defaulted: rows written before caching remain correct as-is.

ALTER TABLE "ai_usage_logs"
  ADD COLUMN IF NOT EXISTS "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cacheReadTokens"  INTEGER NOT NULL DEFAULT 0;
