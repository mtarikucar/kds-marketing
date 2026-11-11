-- Reverts 0018_tiktok_webhooks: narrows inbound_events' provider check back to the providers
-- before TikTok's webhooks. Inbound events are never deleted (the append-only guard of
-- 0005_connectors), so once TikTok events are stored the narrower check cannot hold them: the
-- rollback is then refused, before anything changes, and this migration stays. The table is
-- locked while it is checked, so no TikTok event is stored between the check and the change. A
-- no-op when already reverted.
do $$ declare previous text; has_rows boolean; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    lock table inbound_events in share row exclusive mode;
    select exists(select 1 from inbound_events where provider = 'tiktok') into has_rows;
    if has_rows then
        raise exception 'tiktok webhooks rollback refused: inbound_events holds tiktok events, which are never deleted';
    end if;
    alter table inbound_events drop constraint if exists inbound_events_provider_check;
    alter table inbound_events add constraint inbound_events_provider_check
        check (provider in ('meta', 'netgsm', 'x', 'mail'));
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
