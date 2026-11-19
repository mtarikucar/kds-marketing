-- Reverts 0045_agent_wake. The table holds only what this release derives (an agent's learned
-- check-ins, its outbox) and a wake address a person set; the code before has no use for any of
-- it, so dropping it loses nothing that release could read. A wake address set here must be set
-- again after a later upgrade (its token is shown once in claude.ai: a new one is generated).
-- Repeatable: every statement is guarded.
drop index if exists agent_wakes_due;
drop table if exists agent_wakes;
