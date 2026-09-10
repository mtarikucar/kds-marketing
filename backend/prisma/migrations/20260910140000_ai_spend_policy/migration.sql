-- What this workspace is willing to spend AI money on, by job.
--
-- Measured on this deployment over 90 days: research was 99% of the AI bill
-- and answering customers was $0.00. A credit cap stops everything at once,
-- after the money is gone, and cannot say which job spent it.
--
-- NB: the physical table is "workspaces" (@@map), not the model name.
ALTER TABLE "workspaces" ADD COLUMN "aiSpendPolicy" JSONB;
