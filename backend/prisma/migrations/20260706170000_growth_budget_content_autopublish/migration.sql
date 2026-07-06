-- Content-arm safety gate: FALSE (default) provisions engine content campaigns
-- as SEMI_AUTO ("show before posting" — surfaces in the approval queue, auto-
-- publishes unless rejected in the window), since autonomous public posting
-- cannot be undone by the kill-switch. TRUE = FULL_AUTO, pure never-ask.
ALTER TABLE "growth_budgets" ADD COLUMN "contentAutoPublish" BOOLEAN NOT NULL DEFAULT false;
