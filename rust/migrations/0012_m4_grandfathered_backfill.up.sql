-- Stable IDs, explicit ownership and original images. Never alter operational status.
do $$ declare previous text; zone text; begin
    previous := current_setting('app.platform',true);
    zone := current_setting('TimeZone');
    perform set_config('app.platform','on',true);
    perform set_config('TimeZone','UTC',true);
    perform id from workspaces order by id for no key update;
    with inserted as (
        insert into workspace_entitlements(id,workspace_id,source,confirmed_at,activated_at)
        select md5('jeeta:m4:grandfathered:' || w.id::text)::uuid, w.id, 'grandfathered', transaction_timestamp(), transaction_timestamp()
        from workspaces w where w.status='active'
        and not exists (select 1 from workspace_entitlements e where e.workspace_id=w.id and e.revoked_at is null)
        on conflict do nothing returning *
    )
    insert into m4_grandfathered_manifest(entitlement_id,seed_workspace_id,original_row,ledger_watermark)
    select i.id,i.workspace_id,to_jsonb(i),coalesce((select max(l.id) from ledger_entries l where l.workspace_id=i.workspace_id),0)
    from inserted i;
    perform set_config('TimeZone',zone,true);
    perform set_config('app.platform',coalesce(previous,''),true);
end $$;
