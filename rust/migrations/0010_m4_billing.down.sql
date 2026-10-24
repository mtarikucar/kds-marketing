-- Refuse destructive rollback before any schema change. Locks also fence concurrent writers.
do $$ declare t text; has_rows boolean; previous text; begin
    previous := current_setting('app.platform',true);
    perform set_config('app.platform','on',true);
    if to_regclass('public.m4_grandfathered_manifest') is not null then
        lock table m4_grandfathered_manifest in access exclusive mode;
        select exists(select 1 from m4_grandfathered_manifest) into has_rows;
        if has_rows then raise exception 'billing rollback refused: live rows in m4_grandfathered_manifest'; end if;
    end if;
    if to_regclass('public.workspace_billing') is not null then
        lock table workspace_billing in access exclusive mode;
        select exists(select 1 from workspace_billing) into has_rows;
        if has_rows then raise exception 'billing rollback refused: live rows in workspace_billing'; end if;
    end if;
    if to_regclass('public.workspace_entitlements') is not null then
        lock table workspace_entitlements in access exclusive mode;
        select exists(select 1 from workspace_entitlements) into has_rows;
        if has_rows then raise exception 'billing rollback refused: live rows in workspace_entitlements'; end if;
    end if;
    if to_regclass('public.payment_notifications') is not null then
        lock table payment_notifications in access exclusive mode;
        select exists(select 1 from payment_notifications) into has_rows;
        if has_rows then raise exception 'billing rollback refused: live rows in payment_notifications'; end if;
    end if;
    perform set_config('app.platform',coalesce(previous,''),true);
end $$;
drop table if exists m4_grandfathered_manifest;
drop table if exists workspace_billing;
drop table if exists workspace_entitlements;
drop table if exists payment_notifications;
