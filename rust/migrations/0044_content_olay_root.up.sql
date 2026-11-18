-- One module with the olay at its root (design 2026-11-18-icerik-olay-koku-design.md): a person
-- may drop a file with no olay, and an area knows the olay its content is about. Additive: no
-- row is deleted, no column dropped, no value of an existing row rewritten but the backfill of an
-- area's olay below. Repeatable: every statement is guarded.

-- 1. An unfiled material (§3): a person's upload that waits in the analysis queue until it is
--    filed into an olay or genel. It names no olay, as genel does; it needs no human's freeing,
--    since nothing may use it. `studio_materials_binding_rule` and `studio_materials_genel_rule`
--    of 0021 hold unchanged.
alter table studio_materials drop constraint if exists studio_materials_binding_check;
alter table studio_materials add constraint studio_materials_binding_check
    check (binding in ('olay', 'genel', 'unfiled'));

-- 2. An area's olay (§2), kept in its document (`olay_id`, absent or null: no olay, shown under
--    "Genel") and generated from it here for the lists' filter, so the column can never disagree
--    with the document. No foreign key: olays are never deleted, the use cases check the olay
--    exists, and the library's migrations (0021, 0022) stay revertible on their own.
alter table studio_production_projects add column if not exists olay_id uuid
    generated always as (nullif(data->>'olay_id', '')::uuid) stored;

-- The areas the system opened for an olay or a calendar occasion before this migration: their
-- olay is the one the stored request of the same key names (0022's `studio_package_requests`,
-- whose key is the area's trigger key, design 2026-11-10 §6.3). A floor area, an area a person
-- opened and an area whose request names no olay keep none. The table has FORCE RLS: the
-- backfill runs as the platform, and leaves the setting as it found it. Revisions are not moved:
-- the olay was the area's from its start, only not written down.
do $$
declare previous_platform text := coalesce(current_setting('app.platform', true), '');
begin
    if to_regclass('public.studio_package_requests') is null
       or to_regclass('public.studio_olays') is null then
        return;
    end if;
    perform set_config('app.platform', 'on', true);
    update studio_production_projects p
       set data = jsonb_set(p.data, '{olay_id}', to_jsonb(q.olay_id))
      from (select r.workspace_id, r.key, (r.data->>'olay_id')::uuid as olay_id
              from studio_package_requests r
             where r.trigger in ('olay', 'calendar')
               and nullif(r.data->>'olay_id', '') is not null) q
     where q.workspace_id = p.workspace_id
       and q.key = p.data->'opened_by'->>'key'
       and p.data->'opened_by'->>'kind' = 'system'
       and p.data->'opened_by'->>'trigger' in ('olay', 'calendar')
       and nullif(p.data->'olay_id', 'null'::jsonb) is null
       and exists (select 1 from studio_olays o
                    where o.workspace_id = q.workspace_id and o.id = q.olay_id);
    perform set_config('app.platform', previous_platform, true);
end $$;

create index if not exists production_areas_olay
    on studio_production_projects (workspace_id, olay_id, archived);
