-- Reverts 0001_foundation: drops exactly the tables and the function it created (indexes,
-- constraints, policies and the trigger go with their tables). A no-op when already reverted.

drop table if exists platform_sessions;
drop table if exists platform_operators;
drop table if exists ledger_entries;
drop table if exists agent_connections;
drop table if exists api_keys;
drop table if exists memberships;
drop table if exists roles;
drop table if exists sessions;
drop table if exists users;
drop table if exists workspaces;
drop function if exists ledger_entries_immutable();
