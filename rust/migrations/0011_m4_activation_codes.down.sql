-- Refuse destructive rollback before any schema change. Locks also fence concurrent writers.
do $$ declare t text; has_rows boolean; previous text; begin
    previous := current_setting('app.platform',true);
    perform set_config('app.platform','on',true);
    if to_regclass('public.activation_codes') is not null then
        lock table activation_codes in access exclusive mode;
        select exists(select 1 from activation_codes) into has_rows;
        if has_rows then raise exception 'billing rollback refused: live rows in activation_codes'; end if;
    end if;
    perform set_config('app.platform',coalesce(previous,''),true);
end $$;
drop table if exists activation_codes;
