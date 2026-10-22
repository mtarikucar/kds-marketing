-- Reverts 0002_strategy: drops exactly the tables and the function it created (indexes,
-- constraints, policies and the trigger go with their tables), dependants first. A no-op when
-- already reverted.

drop table if exists consultation_entries;
drop table if exists strategy_hypotheses;
drop table if exists strategy_versions;
drop function if exists consultation_entries_immutable();
