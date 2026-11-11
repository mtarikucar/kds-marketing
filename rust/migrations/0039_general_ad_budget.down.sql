-- The general ad budget's mark and the spend's module go: the items and the spend entries stay
-- as they were before 0039. Running it again changes nothing.
alter table if exists budget_spend_entries drop column if exists campaign_id;
alter table if exists budget_spend_entries drop column if exists module;
drop index if exists budget_items_one_general;
alter table if exists budget_items drop constraint if exists budget_items_general_rule;
alter table if exists budget_items drop column if exists general;
