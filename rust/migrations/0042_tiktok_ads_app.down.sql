-- Pending TikTok for Business flows survive rollback: the widened constraint stays while any
-- remain (they expire within 30 minutes and the purge job deletes them; run this again then).
-- Connected tiktok_ads capabilities are not touched: no constraint names their kind. Re-running
-- this file changes nothing.
do $$ declare previous text; has_rows boolean; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    select exists(
        select 1 from oauth_pending where app = 'tiktok_ads'
    ) into has_rows;
    if not has_rows then
        alter table oauth_pending drop constraint if exists oauth_pending_app_check;
        alter table oauth_pending add constraint oauth_pending_app_check
            check (app in ('meta', 'instagram', 'x', 'tiktok', 'linkedin', 'google'));
    end if;
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
