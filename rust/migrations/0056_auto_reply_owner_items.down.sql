-- Reverts 0056_auto_reply_owner_items: drops `auto_reply_owner_items`, its index and policy with
-- it. The tasks the rows pointed at stay on their journeys as ordinary tasks, and the
-- conversations the agent kept stay the agent's; the older build reads the stored
-- `keeps_conversations` setting as nothing and hands conversations over as before. Repeatable:
-- every statement is guarded.
drop index if exists auto_reply_owner_items_task;
drop table if exists auto_reply_owner_items;
