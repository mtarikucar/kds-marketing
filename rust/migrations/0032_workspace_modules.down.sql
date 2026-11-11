-- Removing a pristine legacy-navigation seed is reversible. User-created blueprints,
-- bindings or installation choices must survive an attempted rollback.
do $$
declare previous_platform text := coalesce(current_setting('app.platform', true), '');
begin
    perform set_config('app.platform', 'on', true);
    if to_regclass('public.workspace_modules') is not null then
        if exists (
            select 1 from workspace_modules
            where data <> '{"legacy":true,"modules":[]}'::jsonb
        ) then
            raise exception 'down refused: workspace module configurations are stored';
        end if;
    end if;
    perform set_config('app.platform', previous_platform, true);
end $$;
drop table if exists workspace_modules;
