-- Reverts 0044_content_olay_root. Refuses rather than lose what only this release can read or
-- what a person decided: an unfiled material (the code before cannot read its binding), an area a
-- person opened under an olay, and the step history an agent reported (both live only in the
-- area documents, and the code before drops them on its next save). The olay the backfill wrote
-- into a system area is the one its stored request names, so it is no loss and does not refuse.
-- Repeatable: every statement is guarded.
do $$
declare
    previous_platform text := coalesce(current_setting('app.platform', true), '');
    blocked boolean := false;
begin
    perform set_config('app.platform', 'on', true);
    if to_regclass('public.studio_materials') is not null then
        execute 'select exists (select 1 from studio_materials where binding = ''unfiled'')'
            into blocked;
        if blocked then
            raise exception 'down refused: unfiled materials wait in the analysis queue';
        end if;
    end if;
    if to_regclass('public.studio_production_projects') is not null then
        execute $q$select exists (select 1 from studio_production_projects where
            (nullif(data->'olay_id', 'null'::jsonb) is not null
             and data->'opened_by'->>'kind' is distinct from 'system')
            or coalesce(jsonb_array_length(nullif(data->'steps', 'null'::jsonb)), 0) > 0
            or jsonb_path_exists(data, '$.packages[*].steps[*]'))$q$
            into blocked;
        if blocked then
            raise exception 'down refused: production areas hold a person''s olay or reported steps';
        end if;
    end if;
    perform set_config('app.platform', previous_platform, true);
end $$;
drop index if exists production_areas_olay;
alter table if exists studio_production_projects drop column if exists olay_id;
alter table if exists studio_materials drop constraint if exists studio_materials_binding_check;
do $$ begin
    if to_regclass('public.studio_materials') is not null then
        alter table studio_materials add constraint studio_materials_binding_check
            check (binding in ('olay', 'genel'));
    end if;
end $$;
