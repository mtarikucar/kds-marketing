-- Reverts 0021_studio_materials: refuses while the library holds anything of the owner's (olays,
-- materials, the çekim listesi, calendar entries, the policy, a human's caption releases: a re-run
-- of `up` would not bring them back), then drops its tables and functions. A no-op when already
-- reverted.
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    -- Nested: PL/pgSQL plans a condition whole, and the table may be gone already.
    if to_regclass('public.studio_material_releases') is not null then
        if exists (select 1 from studio_material_releases) then
            raise exception '0021_studio_materials down refused: caption releases are stored';
        end if;
    end if;
    if to_regclass('public.studio_materials') is not null then
        if exists (select 1 from studio_materials) then
            raise exception '0021_studio_materials down refused: materials are stored';
        end if;
    end if;
    if to_regclass('public.studio_olays') is not null then
        if exists (select 1 from studio_olays) then
            raise exception '0021_studio_materials down refused: olays are stored';
        end if;
    end if;
    if to_regclass('public.studio_shoot_requests') is not null then
        if exists (select 1 from studio_shoot_requests) then
            raise exception '0021_studio_materials down refused: shoot requests are stored';
        end if;
    end if;
    if to_regclass('public.studio_calendar_entries') is not null then
        if exists (select 1 from studio_calendar_entries) then
            raise exception '0021_studio_materials down refused: calendar entries are stored';
        end if;
    end if;
    if to_regclass('public.studio_material_policy') is not null then
        if exists (select 1 from studio_material_policy) then
            raise exception '0021_studio_materials down refused: a materials policy is stored';
        end if;
    end if;
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
drop table if exists studio_material_releases;
drop table if exists studio_material_policy;
drop table if exists studio_shoot_requests;
drop table if exists studio_calendar_entries;
drop table if exists studio_piece_materials;
drop table if exists studio_materials;
drop table if exists studio_olays;
drop function if exists studio_piece_materials_insert_only();
drop function if exists studio_materials_fixed();
