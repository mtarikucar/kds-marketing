-- Reverts 0013_probe_reason: drops the reason column, and restores the error-kind check of 0005
-- only when no stored run is `unknown` (the log is append-only, so such a run cannot be removed;
-- the wider check then stays). A no-op when already reverted.
alter table if exists probe_runs drop column if exists reason;
do $$ begin
    if to_regclass('public.probe_runs') is null then return; end if;
    if exists (select 1 from probe_runs where error_kind = 'unknown') then return; end if;
    alter table probe_runs drop constraint if exists probe_runs_error_kind_check;
    alter table probe_runs add constraint probe_runs_error_kind_check
        check (error_kind in ('auth', 'permission', 'throttle', 'transient', 'permanent'));
end $$;
