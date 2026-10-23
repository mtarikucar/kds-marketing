-- Reverts 0005_connectors: drops exactly the indexes, tables, functions and the column it
-- created (the index it put on `capabilities` and the column it put on `budget_items`
-- explicitly, since those tables stay; the other indexes, constraints, policies and triggers go
-- with their tables), dependants of the functions first. A no-op when already reverted.

alter table if exists budget_items drop column if exists retired_at;
drop index if exists capabilities_connected_account_idx;
drop index if exists inbound_events_raw_received_idx;
drop index if exists inbound_events_history_idx;
drop table if exists probe_runs;
drop table if exists oauth_pending;
drop table if exists inbound_events;
drop function if exists probe_runs_immutable();
drop function if exists inbound_events_guard();
