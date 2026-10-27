-- Pending TikTok or LinkedIn flows survive rollback: the widened constraints stay while any
-- remain (they expire within 30 minutes and the purge job deletes them; run this again then).
-- Re-running this file changes nothing.
do $$ declare previous text; has_rows boolean; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    select exists(
        select 1 from oauth_pending
        where provider in ('tiktok', 'linkedin') or app in ('tiktok', 'linkedin')
    ) into has_rows;
    if not has_rows then
        alter table oauth_pending drop constraint if exists oauth_pending_provider_check;
        alter table oauth_pending add constraint oauth_pending_provider_check
            check (provider in ('meta', 'netgsm', 'x'));
        alter table oauth_pending drop constraint if exists oauth_pending_app_check;
        alter table oauth_pending add constraint oauth_pending_app_check
            check (app in ('meta', 'instagram', 'x'));
    end if;
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
