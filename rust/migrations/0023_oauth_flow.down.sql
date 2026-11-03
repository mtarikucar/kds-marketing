-- Reverts 0023_oauth_flow: the pending flows of a sign-in variant are deleted (a pending flow
-- lives half an hour; completed without its variant it would sign in another way than it
-- started), then the column goes. A no-op when already reverted.
do $$ declare previous text; begin
    if to_regclass('public.oauth_pending') is null then return; end if;
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'oauth_pending'
                     and column_name = 'flow') then
        return;
    end if;
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    delete from oauth_pending where flow is not null;
    alter table oauth_pending drop constraint if exists oauth_pending_flow_check;
    alter table oauth_pending drop column if exists flow;
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
