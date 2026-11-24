-- A composed material (a slide or story `studio.post_render` drew, `data ? 'composition'`) is
-- created analysed: its tags, people, depicts and permission are its analysed sources'. Before
-- this release a composed material was left without an analysis record, which the work list reads
-- as pending, so agents were asked to analyse the server's own images. This marks every live
-- composed material's analysis complete (keeping its fields as its own) and ends any lease on it.
-- Uploads (no `composition`) are untouched. Repeatable: a completed composed record is rewritten
-- with the same content.
select set_config('app.platform', 'on', true);
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
on conflict (workspace_id, material_id) do update set data = excluded.data;
