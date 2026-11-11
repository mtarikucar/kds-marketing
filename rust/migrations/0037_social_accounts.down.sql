-- The snapshots are observations, read again from the platforms: the table goes. A person's
-- pause is a choice, and so is leaving posts with a platform's scheduler: the rollback refuses
-- while either stands, rather than let an account post again unasked or forget posts that wait
-- at a platform.
do $$
declare
    previous_platform text := coalesce(current_setting('app.platform', true), '');
    paused boolean := false;
    scheduling boolean := false;
begin
    if exists (select 1 from information_schema.columns
               where table_schema = current_schema() and table_name = 'studio_posting_policy'
                 and column_name = 'paused_capability_ids') then
        perform set_config('app.platform', 'on', true);
        execute 'select exists (select 1 from studio_posting_policy
                                where cardinality(paused_capability_ids) > 0)' into paused;
        if exists (select 1 from information_schema.columns
                   where table_schema = current_schema() and table_name = 'studio_posting_policy'
                     and column_name = 'provider_scheduling') then
            execute 'select exists (select 1 from studio_posting_policy
                                    where provider_scheduling)' into scheduling;
        end if;
        perform set_config('app.platform', previous_platform, true);
        if paused then
            raise exception 'down refused: a workspace paused an account''s posting';
        end if;
        if scheduling then
            raise exception 'down refused: a workspace leaves posts with a platform''s scheduler';
        end if;
    end if;
end $$;
alter table if exists studio_posting_policy drop column if exists provider_scheduling;
alter table if exists studio_posting_policy drop column if exists revision;
alter table if exists studio_posting_policy drop column if exists paused_capability_ids;
drop table if exists social_account_days;
