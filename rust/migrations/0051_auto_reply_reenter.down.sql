-- Reverts 0051_auto_reply_reenter: the four columns only. The release before neither reads nor
-- writes them. Repeatable.
alter table if exists auto_reply_queue drop column if exists told_reason;
alter table if exists auto_reply_queue drop column if exists told_at;
alter table if exists auto_reply_queue drop column if exists auto_handed_at;
alter table if exists auto_reply_queue drop column if exists auto_handed_generation;
