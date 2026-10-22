-- Reverts 0005_connectors: drops exactly the indexes, tables and functions it created (the
-- index it put on `capabilities` explicitly, since that table stays; the other indexes,
-- constraints, policies and triggers go with their tables), dependants of the functions first. A
-- no-op when already reverted.

drop index if exists capabilities_connected_account_idx;
drop index if exists inbound_events_raw_received_idx;
drop table if exists probe_runs;
drop table if exists oauth_pending;
drop table if exists inbound_events;
drop function if exists probe_runs_immutable();
drop function if exists inbound_events_guard();
