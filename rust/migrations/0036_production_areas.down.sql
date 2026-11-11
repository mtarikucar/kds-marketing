-- Refuses rather than lose what was produced or chosen: packages, claims, redo notes and held
-- deliveries live only in the area documents (the code before this migration drops them on its
-- next save), and a workspace that turned the standalone visual setting off would find it on
-- again after the next up.
do $$
declare
    previous_platform text := coalesce(current_setting('app.platform', true), '');
    turned_off boolean := false;
begin
    if to_regclass('public.studio_production_projects') is null then return; end if;
    perform set_config('app.platform', 'on', true);
    if exists (select 1 from studio_production_projects where
        coalesce(jsonb_array_length(data->'packages'),0) > 0
        or nullif(data->'claim','null'::jsonb) is not null
        or nullif(data->'redo','null'::jsonb) is not null
        or nullif(data->'refusal','null'::jsonb) is not null) then
        raise exception 'down refused: production areas hold packages, claims, redo requests or held deliveries';
    end if;
    if exists (select 1 from information_schema.columns
               where table_schema = current_schema() and table_name = 'studio_material_policy'
                 and column_name = 'ai_standalone') then
        execute 'select exists (select 1 from studio_material_policy where not ai_standalone)'
            into turned_off;
        if turned_off then
            raise exception 'down refused: a workspace turned the standalone visual setting off';
        end if;
    end if;
    perform set_config('app.platform', previous_platform, true);
end $$;
drop index if exists production_areas_open;
alter table if exists studio_production_projects drop column if exists done_at;
alter table if exists studio_production_projects drop column if exists start_at;
drop function if exists production_area_time(jsonb);
alter table if exists studio_material_policy drop column if exists ai_standalone;
