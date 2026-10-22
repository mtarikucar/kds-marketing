-- Reverts 0005_connectors: drops exactly the tables and the functions it created (indexes,
-- constraints, policies and triggers go with their tables), dependants of the functions first. A
-- no-op when already reverted.

drop table if exists probe_runs;
drop table if exists oauth_pending;
drop table if exists inbound_events;
drop function if exists probe_runs_immutable();
drop function if exists inbound_events_guard();
