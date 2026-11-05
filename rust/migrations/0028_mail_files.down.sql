-- Reverts 0028_mail_files: drops `mail_files`, its indexes and policy with it. Its rows go: the
-- files they describe stay in the file store, where an older build's daily sweep of files no
-- record keeps (`studio_files_cleanup`) deletes them a day later, and a quote's `mail_file:<id>`
-- reference is left pointing nowhere. One thing is refused, before anything changes: while an
-- outbox entry still waiting to be sent (queued or held) names mail files in its email, since an
-- older build would send that email without them. Send or refuse those entries first. The outbox
-- is locked while it is checked. A no-op when already reverted.
do $$ declare previous text; waiting boolean; begin
    if to_regclass('mail_files') is null then
        return;
    end if;
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    lock table outbox in share row exclusive mode;
    select exists(select 1 from outbox where state in ('queued', 'held')
                  and jsonb_typeof(intent #> '{mail,attachment_files}') = 'array'
                  and jsonb_array_length(intent #> '{mail,attachment_files}') > 0)
        into waiting;
    if waiting then
        raise exception 'mail files rollback refused: an outbox entry waiting to be sent names mail files that an older build would not attach';
    end if;
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
drop table if exists mail_files;
