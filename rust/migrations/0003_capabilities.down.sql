-- Reverts 0003_capabilities: drops exactly the tables and the function it created (indexes,
-- constraints, policies and the trigger go with their tables), in reverse order, dependants
-- first. A no-op when already reverted.

drop table if exists workspace_policies;
drop table if exists budget_spend_entries;
drop table if exists capability_budget_links;
drop table if exists budget_items;
drop table if exists capability_group_members;
drop table if exists capability_groups;
drop table if exists capabilities;
drop function if exists budget_spend_entries_immutable();
