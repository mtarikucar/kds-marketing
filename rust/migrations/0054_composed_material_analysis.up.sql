-- A composed material (a slide or story `studio.post_render` drew, `data ? 'composition'`) is
-- created analysed: its tags, people, depicts and permission are its analysed sources'. Before
-- this release a composed material was left without an analysis record, which the work list reads
-- as pending, so agents were asked to analyse the server's own images. This marks a live composed
-- material's analysis complete (keeping its fields as its own, ending any lease) only when every
-- material behind it (its sources, and theirs for a composed source) has a completed analysis.
-- The others keep their record as it is: they are not analysis work (the server never lists a
-- composed material), they cannot be drawn into a new render while anything behind them is not
-- analysed, and the analysis completion of their last unanalysed source completes them. Uploads
-- (no `composition`) are untouched. Repeatable.
select set_config('app.platform', 'on', true);
with recursive behind (workspace_id, composite_id, material_id, depth) as (
    select m.workspace_id, m.id, (s.value #>> '{}')::uuid, 1
    from studio_materials m
    cross join lateral jsonb_array_elements(m.data->'composition'->'sources') s
    where m.data ? 'composition' and m.erased_at is null
    union
    select b.workspace_id, b.composite_id, (s.value #>> '{}')::uuid, b.depth + 1
    from behind b
    join studio_materials src on src.workspace_id = b.workspace_id and src.id = b.material_id
    cross join lateral jsonb_array_elements(src.data->'composition'->'sources') s
    where src.data ? 'composition' and b.depth < 32
),
blocked (workspace_id, composite_id) as (
    select distinct b.workspace_id, b.composite_id
    from behind b
    left join studio_materials src on src.workspace_id = b.workspace_id and src.id = b.material_id
    left join studio_material_intelligence i
        on i.workspace_id = b.workspace_id and i.material_id = b.material_id
    where src.id is null
       or src.erased_at is not null
       or (not (src.data ? 'composition')
           and coalesce(i.data->'intelligence'->>'status', 'pending') <> 'completed')
)
insert into studio_material_intelligence (workspace_id, material_id, data)
select m.workspace_id, m.id, jsonb_build_object(
    'material_id', m.id,
    'lease', null,
    'intelligence', jsonb_build_object(
        'status', 'completed',
        'manual_fields', jsonb_build_array('title', 'labels', 'quality', 'captured_at',
                                           'description', 'group_name'),
        'description', coalesce(i.data->'intelligence'->>'description', ''),
        'group_name', i.data->'intelligence'->'group_name',
        'date_source', 'unknown',
        'attempts', coalesce((i.data->'intelligence'->>'attempts')::bigint, 0),
        'analyzed_revision', m.revision,
        'last_error_code', null,
        'analyzed_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'updated_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
from studio_materials m
left join studio_material_intelligence i
    on i.workspace_id = m.workspace_id and i.material_id = m.id
where m.data ? 'composition'
  and m.erased_at is null
  and not exists (
      select 1 from blocked x where x.workspace_id = m.workspace_id and x.composite_id = m.id)
on conflict (workspace_id, material_id) do update set data = excluded.data;
