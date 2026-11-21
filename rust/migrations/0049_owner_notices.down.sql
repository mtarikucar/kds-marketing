-- Reverts 0049_owner_notices. The table holds only codes and ids of notices already sent or
-- skipped; the release before has no use for it, so dropping it loses nothing that release could
-- read. Repeatable: every statement is guarded.
drop index if exists owner_notices_queued;
drop index if exists owner_notices_created;
drop table if exists owner_notices;
