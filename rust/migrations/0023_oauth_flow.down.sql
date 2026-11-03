-- Reverts 0023_oauth_flow: the pending flows of a sign-in variant are deleted (a pending flow
-- lives half an hour; completed without its variant it would sign in another way than it
-- started), then the column goes. This migration is the WhatsApp Business app coexistence's
-- (spec 2026-11-03-whatsapp-coexistence-design.md), and the code before it cannot read what that
-- feature leaves: a message the business wrote from the app (`author` `"business_app"`) or a
-- capability's sharing of the app's data (`connector_public.business_app`). Once either is
-- stored the rollback is refused, before anything changes, and this migration stays; the tables
-- are locked while they are checked. A no-op when already reverted.
do $$ declare previous text; has_rows boolean; begin
    if to_regclass('public.oauth_pending') is null then return; end if;
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'oauth_pending'
                     and column_name = 'flow') then
        return;
    end if;
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    lock table messages, capabilities in share row exclusive mode;
    select exists(select 1 from messages where author = '"business_app"'::jsonb)
        or exists(select 1 from capabilities where connector_public ? 'business_app')
        into has_rows;
    if has_rows then
        raise exception 'oauth flow rollback refused: messages written from the WhatsApp Business app, or capabilities sharing its data, are stored, which the older code cannot read';
    end if;
    delete from oauth_pending where flow is not null;
    alter table oauth_pending drop constraint if exists oauth_pending_flow_check;
    alter table oauth_pending drop column if exists flow;
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
