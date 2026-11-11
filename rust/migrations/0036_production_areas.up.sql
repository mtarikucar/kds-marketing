-- A production area knows when it starts and when its current package was delivered (design
-- 2026-11-10 §6). Both live in the area's document; these columns mirror them for the production
-- line's two lists (open areas by start time, finished ones newest first).

-- A time as an area document holds it: RFC 3339 text, or the 9-element tuple of rows written
-- before Studio wrote text ([year, ordinal, hour, minute, second, nanosecond, offset h, m, s]).
create or replace function production_area_time(v jsonb) returns timestamptz
language sql immutable as $$
    select case when jsonb_typeof(v) = 'array' then
        (make_timestamp((v->>0)::int, 1, 1, (v->>2)::int, (v->>3)::int,
                        (v->>4)::double precision + (v->>5)::double precision / 1000000000)
         + ((v->>1)::int - 1) * interval '1 day'
         - ((v->>6)::int * 3600 + (v->>7)::int * 60 + (v->>8)::int) * interval '1 second') at time zone 'UTC'
    else (v #>> '{}')::timestamptz end
$$;

alter table studio_production_projects add column if not exists start_at timestamptz;
alter table studio_production_projects add column if not exists done_at timestamptz;

-- An area from before starts when it was created and holds no package. The table has FORCE RLS:
-- the backfill runs as the platform, and leaves the setting as it found it.
do $$
declare previous_platform text := coalesce(current_setting('app.platform', true), '');
begin
    perform set_config('app.platform', 'on', true);
    update studio_production_projects set
        start_at = production_area_time(coalesce(nullif(data->'start_at','null'::jsonb), data->'created_at')),
        done_at = case when nullif(data->'redo','null'::jsonb) is null
                        and not jsonb_path_exists(data, '$.requests[*] ? (@.status == "open")')
                       then production_area_time(data->'packages'->-1->'delivered_at') end;
    perform set_config('app.platform', previous_platform, true);
end $$;

alter table studio_production_projects alter column start_at set not null;

-- The start: the area's own, or its creation time when it has none.
alter table studio_production_projects drop constraint if exists production_areas_start_matches;
alter table studio_production_projects add constraint production_areas_start_matches check
    (start_at is not distinct from
     production_area_time(coalesce(nullif(data->'start_at','null'::jsonb), data->'created_at')));

-- Finished: the current package's delivery time, while no redo stands and no requested material
-- is awaited.
alter table studio_production_projects drop constraint if exists production_areas_done_matches;
alter table studio_production_projects add constraint production_areas_done_matches check
    (done_at is not distinct from
     case when nullif(data->'redo','null'::jsonb) is null
           and not jsonb_path_exists(data, '$.requests[*] ? (@.status == "open")')
          then production_area_time(data->'packages'->-1->'delivered_at') end);

create index if not exists production_areas_open
    on studio_production_projects (workspace_id, archived, done_at, start_at);

-- Whether a visual an agent made, bound to no olay, may be the main visual of content that speaks
-- about nothing specific (design 2026-11-10 B39). On unless a workspace turns it off.
alter table studio_material_policy add column if not exists ai_standalone boolean not null default true;
