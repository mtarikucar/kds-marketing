-- Migration-only inspection must see every tenant despite forced RLS.
do $$
declare previous_platform text := coalesce(current_setting('app.platform', true), '');
begin
    perform set_config('app.platform', 'on', true);
    if to_regclass('public.studio_package_requests') is not null then
        if exists(select 1 from studio_package_requests where trigger='project') then
            raise exception 'down refused: project publication requests are stored';
        end if;
    end if;
    if to_regclass('public.studio_production_projects') is not null then
        if exists (select 1 from studio_production_projects) then
            raise exception 'down refused: production projects are stored';
        end if;
    end if;
    perform set_config('app.platform', previous_platform, true);
end $$;
drop table if exists studio_production_projects;
alter table studio_package_requests drop constraint if exists studio_package_requests_trigger_check;
alter table studio_package_requests add constraint studio_package_requests_trigger_check check (trigger in ('olay','calendar','floor'));
