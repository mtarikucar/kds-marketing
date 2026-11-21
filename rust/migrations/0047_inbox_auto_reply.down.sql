-- Reverts 0047_inbox_auto_reply. The queue holds only work this release derives, and the runs
-- only codes and numbers; the code before has no use for either, so dropping them loses nothing
-- that release could read. The owner's setting goes with its column: after a later upgrade the
-- automatic replies are off until the owner turns them on again. Repeatable: every statement is
-- guarded.
drop index if exists auto_reply_runs_conversation;
drop index if exists auto_reply_runs_at;
drop table if exists auto_reply_runs;
drop index if exists auto_reply_queue_lease;
drop index if exists auto_reply_queue_due;
drop table if exists auto_reply_queue;
alter table if exists knowledge_settings drop column if exists auto_reply;
