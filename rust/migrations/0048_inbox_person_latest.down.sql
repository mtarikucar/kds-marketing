-- Reverts 0048_inbox_person_latest: the index only, no data. The release before reads the same
-- rows without it. Repeatable.
drop index if exists messages_person_latest;
