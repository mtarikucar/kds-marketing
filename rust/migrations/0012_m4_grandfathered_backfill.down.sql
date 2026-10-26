-- Retain touched grants AND their manifest entries. Later workspace history conservatively
-- protects the grant even when it does not name it (notably suspend/resume ledger entries).
do $$ declare previous text; zone text; begin
    if to_regclass('public.m4_grandfathered_manifest') is null then return; end if;
    previous := current_setting('app.platform',true);
    zone := current_setting('TimeZone');
    perform set_config('app.platform','on',true);
    perform set_config('TimeZone','UTC',true);
    perform id from workspaces order by id for no key update;
    lock table workspace_entitlements, activation_codes, ledger_entries, m4_grandfathered_manifest in share row exclusive mode;
    with removed as (
        delete from workspace_entitlements e using m4_grandfathered_manifest m
        where e.id=m.entitlement_id and e.workspace_id=m.seed_workspace_id and to_jsonb(e)=m.original_row
        and not exists (select 1 from activation_codes c where c.workspace_id=e.workspace_id and c.entitlement_id=e.id)
        and not exists (select 1 from workspace_entitlements other where other.workspace_id=e.workspace_id and other.id<>e.id)
        and not exists (select 1 from ledger_entries l where l.workspace_id=e.workspace_id and l.id>m.ledger_watermark)
        returning e.id
    ) delete from m4_grandfathered_manifest m using removed r where m.entitlement_id=r.id;
    perform set_config('TimeZone',zone,true);
    perform set_config('app.platform',coalesce(previous,''),true);
end $$;
