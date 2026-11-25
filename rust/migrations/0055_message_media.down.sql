-- Reverts 0055_message_media: drops `message_media`, its indexes and policy with it. Its rows go:
-- the files they describe stay in the file store, where the older build's daily sweep of files
-- no record keeps (`studio_files_cleanup`) deletes them a day later, so no customer file outlives
-- the revert by more than that. The messages keep their text markers (`[image]`, `[document…]`),
-- as the older build shows them. One thing is refused, before anything changes: while an outbox
-- entry still waiting to be sent (queued or held) carries an image (`intent.media`), since an
-- older build would send its caption without it. Send or refuse those entries first. The outbox
-- is locked while it is checked. Repeatable: a no-op when already reverted.
do $$ declare previous text; waiting boolean; begin
    if to_regclass('message_media') is null then
        return;
    end if;
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    lock table outbox in share row exclusive mode;
    select exists(select 1 from outbox where state in ('queued', 'held')
                  and jsonb_typeof(intent -> 'media') = 'object')
        into waiting;
    if waiting then
        raise exception 'message media rollback refused: an outbox entry waiting to be sent carries an image that an older build would not send';
    end if;
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
drop index if exists message_media_file;
drop index if exists message_media_stored;
drop index if exists message_media_pending;
drop index if exists message_media_message;
drop table if exists message_media;
